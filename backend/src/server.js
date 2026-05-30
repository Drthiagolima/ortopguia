import express from "express";
import cors from "cors";
import http from "http";
import dotenv from "dotenv";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
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

// CORS - apenas origens permitidas
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

const PORT = process.env.PORT || 8787;
const server = http.createServer(app);

// WebSocket de transcrição ao vivo
attachTranscriptionWS(server, "/ws/transcribe");

server.listen(PORT, () => {
  console.log(`[OrtoguIA] Backend de agentes rodando em http://localhost:${PORT}`);
  console.log(`[OrtoguIA] WebSocket de transcrição em ws://localhost:${PORT}/ws/transcribe`);
  console.log(`[OrtoguIA] Agentes:`, listAgents().map((a) => a.id).join(", "));
});
