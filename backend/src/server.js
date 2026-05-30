import express from "express";
import cors from "cors";
import http from "http";
import dotenv from "dotenv";
import { runAgent, listAgents } from "./agents/agents.js";
import { attachTranscriptionWS } from "./agents/transcribe.js";

dotenv.config();

const app = express();
app.use(express.json({ limit: "2mb" }));

const allowed = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, cb) {
      if (!origin || allowed.length === 0 || allowed.includes(origin)) return cb(null, true);
      return cb(new Error("Origem não permitida pelo CORS: " + origin));
    },
  })
);

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "ortoguia-backend", agents: listAgents() });
});

app.get("/api/agents", (_req, res) => {
  res.json({ ok: true, agents: listAgents() });
});

app.post("/api/agents/:id", async (req, res) => {
  try {
    const result = await runAgent(req.params.id, req.body || {});
    res.json(result);
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ ok: false, error: err.message || "Erro ao executar agente" });
  }
});

app.post("/api/anamnese", async (req, res) => {
  try {
    const result = await runAgent("anamnese", req.body || {});
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

const PORT = process.env.PORT || 8787;
const server = http.createServer(app);

attachTranscriptionWS(server, "/ws/transcribe");

server.listen(PORT, () => {
  console.log(`[OrtoguIA] Backend de agentes rodando em http://localhost:${PORT}`);
  console.log(`[OrtoguIA] WebSocket de transcrição em ws://localhost:${PORT}/ws/transcribe`);
  console.log(`[OrtoguIA] Agentes:`, listAgents().map((a) => a.id).join(", "));
});
