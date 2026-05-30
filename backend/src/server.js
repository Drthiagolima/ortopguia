import express from "express";
import cors from "cors";
import http from "http";
import dotenv from "dotenv";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import jwt from "jsonwebtoken";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { runAgent, listAgents } from "./agents/agents.js";
import { attachTranscriptionWS } from "./agents/transcribe.js";

dotenv.config();

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  })
);

app.use(express.json({ limit: "2mb" }));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Muitas requisições. Tente novamente em instantes." },
});

const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Limite temporário de uso excedido." },
});

app.use("/api", apiLimiter);
app.use("/api/anamnese", aiLimiter);
app.use("/api/agents", aiLimiter);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_DIR = path.join(__dirname, "..", "data");
const REPO_FILE = path.join(REPO_DIR, "patient-repository.json");
const REPO_AUDIT_FILE = path.join(REPO_DIR, "patient-repository-audit.log");
const REPOSITORY_API_TOKEN = String(process.env.REPOSITORY_API_TOKEN || "").trim();
const JWT_SECRET = String(process.env.JWT_SECRET || "").trim();
const JWT_EXPIRES_IN = String(process.env.JWT_EXPIRES_IN || "8h").trim() || "8h";

const defaultUsers = [
  { id: "med_thiago_lima", email: "thiagolima@ortopguia.com.br", role: "medico", name: "Thiago Lima" },
  { id: "med_tiago_careno", email: "tiagocareno@ortopguia.com.br", role: "medico", name: "Tiago Careno" },
  { id: "med_ortoguia_alias", email: "thiagolima@ortoguia.com.br", role: "medico", name: "Thiago Lima" },
  { id: "med_ortoguia_alias2", email: "tiagocareno@ortoguia.com.br", role: "medico", name: "Tiago Careno" },
  { id: "sec_mariana", email: "sec.mariana@ortopguia.com.br", role: "secretaria", name: "Mariana" },
];

let authUsers = defaultUsers;
try {
  const parsed = JSON.parse(String(process.env.AUTH_USERS_JSON || "[]"));
  if (Array.isArray(parsed) && parsed.length) {
    authUsers = parsed
      .filter((u) => u && u.email && u.role)
      .map((u, i) => ({
        id: String(u.id || `user_${i + 1}`),
        email: String(u.email).trim().toLowerCase(),
        role: String(u.role).trim().toLowerCase(),
        name: String(u.name || u.email).trim(),
      }));
  }
} catch {
  authUsers = defaultUsers;
}

const allowedPasswords = String(
  process.env.AUTH_DEFAULT_PASSWORDS || "ortopguiapadrao,ortoguiapadrao,padrao,senhapadrao"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

async function readRepository() {
  try {
    const raw = await fs.readFile(REPO_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { documents: [] };
    if (!Array.isArray(parsed.documents)) parsed.documents = [];
    return parsed;
  } catch (err) {
    if (err && err.code === "ENOENT") return { documents: [] };
    throw err;
  }
}

async function writeRepository(repo) {
  await fs.mkdir(REPO_DIR, { recursive: true });
  await fs.writeFile(REPO_FILE, JSON.stringify(repo, null, 2), "utf8");
}

function parseBearerToken(req) {
  const raw = String(req.headers.authorization || "");
  return raw.startsWith("Bearer ") ? raw.slice(7).trim() : "";
}

function signAccessToken(user) {
  if (!JWT_SECRET) {
    throw new Error("JWT_SECRET não configurado");
  }
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      role: user.role,
      name: user.name,
    },
    JWT_SECRET,
    {
      expiresIn: JWT_EXPIRES_IN,
      issuer: "ortoguia-backend",
      audience: "ortoguia-app",
    }
  );
}

function resolveActor(req) {
  if (req.authUser && req.authUser.id) {
    return { id: String(req.authUser.id), role: String(req.authUser.role || "unknown") };
  }
  const actorId = String(req.headers["x-user-id"] || req.headers["x-doctor-id"] || "anonymous").trim();
  const actorRole = String(req.headers["x-user-role"] || "unknown").trim();
  return { id: actorId || "anonymous", role: actorRole || "unknown" };
}

