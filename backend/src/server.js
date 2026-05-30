import express from "express";
import cors from "cors";
import http from "http";
import dotenv from "dotenv";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
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
      docType: String(body.docType || "").trim() || "documento",
      title: String(body.title || "Documento").trim() || "Documento",
      content: String(body.content || "").trim(),
      metadata: body.metadata && typeof body.metadata === "object" ? body.metadata : {},
    };
    repo.documents.push(item);
    await writeRepository(repo);
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
    res.json({ ok: true, data: { patientId, documents } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || "Erro ao ler repositório" });
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