async function appendRepositoryAudit(event) {
  await fs.mkdir(REPO_DIR, { recursive: true });
  const line = JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n";
  await fs.appendFile(REPO_AUDIT_FILE, line, "utf8");
}

function authorizeRepository(req, res, next) {
  const token = parseBearerToken(req);

  if (JWT_SECRET && token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET, {
        issuer: "ortoguia-backend",
        audience: "ortoguia-app",
      });
      req.authUser = {
        id: String(payload.sub || payload.email || "user"),
        email: String(payload.email || ""),
        role: String(payload.role || "unknown"),
        name: String(payload.name || payload.email || "Usuário"),
      };
      return next();
    } catch {
      // fallback para token legado abaixo
    }
  }

  if (REPOSITORY_API_TOKEN && token === REPOSITORY_API_TOKEN) {
    req.authUser = {
      id: "legacy_repository_token",
      email: "",
      role: "system",
      name: "Legacy Token",
    };
    return next();
  }

  return res.status(401).json({ ok: false, error: "Não autorizado para repositório" });
}

// CORS — apenas origens permitidas
const allowed = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, cb) {
      // permite ferramentas locais (sem origin) e origens da lista
      if (!origin || allowed.length === 0 || allowed.includes(origin)) return cb(null, true);
      return cb(new Error("Origem não permitida pelo CORS: " + origin));
    },
  })
);

// Saúde do serviço
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "ortoguia-backend", agents: listAgents() });
});

// Lista de agentes disponíveis
app.get("/api/agents", (_req, res) => {
  res.json({ ok: true, agents: listAgents() });
});

/**
 * Login (JWT)
 * POST /api/auth/login
 * body: { email, password, lgpdAccepted }
 */
app.post("/api/auth/login", (req, res) => {
  try {
    if (!JWT_SECRET) {
      return res.status(503).json({ ok: false, error: "Autenticação indisponível (JWT_SECRET ausente)" });
    }

    const body = req.body || {};
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const lgpdAccepted = !!body.lgpdAccepted;

    if (!email || !password) {
      return res.status(400).json({ ok: false, error: "email e password são obrigatórios" });
    }
    if (!lgpdAccepted) {
      return res.status(400).json({ ok: false, error: "Aceite LGPD é obrigatório" });
    }

    const user = authUsers.find((u) => u.email === email);
    if (!user || !allowedPasswords.includes(password)) {
      return res.status(401).json({ ok: false, error: "Credenciais inválidas" });
    }

    const token = signAccessToken(user);
    return res.json({
      ok: true,
      data: {
        accessToken: token,
        tokenType: "Bearer",
        expiresIn: JWT_EXPIRES_IN,
        user: {
          id: user.id,
          email: user.email,
          role: user.role,
          name: user.name,
        },
      },
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || "Erro de autenticação" });
  }
});

/**
 * Executa um agente de texto.
 * POST /api/agents/:id
 * body: { paciente, transcricao, anamnese, instrucoes }
 *   - anamnese: {id} 'anamnese' devolve JSON estruturado
 *   - demais agentes devolvem { text }
 */
app.post("/api/agents/:id", async (req, res) => {
  try {
    const result = await runAgent(req.params.id, req.body || {});
    res.json(result);
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ ok: false, error: err.message || "Erro ao executar agente" });
  }
});

/**
 * Atalho dedicado: transcrição -> anamnese estruturada.
 * POST /api/anamnese  body: { paciente, transcricao }
 */
app.post("/api/anamnese", async (req, res) => {
  try {
    const result = await runAgent("anamnese", req.body || {});
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

/**
 * Estrutura de teleconsulta via WhatsApp.
 * POST /api/teleconsulta/whatsapp-link
 * body: { paciente, telefone, agendaAt }
 */
app.post("/api/teleconsulta/whatsapp-link", (req, res) => {
  const body = req.body || {};
  const paciente = body.paciente || "Paciente";
  const telefone = String(body.telefone || "5511999999999").replace(/\D/g, "") || "5511999999999";
  const agendaAt = body.agendaAt || "a confirmar";

  const roomId = "TELE-" + Date.now().toString(36).toUpperCase();
  const frontBase = (process.env.FRONTEND_BASE_URL || "https://ortopguia.com.br").replace(/\/$/, "");
  const joinUrl = `${frontBase}/app.html?tab=teleconsulta&sala=${encodeURIComponent(roomId)}`;
  const message = [
    "ORTOPGUIA Teleconsulta",
    `Paciente: ${paciente}`,
    `Horario: ${agendaAt}`,
    `Sala: ${roomId}`,
    `Entrar: ${joinUrl}`,
  ].join("\n");

  const whatsappUrl = `https://wa.me/${telefone}?text=${encodeURIComponent(message)}`;

  res.json({
    ok: true,
    data: {
      roomId,
      joinUrl,
      whatsappUrl,
      message,
    },
  });
});

app.use("/api/repository", authorizeRepository);

/**
 * Repositorio em nuvem do prontuario do paciente.
 * POST /api/repository/documents
 */
app.post("/api/repository/documents", async (req, res) => {
  try {
    const body = req.body || {};
    const patientId = String(body.patientId || "").trim();
    if (!patientId) {
      return res.status(400).json({ ok: false, error: "patientId é obrigatório" });
    }
    const repo = await readRepository();
    const item = {
      id: "doc_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      createdAt: new Date().toISOString(),
      patientId,
      patientName: String(body.patientName || "Paciente").trim() || "Paciente",
      mode: String(body.mode || "").trim(),
      docType: String(body.docType || body.documentType || "").trim() || "documento",
      title: String(body.title || "Documento").trim() || "Documento",
      content: String(body.content || "").trim(),
      metadata: body.metadata && typeof body.metadata === "object" ? body.metadata : {},
    };
    repo.documents.push(item);
    await writeRepository(repo);
    await appendRepositoryAudit({
      action: "DOCUMENT_CREATED",
      actor: resolveActor(req),
      patientId,
      documentId: item.id,
      mode: item.mode || null,
      docType: item.docType,
    });
    res.json({ ok: true, data: item });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || "Erro ao salvar repositório" });
  }
});

/**
 * GET /api/repository/patient/:patientId
 */
app.get("/api/repository/patient/:patientId", async (req, res) => {
  try {
    const patientId = String(req.params.patientId || "").trim();
    const repo = await readRepository();
    const documents = repo.documents
      .filter((d) => String(d.patientId) === patientId)
      .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
    await appendRepositoryAudit({
      action: "DOCUMENT_LIST_VIEWED",
      actor: resolveActor(req),
      patientId,
      totalReturned: documents.length,
    });
    res.json({ ok: true, data: { patientId, documents } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || "Erro ao ler repositório" });
  }
});

/**
 * DELETE /api/repository/patient/:patientId/documents/:docId
 */
app.delete("/api/repository/patient/:patientId/documents/:docId", async (req, res) => {
  try {
    const patientId = String(req.params.patientId || "").trim();
    const docId = String(req.params.docId || "").trim();
    if (!patientId || !docId) {
      return res.status(400).json({ ok: false, error: "patientId e docId são obrigatórios" });
    }

    const repo = await readRepository();
    const index = repo.documents.findIndex(
      (d) => String(d.patientId) === patientId && String(d.id) === docId
    );

    if (index < 0) {
      return res.status(404).json({ ok: false, error: "Documento não encontrado" });
    }

    const [removed] = repo.documents.splice(index, 1);
    await writeRepository(repo);
    await appendRepositoryAudit({
      action: "DOCUMENT_DELETED",
      actor: resolveActor(req),
      patientId,
      documentId: removed.id,
      docType: removed.docType || null,
    });

    return res.json({ ok: true, data: { patientId, documentId: removed.id } });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || "Erro ao excluir documento" });
  }
});

const PORT = process.env.PORT || 8787;
const server = http.createServer(app);

// WebSocket de transcrição ao vivo
attachTranscriptionWS(server, "/ws/transcribe");

server.listen(PORT, () => {
  console.log(`[OrtoguIA] Backend de agentes rodando em http://localhost:${PORT}`);
  console.log(`[OrtoguIA] WebSocket de transcrição em ws://localhost:${PORT}/ws/transcribe`);
  console.log(`[OrtoguIA] Agentes:`, listAgents().map((a) => a.id).join(", "));
});
