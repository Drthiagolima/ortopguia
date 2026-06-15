import express from "express";
import cors from "cors";
import http from "http";
import dotenv from "dotenv";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import jwt from "jsonwebtoken";
import { promises as fs } from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
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
const APPOINTMENTS_FILE = path.join(REPO_DIR, "appointments.json");
const WHATSAPP_SESSIONS_FILE = path.join(REPO_DIR, "whatsapp-sessions.json");
const WHATSAPP_OUTBOX_FILE = path.join(REPO_DIR, "whatsapp-outbox.log");
const JWT_SECRET = String(process.env.JWT_SECRET || "").trim();
const JWT_EXPIRES_IN = String(process.env.JWT_EXPIRES_IN || "8h").trim() || "8h";
const SAO_PAULO_TZ = "America/Sao_Paulo";
const SAO_PAULO_UTC_OFFSET_MINUTES = -180;
const REMINDER_TICK_MS = Number(process.env.WHATSAPP_REMINDER_TICK_MS || 60_000);
const WHATSAPP_WEBHOOK_VERIFY_TOKEN = String(process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || "").trim();
const WHATSAPP_INBOUND_AUTH_TOKEN = String(process.env.WHATSAPP_INBOUND_AUTH_TOKEN || "").trim();
const WHATSAPP_PROVIDER = String(process.env.WHATSAPP_PROVIDER || "auto").trim().toLowerCase();
const WHATSAPP_SEND_URL = String(process.env.WHATSAPP_SEND_URL || "").trim();
const WHATSAPP_SEND_TOKEN = String(process.env.WHATSAPP_SEND_TOKEN || "").trim();
const WHATSAPP_FROM = String(process.env.WHATSAPP_FROM || "").trim();
const META_WHATSAPP_TOKEN = String(process.env.META_WHATSAPP_TOKEN || "").trim();
const META_WHATSAPP_PHONE_NUMBER_ID = String(process.env.META_WHATSAPP_PHONE_NUMBER_ID || "").trim();
const META_WHATSAPP_API_VERSION = String(process.env.META_WHATSAPP_API_VERSION || "v20.0").trim() || "v20.0";
const META_WHATSAPP_GRAPH_URL = String(process.env.META_WHATSAPP_GRAPH_URL || "").trim();
const SCAN_DIR = path.join(REPO_DIR, "scans");
const SCANNER_ENABLED = String(process.env.SCANNER_ENABLED || "true").trim().toLowerCase() !== "false";
const SCANNER_CAPTURE_FILE = path.join(REPO_DIR, "scanner-captures.json");
const PROCESS_LINKS_FILE = path.join(REPO_DIR, "process-patient-links.json");
const MV_MOCK_FILE = path.join(REPO_DIR, "mv-mock-patients.json");
const SCANNER_CAPTURE_PAGE_FILE = path.join(__dirname, "scanner-capture.html");
const MV_PROVIDER = String(process.env.MV_PROVIDER || "auto").trim().toLowerCase();
const MV_BASE_URL = String(process.env.MV_BASE_URL || "").trim();
const MV_PATIENT_BY_ATTENDIMENTO_PATH =
  String(process.env.MV_PATIENT_BY_ATTENDIMENTO_PATH || "/api/pacientes/atendimentos/{numeroAtendimento}").trim() ||
  "/api/pacientes/atendimentos/{numeroAtendimento}";
const MV_AUTH_TYPE = String(process.env.MV_AUTH_TYPE || "bearer").trim().toLowerCase();
const MV_TOKEN = String(process.env.MV_TOKEN || "").trim();
const MV_AUTH_HEADER_NAME = String(process.env.MV_AUTH_HEADER_NAME || "Authorization").trim() || "Authorization";
const MV_BASIC_USER = String(process.env.MV_BASIC_USER || "").trim();
const MV_BASIC_PASSWORD = String(process.env.MV_BASIC_PASSWORD || "").trim();
const MV_QUERY_TOKEN_PARAM = String(process.env.MV_QUERY_TOKEN_PARAM || "token").trim() || "token";
const MV_REQUEST_EXTRA_HEADERS_JSON = String(process.env.MV_REQUEST_EXTRA_HEADERS_JSON || "").trim();
const MV_PATIENT_PAYLOAD_PATH = String(process.env.MV_PATIENT_PAYLOAD_PATH || "").trim();
const MV_FIELD_MAP_JSON = String(process.env.MV_FIELD_MAP_JSON || "").trim();
const MV_TIMEOUT_MS = Number(process.env.MV_TIMEOUT_MS || 12000);
const MV_RETRY_COUNT = Number(process.env.MV_RETRY_COUNT || 1);
const AUTO_LINK_REQUIRE_FOUND = String(process.env.AUTO_LINK_REQUIRE_FOUND || "true").trim().toLowerCase() !== "false";
const AUTO_LINK_REQUIRE_PROCESS_ID = String(process.env.AUTO_LINK_REQUIRE_PROCESS_ID || "true").trim().toLowerCase() !== "false";
const AUTO_LINK_REQUIRE_PATIENT_NAME =
  String(process.env.AUTO_LINK_REQUIRE_PATIENT_NAME || "false").trim().toLowerCase() === "true";
const AUTO_LINK_BLOCK_DUPLICATE_IN_PROCESS =
  String(process.env.AUTO_LINK_BLOCK_DUPLICATE_IN_PROCESS || "true").trim().toLowerCase() !== "false";
const SCANNER_CAPTURE_MIN_LEN = Number(process.env.SCANNER_CAPTURE_MIN_LEN || 6);
const SCANNER_CAPTURE_MAX_LEN = Number(process.env.SCANNER_CAPTURE_MAX_LEN || 20);
const WIA_JPEG_FORMAT_ID = "{B96B3CAF-0728-11D3-9D7B-0000F81EF32E}";
const execFileAsync = promisify(execFile);

const defaultUsers = [
  {
    id: "med_thiago_lima",
    email: "thiagolima@ortopguia.com.br",
    role: "medico",
    name: "Thiago Lima",
    password: "TEMP_ALTERAR_001",
  },
  {
    id: "med_tiago_careno",
    email: "tiagocareno@ortopguia.com.br",
    role: "medico",
    name: "Tiago Careno",
    password: "TEMP_ALTERAR_002",
  },
  {
    id: "med_ortoguia_alias",
    email: "thiagolima@ortoguia.com.br",
    role: "medico",
    name: "Thiago Lima",
    password: "TEMP_ALTERAR_001",
  },
  {
    id: "med_ortoguia_alias2",
    email: "tiagocareno@ortoguia.com.br",
    role: "medico",
    name: "Tiago Careno",
    password: "TEMP_ALTERAR_002",
  },
  {
    id: "sec_mariana",
    email: "sec.mariana@ortopguia.com.br",
    role: "secretaria",
    name: "Mariana",
    password: "TEMP_ALTERAR_003",
  },
];

let authUsers = defaultUsers;
try {
  const parsed = JSON.parse(String(process.env.AUTH_USERS_JSON || "[]"));
  if (Array.isArray(parsed) && parsed.length) {
    const parsedUsers = parsed
      .filter((u) => u && u.email && u.role && u.password)
      .map((u, i) => ({
        id: String(u.id || `user_${i + 1}`),
        email: String(u.email).trim().toLowerCase(),
        role: String(u.role).trim().toLowerCase(),
        name: String(u.name || u.email).trim(),
        password: String(u.password || "").trim(),
      }));
    authUsers = parsedUsers.length ? parsedUsers : defaultUsers;
  }
} catch {
  authUsers = defaultUsers;
}

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

async function readJsonFile(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err && err.code === "ENOENT") return fallback;
    throw err;
  }
}

async function writeJsonFile(filePath, data) {
  await fs.mkdir(REPO_DIR, { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

async function appendOutboxLog(event) {
  await fs.mkdir(REPO_DIR, { recursive: true });
  const line = JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n";
  await fs.appendFile(WHATSAPP_OUTBOX_FILE, line, "utf8");
}

function normalizeAttendanceNumber(input) {
  return String(input || "").replace(/\D/g, "").trim();
}

function validateAttendanceNumber(input) {
  const normalized = normalizeAttendanceNumber(input);
  if (!normalized) {
    return { ok: false, error: "Número de atendimento não informado", normalized: "" };
  }
  if (!/^\d+$/.test(normalized)) {
    return { ok: false, error: "Número de atendimento inválido", normalized };
  }
  if (normalized.length < SCANNER_CAPTURE_MIN_LEN || normalized.length > SCANNER_CAPTURE_MAX_LEN) {
    return {
      ok: false,
      error: `Número de atendimento deve ter entre ${SCANNER_CAPTURE_MIN_LEN} e ${SCANNER_CAPTURE_MAX_LEN} dígitos`,
      normalized,
    };
  }
  return { ok: true, normalized };
}

async function readScannerCaptures() {
  const parsed = await readJsonFile(SCANNER_CAPTURE_FILE, { items: [] });
  if (!parsed || typeof parsed !== "object") return { items: [] };
  if (!Array.isArray(parsed.items)) parsed.items = [];
  return parsed;
}

async function appendScannerCapture(item) {
  const db = await readScannerCaptures();
  db.items.push(item);
  if (db.items.length > 300) {
    db.items = db.items.slice(-300);
  }
  await writeJsonFile(SCANNER_CAPTURE_FILE, db);
  return item;
}

async function readMvMockPatients() {
  const parsed = await readJsonFile(MV_MOCK_FILE, { items: [] });
  if (!parsed || typeof parsed !== "object") return { items: [] };
  if (!Array.isArray(parsed.items)) parsed.items = [];
  return parsed;
}

function resolveMvMode() {
  if (MV_PROVIDER === "mock") return "mock";
  if (MV_PROVIDER === "remote") return "remote";
  return MV_BASE_URL ? "remote" : "mock";
}

function buildMvLookupUrl(numeroAtendimento) {
  const base = MV_BASE_URL.replace(/\/$/, "");
  const pathTemplate = MV_PATIENT_BY_ATTENDIMENTO_PATH.startsWith("/")
    ? MV_PATIENT_BY_ATTENDIMENTO_PATH
    : `/${MV_PATIENT_BY_ATTENDIMENTO_PATH}`;
  const pathFilled = pathTemplate.replace("{numeroAtendimento}", encodeURIComponent(numeroAtendimento));
  return `${base}${pathFilled}`;
}

function pickFirst(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const str = String(value).trim();
    if (str) return str;
  }
  return "";
}

function parseJsonObject(value, fallback = {}) {
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function getByPath(source, pathExpr) {
  if (!source || typeof source !== "object") return undefined;
  const raw = String(pathExpr || "").trim();
  if (!raw) return undefined;
  const parts = raw.split(".").filter(Boolean);
  let current = source;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const idx = Number(part);
      if (!Number.isFinite(idx) || idx < 0 || idx >= current.length) return undefined;
      current = current[idx];
      continue;
    }
    if (typeof current !== "object" || !(part in current)) return undefined;
    current = current[part];
  }
  return current;
}

function coercePathList(value, fallback) {
  if (Array.isArray(value) && value.length) {
    return value.map((v) => String(v || "").trim()).filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  return fallback;
}

function resolveMvFieldMap() {
  const defaults = {
    numeroAtendimento: [
      "numeroAtendimento",
      "nrAtendimento",
      "attendanceNumber",
      "atendimento.numero",
      "data.numeroAtendimento",
    ],
    pacienteIdMv: ["pacienteIdMv", "pacienteId", "idPaciente", "id", "patientId", "codigo", "data.idPaciente"],
    nome: ["nome", "nomePaciente", "patientName", "paciente", "name", "data.nome"],
    nascimento: ["nascimento", "dataNascimento", "birthDate", "dtNascimento", "data.nascimento"],
    convenio: ["convenio", "plano", "insurance", "operadora", "data.convenio"],
    unidade: ["unidade", "hospital", "clinica", "location", "data.unidade"],
  };
  const custom = parseJsonObject(MV_FIELD_MAP_JSON, {});
  return {
    numeroAtendimento: coercePathList(custom.numeroAtendimento, defaults.numeroAtendimento),
    pacienteIdMv: coercePathList(custom.pacienteIdMv, defaults.pacienteIdMv),
    nome: coercePathList(custom.nome, defaults.nome),
    nascimento: coercePathList(custom.nascimento, defaults.nascimento),
    convenio: coercePathList(custom.convenio, defaults.convenio),
    unidade: coercePathList(custom.unidade, defaults.unidade),
  };
}

function pickByPaths(payload, paths, fallback = "") {
  for (const pathExpr of paths) {
    const value = getByPath(payload, pathExpr);
    const picked = pickFirst(value);
    if (picked) return picked;
  }
  return fallback;
}

function encodeBasicAuth(user, pass) {
  return Buffer.from(`${String(user || "")}:${String(pass || "")}`, "utf8").toString("base64");
}

function buildMvRequestHeaders() {
  const headers = {
    Accept: "application/json",
  };
  const extras = parseJsonObject(MV_REQUEST_EXTRA_HEADERS_JSON, {});
  for (const [key, value] of Object.entries(extras)) {
    if (!key) continue;
    headers[String(key)] = String(value ?? "");
  }

  if (MV_AUTH_TYPE === "bearer" && MV_TOKEN) {
    headers[MV_AUTH_HEADER_NAME] = `Bearer ${MV_TOKEN}`;
  }
  if (MV_AUTH_TYPE === "header" && MV_TOKEN) {
    headers[MV_AUTH_HEADER_NAME] = MV_TOKEN;
  }
  if (MV_AUTH_TYPE === "basic" && MV_BASIC_USER) {
    headers.Authorization = `Basic ${encodeBasicAuth(MV_BASIC_USER, MV_BASIC_PASSWORD)}`;
  }
  return headers;
}

function applyMvQueryAuth(url) {
  if (MV_AUTH_TYPE !== "query" || !MV_TOKEN) return url;
  const parsed = new URL(url);
  parsed.searchParams.set(MV_QUERY_TOKEN_PARAM, MV_TOKEN);
  return parsed.toString();
}

function normalizeMvPatient(raw, numeroAtendimento) {
  if (!raw || typeof raw !== "object") return null;
  const fieldMap = resolveMvFieldMap();
  const patientIdMv = pickByPaths(raw, fieldMap.pacienteIdMv);
  const nome = pickByPaths(raw, fieldMap.nome);
  const nascimento = pickByPaths(raw, fieldMap.nascimento);
  const convenio = pickByPaths(raw, fieldMap.convenio);
  const unidade = pickByPaths(raw, fieldMap.unidade);
  const mappedAttendance = pickByPaths(raw, fieldMap.numeroAtendimento, numeroAtendimento);
  return {
    numeroAtendimento: normalizeAttendanceNumber(mappedAttendance),
    pacienteIdMv: patientIdMv || `mv_${normalizeAttendanceNumber(numeroAtendimento)}`,
    nome: nome || "Paciente",
    nascimento,
    convenio,
    unidade,
  };
}

function normalizeMvPatientWithFieldMap(raw, numeroAtendimento, fieldMapOverride = null) {
  if (!raw || typeof raw !== "object") return null;
  const baseMap = resolveMvFieldMap();
  const custom = fieldMapOverride && typeof fieldMapOverride === "object" ? fieldMapOverride : {};
  const effectiveMap = {
    numeroAtendimento: coercePathList(custom.numeroAtendimento, baseMap.numeroAtendimento),
    pacienteIdMv: coercePathList(custom.pacienteIdMv, baseMap.pacienteIdMv),
    nome: coercePathList(custom.nome, baseMap.nome),
    nascimento: coercePathList(custom.nascimento, baseMap.nascimento),
    convenio: coercePathList(custom.convenio, baseMap.convenio),
    unidade: coercePathList(custom.unidade, baseMap.unidade),
  };

  const patientIdMv = pickByPaths(raw, effectiveMap.pacienteIdMv);
  const nome = pickByPaths(raw, effectiveMap.nome);
  const nascimento = pickByPaths(raw, effectiveMap.nascimento);
  const convenio = pickByPaths(raw, effectiveMap.convenio);
  const unidade = pickByPaths(raw, effectiveMap.unidade);
  const mappedAttendance = pickByPaths(raw, effectiveMap.numeroAtendimento, numeroAtendimento);
  return {
    numeroAtendimento: normalizeAttendanceNumber(mappedAttendance),
    pacienteIdMv: patientIdMv || `mv_${normalizeAttendanceNumber(numeroAtendimento)}`,
    nome: nome || "Paciente",
    nascimento,
    convenio,
    unidade,
  };
}

function extractPatientFromMvPayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (MV_PATIENT_PAYLOAD_PATH) {
    const byCustomPath = getByPath(payload, MV_PATIENT_PAYLOAD_PATH);
    if (byCustomPath && typeof byCustomPath === "object") return byCustomPath;
  }
  if (payload.patient && typeof payload.patient === "object") return payload.patient;
  if (payload.data && typeof payload.data === "object") {
    if (payload.data.patient && typeof payload.data.patient === "object") return payload.data.patient;
    return payload.data;
  }
  return payload;
}

async function fetchJsonWithTimeout(url, init = {}, timeoutMs = 12000) {
  const timeout = Number.isFinite(timeoutMs) ? Math.max(1000, timeoutMs) : 12000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function findMvPatientRemote(numeroAtendimento) {
  if (!MV_BASE_URL) {
    throw new Error("MV_BASE_URL não configurado para integração remota");
  }

  const url = applyMvQueryAuth(buildMvLookupUrl(numeroAtendimento));
  const maxAttempts = Number.isFinite(MV_RETRY_COUNT) ? Math.max(0, MV_RETRY_COUNT) + 1 : 2;
  let lastErr = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchJsonWithTimeout(
        url,
        {
          method: "GET",
          headers: buildMvRequestHeaders(),
        },
        MV_TIMEOUT_MS
      );

      if (response.status === 404) return null;

      const rawText = await response.text();
      let payload = null;
      try {
        payload = rawText ? JSON.parse(rawText) : null;
      } catch {
        payload = { raw: rawText };
      }

      if (!response.ok) {
        const detail = payload && typeof payload === "object" ? pickFirst(payload.error, payload.message) : "";
        throw new Error(`MV respondeu ${response.status}${detail ? `: ${detail}` : ""}`);
      }

      const extracted = extractPatientFromMvPayload(payload);
      return normalizeMvPatient(extracted, numeroAtendimento);
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 350 * attempt));
      }
    }
  }

  throw lastErr || new Error("Falha desconhecida ao consultar MV remoto");
}

async function findMvPatientByAttendance(numeroAtendimento) {
  const mode = resolveMvMode();
  if (mode === "remote") {
    const patient = await findMvPatientRemote(numeroAtendimento);
    return {
      source: "remote",
      patient,
    };
  }

  const mockDb = await readMvMockPatients();
  const found = mockDb.items.find(
    (p) => normalizeAttendanceNumber(p && p.numeroAtendimento) === normalizeAttendanceNumber(numeroAtendimento)
  );
  if (!found) {
    return {
      source: "mock",
      patient: null,
    };
  }
  return {
    source: "mock",
    patient: {
      numeroAtendimento: normalizeAttendanceNumber(found.numeroAtendimento),
      pacienteIdMv:
        String(found.pacienteIdMv || "").trim() || `mv_${normalizeAttendanceNumber(found.numeroAtendimento)}`,
      nome: String(found.nome || "Paciente").trim() || "Paciente",
      nascimento: String(found.nascimento || "").trim(),
      convenio: String(found.convenio || "").trim(),
      unidade: String(found.unidade || "").trim(),
    },
  };
}

async function appendProcessLink(item) {
  const parsed = await readJsonFile(PROCESS_LINKS_FILE, { items: [] });
  const db = !parsed || typeof parsed !== "object" ? { items: [] } : parsed;
  if (!Array.isArray(db.items)) db.items = [];
  db.items.push(item);
  await writeJsonFile(PROCESS_LINKS_FILE, db);
  return item;
}

async function readProcessLinks() {
  const parsed = await readJsonFile(PROCESS_LINKS_FILE, { items: [] });
  if (!parsed || typeof parsed !== "object") return { items: [] };
  if (!Array.isArray(parsed.items)) parsed.items = [];
  return parsed;
}

function buildProcessLink({ processoId, numeroAtendimento, pacienteIdMv, pacienteNome }) {
  return {
    id: "link_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    processoId,
    numeroAtendimento,
    pacienteIdMv,
    pacienteNome,
    linkedAt: new Date().toISOString(),
  };
}

function evaluateAutoLinkRules({ processoId, patient, existingLinks }) {
  const reasons = [];
  if (AUTO_LINK_REQUIRE_PROCESS_ID && !processoId) {
    reasons.push("processoId ausente");
  }
  if (AUTO_LINK_REQUIRE_FOUND && !patient) {
    reasons.push("paciente não encontrado no MV");
  }
  if (AUTO_LINK_REQUIRE_PATIENT_NAME && !String((patient && patient.nome) || "").trim()) {
    reasons.push("nome do paciente ausente no retorno do MV");
  }

  if (AUTO_LINK_BLOCK_DUPLICATE_IN_PROCESS && patient && Array.isArray(existingLinks)) {
    const exists = existingLinks.some(
      (item) =>
        String(item.processoId || "") === String(processoId || "") &&
        String(item.pacienteIdMv || "") === String(patient.pacienteIdMv || "")
    );
    if (exists) {
      reasons.push("vínculo já existente para este processo e paciente");
    }
  }

  return {
    allowed: reasons.length === 0,
    reasons,
  };
}

async function readScannerCapturePageHtml() {
  try {
    return await fs.readFile(SCANNER_CAPTURE_PAGE_FILE, "utf8");
  } catch {
    return "<!doctype html><html><body><h1>Arquivo scanner-capture.html não encontrado</h1></body></html>";
  }
}

function sanitizeScanBaseName(input) {
  const raw = String(input || "").trim().toLowerCase();
  const safe = raw.replace(/[^a-z0-9-_]/g, "").slice(0, 50);
  return safe || "scan";
}

function buildScanFilePath(fileNameHint) {
  const base = sanitizeScanBaseName(fileNameHint);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(SCAN_DIR, `${base}-${stamp}.jpg`);
}

function escapePowerShellSingleQuoted(value) {
  return String(value || "").replace(/'/g, "''");
}

async function runPowerShell(script) {
  const { stdout, stderr } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    {
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    }
  );

  return {
    stdout: String(stdout || "").trim(),
    stderr: String(stderr || "").trim(),
  };
}

async function runPowerShellJson(script) {
  const { stdout } = await runPowerShell(script);
  if (!stdout) return null;
  return JSON.parse(stdout);
}

async function listWiaScanners() {
  if (process.platform !== "win32") return [];

  const script = `
$ErrorActionPreference = 'Stop'
$manager = New-Object -ComObject WIA.DeviceManager
$scanners = @(
  $manager.DeviceInfos |
    Where-Object { $_.Type -eq 1 } |
    ForEach-Object {
      [PSCustomObject]@{
        name = [string]$_.Properties.Item('Name').Value
        deviceId = [string]$_.DeviceID
      }
    }
)
$scanners | ConvertTo-Json -Compress
`;

  const parsed = await runPowerShellJson(script);
  if (!parsed) return [];
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function getScannerDiagnostics() {
  if (process.platform !== "win32") {
    return {
      platform: process.platform,
      wiaService: null,
      imagingDevices: [],
    };
  }

  const serviceScript = `
$svc = Get-Service -Name stisvc -ErrorAction SilentlyContinue
if (-not $svc) {
  [PSCustomObject]@{ exists = $false; status = ''; startType = '' } | ConvertTo-Json -Compress
  return
}
$cim = Get-CimInstance -ClassName Win32_Service -Filter "Name='stisvc'" -ErrorAction SilentlyContinue
[PSCustomObject]@{
  exists = $true
  status = [string]$svc.Status
  startType = [string]($cim.StartMode)
} | ConvertTo-Json -Compress
`;

  const devicesScript = `
$devices = @(
  Get-CimInstance Win32_PnPEntity -ErrorAction SilentlyContinue |
    Where-Object {
      ($_.PNPClass -eq 'Image') -or
      ($_.Name -match '(?i)scanner|scan|impressora|mfp|multifuncional')
    } |
    Select-Object Name, PNPClass, Status, DeviceID
)
$devices | ConvertTo-Json -Compress
`;

  const wiaServiceRaw = await runPowerShellJson(serviceScript);
  const imagingDevicesRaw = await runPowerShellJson(devicesScript);

  const imagingDevices = !imagingDevicesRaw
    ? []
    : Array.isArray(imagingDevicesRaw)
      ? imagingDevicesRaw
      : [imagingDevicesRaw];

  return {
    platform: process.platform,
    wiaService: wiaServiceRaw || { exists: false, status: "", startType: "" },
    imagingDevices,
  };
}

async function tryStartWiaService() {
  if (process.platform !== "win32") {
    return { ok: false, message: "Somente Windows suporta serviço WIA." };
  }

  const script = `
$ErrorActionPreference = 'Stop'
$svc = Get-Service -Name stisvc -ErrorAction SilentlyContinue
if (-not $svc) {
  [PSCustomObject]@{ ok = $false; message = 'Serviço WIA (stisvc) não encontrado.' } | ConvertTo-Json -Compress
  return
}
if ($svc.Status -ne 'Running') {
  Start-Service -Name stisvc -ErrorAction SilentlyContinue
}
$svc = Get-Service -Name stisvc
[PSCustomObject]@{
  ok = ($svc.Status -eq 'Running')
  status = [string]$svc.Status
  message = 'Tentativa de inicialização concluída.'
} | ConvertTo-Json -Compress
`;

  const parsed = await runPowerShellJson(script);
  return parsed || { ok: false, message: "Não foi possível validar o serviço WIA." };
}

async function scanFirstWiaDevice(outputFilePath, preferredDeviceId = "") {
  if (process.platform !== "win32") {
    const err = new Error("Scanner via WIA está disponível apenas no Windows.");
    err.status = 400;
    throw err;
  }

  await fs.mkdir(SCAN_DIR, { recursive: true });
  const escapedPath = escapePowerShellSingleQuoted(outputFilePath);
  const escapedPreferredId = escapePowerShellSingleQuoted(preferredDeviceId);

  const script = `
$ErrorActionPreference = 'Stop'
$out = '${escapedPath}'
$preferredId = '${escapedPreferredId}'
$manager = New-Object -ComObject WIA.DeviceManager
$scanner = $null
if ($preferredId) {
  $scanner = $manager.DeviceInfos |
    Where-Object { $_.Type -eq 1 -and $_.DeviceID -eq $preferredId } |
    Select-Object -First 1
}
if (-not $scanner) {
  $scanner = $manager.DeviceInfos | Where-Object { $_.Type -eq 1 } | Select-Object -First 1
}
if (-not $scanner) { throw 'Nenhum scanner WIA encontrado via USB.' }
$device = $scanner.Connect()
$item = $device.Items.Item(1)
$dialog = New-Object -ComObject WIA.CommonDialog
$image = $dialog.ShowTransfer($item, '${WIA_JPEG_FORMAT_ID}', $false)
if (-not $image) { throw 'Digitalização cancelada.' }
$image.SaveFile($out)
Write-Output $out
`;

  try {
    await runPowerShell(script);
  } catch (err) {
    const message = String((err && err.message) || "");
    if (message.includes("Nenhum scanner WIA encontrado via USB.")) {
      err.status = 404;
    }
    throw err;
  }
}

function normalizePhoneBR(input) {
  const digits = String(input || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("55")) return digits;
  if (digits.length >= 10) return `55${digits}`;
  return digits;
}

function getSaoPauloParts(dateInput) {
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: SAO_PAULO_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const map = Object.fromEntries(parts.filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

function localSaoPauloToUtcMs(year, month, day, hour, minute) {
  return Date.UTC(year, month - 1, day, hour, minute, 0) - SAO_PAULO_UTC_OFFSET_MINUTES * 60 * 1000;
}

function formatDateTimeSaoPaulo(dateInput) {
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: SAO_PAULO_TZ,
    dateStyle: "short",
    timeStyle: "short",
  }).format(date);
}

function formatDateSaoPaulo(dateInput) {
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: SAO_PAULO_TZ,
    dateStyle: "short",
  }).format(date);
}

function isoDateFromParts(parts) {
  const m = String(parts.month).padStart(2, "0");
  const d = String(parts.day).padStart(2, "0");
  return `${parts.year}-${m}-${d}`;
}

function addDaysToIsoDate(isoDate, deltaDays) {
  const [y, m, d] = String(isoDate).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  const ny = dt.getUTCFullYear();
  const nm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const nd = String(dt.getUTCDate()).padStart(2, "0");
  return `${ny}-${nm}-${nd}`;
}

function parsePreferenceDateTime(text) {
  const source = String(text || "").trim();
  const normalized = source.toLowerCase();
  const nowParts = getSaoPauloParts(new Date());
  let isoDate = isoDateFromParts(nowParts);

  if (normalized.includes("depois de amanhã") || normalized.includes("depois de amanha")) {
    isoDate = addDaysToIsoDate(isoDate, 2);
  } else if (normalized.includes("amanhã") || normalized.includes("amanha")) {
    isoDate = addDaysToIsoDate(isoDate, 1);
  }

  const dateMatch = normalized.match(/(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/);
  if (dateMatch) {
    const day = Number(dateMatch[1]);
    const month = Number(dateMatch[2]);
    const yearRaw = dateMatch[3] ? Number(dateMatch[3]) : nowParts.year;
    const year = yearRaw < 100 ? 2000 + yearRaw : yearRaw;
    const mm = String(month).padStart(2, "0");
    const dd = String(day).padStart(2, "0");
    isoDate = `${year}-${mm}-${dd}`;
  }

  let preferredTime = "";
  const fullTime = normalized.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (fullTime) {
    preferredTime = `${String(Number(fullTime[1])).padStart(2, "0")}:${fullTime[2]}`;
  } else {
    const hourOnly = normalized.match(/\b([01]?\d|2[0-3])\s*h\b/);
    if (hourOnly) preferredTime = `${String(Number(hourOnly[1])).padStart(2, "0")}:00`;
  }

  return { isoDate, preferredTime };
}

function parseConsultationMode(text) {
  const source = String(text || "").toLowerCase();
  if (source.includes("tele") || source.includes("video") || source.includes("vídeo") || source.includes("remota")) {
    return "teleconsulta";
  }
  if (source.includes("presencial") || source.includes("consultório") || source.includes("consultorio")) {
    return "presencial";
  }
  return "";
}

function slotList() {
  const slots = [];
  for (let hour = 8; hour <= 17; hour += 1) {
    slots.push(`${String(hour).padStart(2, "0")}:00`);
    slots.push(`${String(hour).padStart(2, "0")}:30`);
  }
  return slots;
}

async function readAppointments() {
  const parsed = await readJsonFile(APPOINTMENTS_FILE, { appointments: [] });
  if (!parsed || typeof parsed !== "object") return { appointments: [] };
  if (!Array.isArray(parsed.appointments)) parsed.appointments = [];
  return parsed;
}

async function writeAppointments(data) {
  await writeJsonFile(APPOINTMENTS_FILE, data);
}

async function readWhatsappSessions() {
  const parsed = await readJsonFile(WHATSAPP_SESSIONS_FILE, { sessions: {} });
  if (!parsed || typeof parsed !== "object") return { sessions: {} };
  if (!parsed.sessions || typeof parsed.sessions !== "object") parsed.sessions = {};
  return parsed;
}

async function writeWhatsappSessions(data) {
  await writeJsonFile(WHATSAPP_SESSIONS_FILE, data);
}

function buildAvailableSlots(isoDate, mode, appointments) {
  const allSlots = slotList();
  const busy = new Set();
  for (const appt of appointments) {
    if (!appt || String(appt.status || "").toLowerCase() === "cancelado") continue;
    if (String(appt.mode || "") !== String(mode || "")) continue;
    const p = getSaoPauloParts(appt.consultAt);
    const d = isoDateFromParts(p);
    if (d !== isoDate) continue;
    busy.add(`${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`);
  }
  return allSlots.filter((s) => !busy.has(s));
}

function firstSlotByPreference(slots, preferredTime) {
  if (!slots.length) return "";
  if (!preferredTime) return slots[0];
  const found = slots.find((s) => s >= preferredTime);
  return found || slots[slots.length - 1];
}

async function reserveNextAvailableSlot({ mode, preferredDate, preferredTime }) {
  const db = await readAppointments();
  const startDate = preferredDate || isoDateFromParts(getSaoPauloParts(new Date()));
  for (let i = 0; i < 21; i += 1) {
    const dateIso = addDaysToIsoDate(startDate, i);
    const free = buildAvailableSlots(dateIso, mode, db.appointments);
    if (!free.length) continue;
    const picked = i === 0 ? firstSlotByPreference(free, preferredTime) : free[0];
    const [year, month, day] = dateIso.split("-").map(Number);
    const [hour, minute] = picked.split(":").map(Number);
    const consultAt = new Date(localSaoPauloToUtcMs(year, month, day, hour, minute)).toISOString();
    return { consultAt, slot: picked, dateIso };
  }
  return null;
}

function resolveWhatsAppProvider() {
  if (WHATSAPP_PROVIDER === "meta") return "meta";
  if (WHATSAPP_PROVIDER === "generic") return "generic";
  if (META_WHATSAPP_TOKEN && META_WHATSAPP_PHONE_NUMBER_ID) return "meta";
  if (WHATSAPP_SEND_URL) return "generic";
  return "mock";
}

function resolveMetaSendUrl() {
  const base = META_WHATSAPP_GRAPH_URL || `https://graph.facebook.com/${META_WHATSAPP_API_VERSION}`;
  return `${base.replace(/\/$/, "")}/${META_WHATSAPP_PHONE_NUMBER_ID}/messages`;
}

async function sendWhatsAppMessage(to, text, metadata = {}) {
  const phone = normalizePhoneBR(to);
  if (!phone) return { ok: false, error: "Telefone inválido" };
  const provider = resolveWhatsAppProvider();
  const payload = {
    from: WHATSAPP_FROM || undefined,
    to: phone,
    text: String(text || ""),
    metadata,
  };

  if (provider === "mock") {
    await appendOutboxLog({ direction: "outbound", provider: "mock", payload });
    return { ok: true, mock: true };
  }

  if (provider === "meta") {
    if (!META_WHATSAPP_TOKEN || !META_WHATSAPP_PHONE_NUMBER_ID) {
      await appendOutboxLog({
        direction: "outbound",
        provider: "meta",
        payload,
        error: "META_WHATSAPP_TOKEN ou META_WHATSAPP_PHONE_NUMBER_ID ausentes",
      });
      return { ok: false, error: "Configuração Meta WhatsApp incompleta" };
    }

    const metaUrl = resolveMetaSendUrl();
    const metaPayload = {
      messaging_product: "whatsapp",
      to: phone,
      type: "text",
      text: {
        body: String(text || ""),
        preview_url: false,
      },
    };

    try {
      const response = await fetch(metaUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${META_WHATSAPP_TOKEN}`,
        },
        body: JSON.stringify(metaPayload),
      });
      const raw = await response.text();
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = { raw };
      }
      await appendOutboxLog({
        direction: "outbound",
        provider: "meta",
        status: response.status,
        payload: metaPayload,
        response: body,
      });
      if (!response.ok) {
        return { ok: false, error: `Falha Meta WhatsApp (${response.status})`, response: body };
      }
      return { ok: true, provider: "meta", response: body };
    } catch (err) {
      await appendOutboxLog({ direction: "outbound", provider: "meta", payload: metaPayload, error: err.message });
      return { ok: false, error: err.message || "Erro ao enviar via Meta WhatsApp" };
    }
  }

  try {
    const response = await fetch(WHATSAPP_SEND_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(WHATSAPP_SEND_TOKEN ? { Authorization: `Bearer ${WHATSAPP_SEND_TOKEN}` } : {}),
      },
      body: JSON.stringify(payload),
    });
    const raw = await response.text();
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = { raw };
    }
    await appendOutboxLog({
      direction: "outbound",
      provider: "http",
      status: response.status,
      payload,
      response: body,
    });
    if (!response.ok) {
      return { ok: false, error: `Falha ao enviar mensagem (${response.status})` };
    }
    return { ok: true, response: body };
  } catch (err) {
    await appendOutboxLog({ direction: "outbound", provider: "http", payload, error: err.message });
    return { ok: false, error: err.message || "Erro ao enviar mensagem" };
  }
}

function buildFriendlyGreeting(patientName) {
  const namePart = patientName ? `, ${patientName}` : "";
  return [
    `Olá${namePart}! Eu sou a atendente virtual do ORTOPGUIA 😊`,
    "Vou te ajudar até resolver seu atendimento ortopédico.",
    "Para começarmos, qual é o motivo principal da sua consulta?",
  ].join("\n");
}

function buildReminderMessages(appointment) {
  const when = formatDateTimeSaoPaulo(appointment.consultAt);
  const modeLabel = appointment.mode === "teleconsulta" ? "teleconsulta" : "consulta presencial";
  return {
    dayBefore: [
      `Olá, ${appointment.patientName || "paciente"}! Passando para confirmar sua ${modeLabel} de amanhã.`,
      `Data e horário: ${when}`,
      "Se precisar ajustar, responda esta mensagem que te ajudamos agora.",
    ].join("\n"),
    oneHour: [
      `Olá, ${appointment.patientName || "paciente"}! Sua ${modeLabel} é em cerca de 60 minutos.`,
      `Horário: ${when}`,
      "Se já estiver pronto(a), seguimos com seu atendimento no horário combinado.",
    ].join("\n"),
  };
}

function shouldAuthorizeInbound(req) {
  if (!WHATSAPP_INBOUND_AUTH_TOKEN) return true;
  const headerToken = String(req.headers["x-whatsapp-token"] || req.headers["x-webhook-token"] || "").trim();
  return headerToken && headerToken === WHATSAPP_INBOUND_AUTH_TOKEN;
}

function extractIncomingMessages(body) {
  const directFrom = normalizePhoneBR(body && body.from);
  const directText = String((body && (body.text || body.message || body.body)) || "").trim();
  const directName = String((body && body.name) || "").trim();
  if (directFrom && directText) {
    return [{ from: directFrom, text: directText, name: directName }];
  }

  const messages = [];
  const entries = Array.isArray(body && body.entry) ? body.entry : [];
  for (const entry of entries) {
    const changes = Array.isArray(entry && entry.changes) ? entry.changes : [];
    for (const change of changes) {
      const value = (change && change.value) || {};
      const contacts = Array.isArray(value.contacts) ? value.contacts : [];
      const contactByWa = Object.fromEntries(
        contacts
          .filter((c) => c && c.wa_id)
          .map((c) => [normalizePhoneBR(c.wa_id), String((c.profile && c.profile.name) || "").trim()])
      );
      const incoming = Array.isArray(value.messages) ? value.messages : [];
      for (const msg of incoming) {
        const from = normalizePhoneBR(msg && msg.from);
        const text = String((msg && msg.text && msg.text.body) || "").trim();
        if (!from || !text) continue;
        messages.push({ from, text, name: contactByWa[from] || "" });
      }
    }
  }
  return messages;
}

async function processInboundWhatsappMessage({ from, text, name }) {
  const sessionsDb = await readWhatsappSessions();
  const session = sessionsDb.sessions[from] || {
    stage: "await_reason",
    patientName: name || "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (name && !session.patientName) session.patientName = name;

  const normalizedText = String(text || "").trim();
  const lowered = normalizedText.toLowerCase();
  const resetFlow = ["novo agendamento", "reagendar", "outra consulta", "nova consulta"].some((k) =>
    lowered.includes(k)
  );

  if (!session.hasGreeted || session.stage === "start" || resetFlow) {
    session.hasGreeted = true;
    session.stage = "await_reason";
    session.reason = "";
    session.preferredDate = "";
    session.preferredTime = "";
    session.mode = "";
    session.updatedAt = new Date().toISOString();
    sessionsDb.sessions[from] = session;
    await writeWhatsappSessions(sessionsDb);
    const greet = buildFriendlyGreeting(session.patientName);
    await sendWhatsAppMessage(from, greet, { type: "greeting" });
    return { ok: true, stage: session.stage, message: greet };
  }

  if (session.stage === "await_reason") {
    session.reason = normalizedText;
    session.stage = "await_datetime";
    session.updatedAt = new Date().toISOString();
    sessionsDb.sessions[from] = session;
    await writeWhatsappSessions(sessionsDb);
    const reply = "Perfeito, entendi. Qual dia e horário você prefere? Pode me enviar assim: 03/06 às 14:30.";
    await sendWhatsAppMessage(from, reply, { type: "ask_datetime" });
    return { ok: true, stage: session.stage, message: reply };
  }

  if (session.stage === "await_datetime") {
    const parsed = parsePreferenceDateTime(normalizedText);
    if (!parsed.isoDate) {
      const retry = "Não consegui identificar o dia. Pode me informar no formato DD/MM e, se puder, também o horário?";
      await sendWhatsAppMessage(from, retry, { type: "retry_datetime" });
      return { ok: true, stage: session.stage, message: retry };
    }
    session.preferredDate = parsed.isoDate;
    session.preferredTime = parsed.preferredTime || "";
    session.stage = "await_mode";
    session.updatedAt = new Date().toISOString();
    sessionsDb.sessions[from] = session;
    await writeWhatsappSessions(sessionsDb);
    const reply =
      "Ótimo. Você prefere consulta presencial ou teleconsulta? Se quiser, eu já verifico a melhor opção disponível para você.";
    await sendWhatsAppMessage(from, reply, { type: "ask_mode" });
    return { ok: true, stage: session.stage, message: reply };
  }

  if (session.stage === "await_mode") {
    const mode = parseConsultationMode(normalizedText);
    if (!mode) {
      const retry = "Me confirma por favor: você prefere presencial ou teleconsulta?";
      await sendWhatsAppMessage(from, retry, { type: "retry_mode" });
      return { ok: true, stage: session.stage, message: retry };
    }
    session.mode = mode;

    const reserved = await reserveNextAvailableSlot({
      mode,
      preferredDate: session.preferredDate,
      preferredTime: session.preferredTime,
    });

    if (!reserved) {
      const fail =
        "No momento não encontrei vaga disponível nos próximos dias. Vou encaminhar seu atendimento para a equipe humana te retornar já já.";
      await sendWhatsAppMessage(from, fail, { type: "no_availability" });
      return { ok: false, stage: session.stage, message: fail };
    }

    const db = await readAppointments();
    const patientName = session.patientName || "Paciente";
    const appointment = {
      id: "apt_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      patientName,
      phone: from,
      reason: session.reason || "Queixa ortopédica",
      mode,
      consultAt: reserved.consultAt,
      source: "whatsapp",
      status: "agendado",
      reminders: {
        dayBeforeSentAt: null,
        oneHourSentAt: null,
      },
      createdAt: new Date().toISOString(),
    };
    db.appointments.push(appointment);
    await writeAppointments(db);

    session.stage = "completed";
    session.lastAppointmentId = appointment.id;
    session.updatedAt = new Date().toISOString();
    sessionsDb.sessions[from] = session;
    await writeWhatsappSessions(sessionsDb);

    const when = formatDateTimeSaoPaulo(appointment.consultAt);
    const confirmation = [
      `Perfeito! Seu agendamento foi realizado com sucesso ✅`,
      `Tipo: ${mode === "teleconsulta" ? "Teleconsulta" : "Presencial"}`,
      `Data e horário: ${when}`,
      `Motivo informado: ${appointment.reason}`,
      "Também vamos te lembrar automaticamente no dia anterior às 18h (quando houver tempo) e 60 minutos antes da consulta.",
    ].join("\n");
    await sendWhatsAppMessage(from, confirmation, { type: "appointment_confirmed", appointmentId: appointment.id });
    return { ok: true, stage: session.stage, data: appointment, message: confirmation };
  }

  const fallback =
    "Estou aqui para te ajudar. Se quiser novo agendamento, me envie: novo agendamento. Assim eu começo novamente com você.";
  await sendWhatsAppMessage(from, fallback, { type: "fallback" });
  return { ok: true, stage: session.stage, message: fallback };
}

async function runAppointmentReminderCycle() {
  const db = await readAppointments();
  let changed = false;
  const nowMs = Date.now();

  for (const appointment of db.appointments) {
    if (!appointment || String(appointment.status || "").toLowerCase() === "cancelado") continue;
    const phone = normalizePhoneBR(appointment.phone);
    if (!phone) continue;
    const consultMs = Date.parse(appointment.consultAt || "");
    if (!Number.isFinite(consultMs) || consultMs <= nowMs) continue;

    if (!appointment.reminders || typeof appointment.reminders !== "object") {
      appointment.reminders = { dayBeforeSentAt: null, oneHourSentAt: null };
      changed = true;
    }

    const consultDate = new Date(consultMs);
    const consultParts = getSaoPauloParts(consultDate);
    const consultDateIso = isoDateFromParts(consultParts);
    const previousDateIso = addDaysToIsoDate(consultDateIso, -1);
    const [py, pm, pd] = previousDateIso.split("-").map(Number);
    const dayBeforeTriggerMs = localSaoPauloToUtcMs(py, pm, pd, 18, 0);
    const oneHourBeforeMs = consultMs - 60 * 60 * 1000;
    const reminders = buildReminderMessages(appointment);

    if (!appointment.reminders.dayBeforeSentAt) {
      const createdMs = Date.parse(appointment.createdAt || "");
      const hadTimeForDayBefore = Number.isFinite(createdMs) ? createdMs <= dayBeforeTriggerMs : true;
      const dueNow = nowMs >= dayBeforeTriggerMs && nowMs < consultMs;
      if (hadTimeForDayBefore && dueNow) {
        const sent = await sendWhatsAppMessage(phone, reminders.dayBefore, {
          type: "reminder_day_before",
          appointmentId: appointment.id,
        });
        if (sent.ok) {
          appointment.reminders.dayBeforeSentAt = new Date().toISOString();
          changed = true;
        }
      }
    }

    if (!appointment.reminders.oneHourSentAt) {
      const dueNow = nowMs >= oneHourBeforeMs && nowMs < consultMs;
      if (dueNow) {
        const sent = await sendWhatsAppMessage(phone, reminders.oneHour, {
          type: "reminder_one_hour",
          appointmentId: appointment.id,
        });
        if (sent.ok) {
          appointment.reminders.oneHourSentAt = new Date().toISOString();
          changed = true;
        }
      }
    }
  }

  if (changed) {
    await writeAppointments(db);
  }
}

function startReminderWorker() {
  setInterval(() => {
    runAppointmentReminderCycle().catch((err) => {
      console.error("[OrtoguIA] Erro no ciclo de lembretes WhatsApp:", err.message || err);
    });
  }, Math.max(15_000, REMINDER_TICK_MS));
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
      return res.status(401).json({ ok: false, error: "Token JWT inválido" });
    }
  }

  return res.status(401).json({ ok: false, error: "JWT obrigatório para repositório" });
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

// Página de captura (scanner HID tipo teclado)
app.get("/scanner/capture", async (_req, res) => {
  const html = await readScannerCapturePageHtml();
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(200).send(html);
});

app.get("/api/scanner/captures", async (req, res) => {
  try {
    const limitRaw = Number(req.query.limit || 20);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, Math.floor(limitRaw))) : 20;
    const db = await readScannerCaptures();
    return res.json({ ok: true, data: { items: db.items.slice(-limit) } });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || "Erro ao ler histórico de capturas" });
  }
});

app.post("/api/scanner/capture", async (req, res) => {
  try {
    const body = req.body || {};
    const rawInput = String(body.rawInput || body.numeroAtendimento || "").trim();
    const source = String(body.source || "scanner-hid").trim() || "scanner-hid";
    const checked = validateAttendanceNumber(rawInput);
    if (!checked.ok) {
      return res.status(400).json({ ok: false, error: checked.error, data: { rawInput, normalized: checked.normalized } });
    }

    const capture = {
      id: "cap_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      numeroAtendimento: checked.normalized,
      rawInput,
      source,
      capturedAt: new Date().toISOString(),
    };
    await appendScannerCapture(capture);

    return res.json({
      ok: true,
      data: {
        id: capture.id,
        numeroAtendimento: capture.numeroAtendimento,
        source: capture.source,
        capturedAt: capture.capturedAt,
      },
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || "Erro ao capturar número de atendimento" });
  }
});

app.post("/api/scanner/capture-and-link", async (req, res) => {
  try {
    const body = req.body || {};
    const processoId = String(body.processoId || "").trim();
    const rawInput = String(body.rawInput || body.numeroAtendimento || "").trim();
    const source = String(body.source || "scanner-hid").trim() || "scanner-hid";

    const checked = validateAttendanceNumber(rawInput);
    if (!checked.ok) {
      return res.status(400).json({ ok: false, error: checked.error, data: { rawInput, normalized: checked.normalized } });
    }

    const capture = {
      id: "cap_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      numeroAtendimento: checked.normalized,
      rawInput,
      source,
      capturedAt: new Date().toISOString(),
    };
    await appendScannerCapture(capture);

    const mvResult = await findMvPatientByAttendance(checked.normalized);
    const patient = mvResult && mvResult.patient ? mvResult.patient : null;
    const processLinksDb = await readProcessLinks();
    const rules = evaluateAutoLinkRules({
      processoId,
      patient,
      existingLinks: processLinksDb.items,
    });

    if (!rules.allowed) {
      return res.json({
        ok: true,
        data: {
          linked: false,
          capture,
          mv: {
            found: !!patient,
            source: (mvResult && mvResult.source) || resolveMvMode(),
            patient,
          },
          autoLink: {
            allowed: false,
            reasons: rules.reasons,
            rules: {
              requireFound: AUTO_LINK_REQUIRE_FOUND,
              requireProcessId: AUTO_LINK_REQUIRE_PROCESS_ID,
              requirePatientName: AUTO_LINK_REQUIRE_PATIENT_NAME,
              blockDuplicateInProcess: AUTO_LINK_BLOCK_DUPLICATE_IN_PROCESS,
            },
          },
        },
      });
    }

    const link = buildProcessLink({
      processoId,
      numeroAtendimento: checked.normalized,
      pacienteIdMv: String(patient.pacienteIdMv || "").trim(),
      pacienteNome: String(patient.nome || "").trim(),
    });
    await appendProcessLink(link);

    return res.json({
      ok: true,
      data: {
        linked: true,
        capture,
        mv: {
          found: true,
          source: mvResult.source,
          patient,
        },
        autoLink: {
          allowed: true,
          reasons: [],
        },
        link,
      },
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || "Erro no fluxo de captura e vínculo" });
  }
});

app.get("/api/mv/pacientes/:numeroAtendimento", async (req, res) => {
  try {
    const numeroAtendimento = normalizeAttendanceNumber(req.params.numeroAtendimento);
    const checked = validateAttendanceNumber(numeroAtendimento);
    if (!checked.ok) {
      return res.status(400).json({ ok: false, error: checked.error });
    }

    const result = await findMvPatientByAttendance(checked.normalized);
    if (!result || !result.patient) {
      const source = (result && result.source) || resolveMvMode();
      return res.json({
        ok: true,
        data: {
          found: false,
          numeroAtendimento: checked.normalized,
          patient: null,
          source,
          message:
            source === "mock"
              ? "Paciente não localizado no mock MV. Configure data/mv-mock-patients.json para teste local."
              : "Paciente não localizado no MV remoto para este número de atendimento.",
        },
      });
    }

    return res.json({
      ok: true,
      data: {
        found: true,
        numeroAtendimento: checked.normalized,
        source: result.source,
        patient: result.patient,
      },
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || "Erro ao consultar paciente no MV" });
  }
});

app.get("/api/mv/status", (_req, res) => {
  const mode = resolveMvMode();
  const fieldMap = resolveMvFieldMap();
  return res.json({
    ok: true,
    data: {
      mode,
      provider: MV_PROVIDER,
      authType: MV_AUTH_TYPE,
      authHeaderName: MV_AUTH_HEADER_NAME,
      baseUrlConfigured: !!MV_BASE_URL,
      tokenConfigured: !!MV_TOKEN,
      timeoutMs: MV_TIMEOUT_MS,
      retryCount: MV_RETRY_COUNT,
      patientByAtendimentoPath: MV_PATIENT_BY_ATTENDIMENTO_PATH,
      patientPayloadPath: MV_PATIENT_PAYLOAD_PATH || null,
      fieldMap,
      autoLinkRules: {
        requireFound: AUTO_LINK_REQUIRE_FOUND,
        requireProcessId: AUTO_LINK_REQUIRE_PROCESS_ID,
        requirePatientName: AUTO_LINK_REQUIRE_PATIENT_NAME,
        blockDuplicateInProcess: AUTO_LINK_BLOCK_DUPLICATE_IN_PROCESS,
      },
    },
  });
});

app.post("/api/mv/map-preview", (req, res) => {
  try {
    const body = req.body || {};
    const numeroAtendimento = normalizeAttendanceNumber(body.numeroAtendimento || "000000");
    const payload = body.payload;
    const payloadPath = String(body.payloadPath || "").trim();
    const fieldMap = body.fieldMap && typeof body.fieldMap === "object" ? body.fieldMap : null;

    if (!payload || typeof payload !== "object") {
      return res.status(400).json({ ok: false, error: "payload JSON é obrigatório em body.payload" });
    }

    const extracted = payloadPath
      ? getByPath(payload, payloadPath)
      : extractPatientFromMvPayload(payload);

    if (!extracted || typeof extracted !== "object") {
      return res.status(400).json({
        ok: false,
        error: "Não foi possível extrair objeto de paciente do payload",
        data: {
          payloadPathUsed: payloadPath || MV_PATIENT_PAYLOAD_PATH || "(auto)",
        },
      });
    }

    const normalized = normalizeMvPatientWithFieldMap(extracted, numeroAtendimento, fieldMap);
    const effectiveFieldMap = fieldMap && typeof fieldMap === "object" ? {
      numeroAtendimento: coercePathList(fieldMap.numeroAtendimento, resolveMvFieldMap().numeroAtendimento),
      pacienteIdMv: coercePathList(fieldMap.pacienteIdMv, resolveMvFieldMap().pacienteIdMv),
      nome: coercePathList(fieldMap.nome, resolveMvFieldMap().nome),
      nascimento: coercePathList(fieldMap.nascimento, resolveMvFieldMap().nascimento),
      convenio: coercePathList(fieldMap.convenio, resolveMvFieldMap().convenio),
      unidade: coercePathList(fieldMap.unidade, resolveMvFieldMap().unidade),
    } : resolveMvFieldMap();

    return res.json({
      ok: true,
      data: {
        payloadPathUsed: payloadPath || MV_PATIENT_PAYLOAD_PATH || "(auto)",
        effectiveFieldMap,
        extracted,
        normalizedPatient: normalized,
      },
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || "Erro ao pré-visualizar mapeamento MV" });
  }
});

app.post("/api/processos/:processoId/vincular-paciente", async (req, res) => {
  try {
    const processoId = String(req.params.processoId || "").trim();
    const body = req.body || {};
    const checked = validateAttendanceNumber(body.numeroAtendimento || "");
    const pacienteIdMv = String(body.pacienteIdMv || "").trim();
    const pacienteNome = String(body.pacienteNome || "").trim();

    if (!processoId) {
      return res.status(400).json({ ok: false, error: "processoId é obrigatório" });
    }
    if (!checked.ok) {
      return res.status(400).json({ ok: false, error: checked.error });
    }
    if (!pacienteIdMv) {
      return res.status(400).json({ ok: false, error: "pacienteIdMv é obrigatório" });
    }

    const processLinksDb = await readProcessLinks();
    const rules = evaluateAutoLinkRules({
      processoId,
      patient: {
        pacienteIdMv,
        nome: pacienteNome,
      },
      existingLinks: processLinksDb.items,
    });
    if (!rules.allowed) {
      return res.status(409).json({ ok: false, error: "Regras de vínculo não atendidas", data: { reasons: rules.reasons } });
    }

    const link = buildProcessLink({
      processoId,
      numeroAtendimento: checked.normalized,
      pacienteIdMv,
      pacienteNome,
    });

    await appendProcessLink(link);
    return res.json({ ok: true, data: link });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || "Erro ao vincular paciente ao processo" });
  }
});

// Scanner USB (WIA no Windows)
app.use("/api/scanner/files", express.static(SCAN_DIR));

app.get("/api/scanner/status", async (_req, res) => {
  try {
    if (!SCANNER_ENABLED) {
      return res.status(503).json({ ok: false, error: "Scanner desativado por configuração (SCANNER_ENABLED=false)" });
    }

    const scanners = await listWiaScanners();
    const diagnostics = await getScannerDiagnostics();
    return res.json({
      ok: true,
      data: {
        platform: process.platform,
        scannerEnabled: SCANNER_ENABLED,
        scanners,
        scannerFound: scanners.length > 0,
        diagnostics,
      },
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || "Erro ao consultar scanner" });
  }
});

app.post("/api/scanner/repair-wia", async (_req, res) => {
  try {
    if (!SCANNER_ENABLED) {
      return res.status(503).json({ ok: false, error: "Scanner desativado por configuração (SCANNER_ENABLED=false)" });
    }

    const repair = await tryStartWiaService();
    const diagnostics = await getScannerDiagnostics();
    const scanners = await listWiaScanners();

    return res.json({
      ok: true,
      data: {
        repair,
        diagnostics,
        scanners,
        scannerFound: scanners.length > 0,
      },
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || "Erro ao reparar serviço WIA" });
  }
});

app.post("/api/scanner/scan", async (req, res) => {
  try {
    if (!SCANNER_ENABLED) {
      return res.status(503).json({ ok: false, error: "Scanner desativado por configuração (SCANNER_ENABLED=false)" });
    }

    const fileNameHint = (req.body || {}).fileName || "scan";
    const preferredDeviceId = String((req.body || {}).deviceId || "").trim();
    const outputPath = buildScanFilePath(fileNameHint);
    await scanFirstWiaDevice(outputPath, preferredDeviceId);

    const stat = await fs.stat(outputPath);
    const fileName = path.basename(outputPath);
    return res.json({
      ok: true,
      data: {
        fileName,
        sizeBytes: stat.size,
        savedAt: outputPath,
        url: `/api/scanner/files/${encodeURIComponent(fileName)}`,
      },
    });
  } catch (err) {
    const status = err.status || 500;
    return res.status(status).json({ ok: false, error: err.message || "Erro ao digitalizar documento" });
  }
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
    const requestedProfile = String(body.profile || "").trim().toLowerCase();
    const lgpdAccepted = !!body.lgpdAccepted;

    if (!email || !password) {
      return res.status(400).json({ ok: false, error: "email e password são obrigatórios" });
    }
    if (!lgpdAccepted) {
      return res.status(400).json({ ok: false, error: "Aceite LGPD é obrigatório" });
    }

    const user = authUsers.find((u) => u.email === email);
    if (!user || !user.password || user.password !== password) {
      return res.status(401).json({ ok: false, error: "Credenciais inválidas" });
    }
    if (requestedProfile && user.role !== requestedProfile) {
      return res.status(403).json({ ok: false, error: "Perfil não autorizado para este login" });
    }
    if (user.role !== "medico" && user.role !== "secretaria") {
      return res.status(403).json({ ok: false, error: "Perfil não permitido" });
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
 * Disponibilidade de agenda (consulta presencial ou teleconsulta).
 * GET /api/agenda/availability?date=YYYY-MM-DD&mode=teleconsulta|presencial
 */
app.get("/api/agenda/availability", async (req, res) => {
  try {
    const modeRaw = String(req.query.mode || "teleconsulta").trim().toLowerCase();
    const mode = modeRaw === "presencial" ? "presencial" : "teleconsulta";
    const requestedDate = String(req.query.date || "").trim();
    const today = isoDateFromParts(getSaoPauloParts(new Date()));
    const dateIso = /^\d{4}-\d{2}-\d{2}$/.test(requestedDate) ? requestedDate : today;
    const db = await readAppointments();
    const slots = buildAvailableSlots(dateIso, mode, db.appointments);
    res.json({
      ok: true,
      data: {
        date: dateIso,
        mode,
        slots,
      },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || "Erro ao consultar disponibilidade" });
  }
});

/**
 * Criação de consulta na agenda (origem manual, telefone, front etc).
 * POST /api/agenda/appointments
 * body: { patientName, phone, consultAt, mode, reason, source }
 */
app.post("/api/agenda/appointments", async (req, res) => {
  try {
    const body = req.body || {};
    const patientName = String(body.patientName || "Paciente").trim() || "Paciente";
    const phone = normalizePhoneBR(body.phone || body.telefone);
    const modeRaw = String(body.mode || "presencial").trim().toLowerCase();
    const mode = modeRaw === "teleconsulta" ? "teleconsulta" : "presencial";
    const reason = String(body.reason || "Consulta ortopédica").trim() || "Consulta ortopédica";
    const consultAt = String(body.consultAt || "").trim();

    if (!consultAt || !Number.isFinite(Date.parse(consultAt))) {
      return res.status(400).json({ ok: false, error: "consultAt inválido. Use data ISO." });
    }

    const db = await readAppointments();
    const consultMs = Date.parse(consultAt);
    const exists = db.appointments.some(
      (a) => String(a.mode || "") === mode && Date.parse(a.consultAt || "") === consultMs
    );
    if (exists) {
      return res.status(409).json({ ok: false, error: "Horário já ocupado para essa modalidade" });
    }

    const appointment = {
      id: "apt_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      patientName,
      phone,
      reason,
      mode,
      consultAt: new Date(consultAt).toISOString(),
      source: String(body.source || "manual").trim() || "manual",
      status: "agendado",
      reminders: {
        dayBeforeSentAt: null,
        oneHourSentAt: null,
      },
      createdAt: new Date().toISOString(),
    };
    db.appointments.push(appointment);
    await writeAppointments(db);
    res.json({ ok: true, data: appointment });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || "Erro ao criar agendamento" });
  }
});

/**
 * Lista agenda para auditoria e conferência.
 * GET /api/agenda/appointments
 */
app.get("/api/agenda/appointments", async (_req, res) => {
  try {
    const db = await readAppointments();
    const sorted = [...db.appointments].sort(
      (a, b) => Date.parse(a.consultAt || 0) - Date.parse(b.consultAt || 0)
    );
    res.json({ ok: true, data: { appointments: sorted } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || "Erro ao listar agenda" });
  }
});

/**
 * Webhook de verificação (ex.: Meta WhatsApp Cloud).
 * GET /api/whatsapp/webhook
 */
app.get("/api/whatsapp/webhook", (req, res) => {
  const mode = String(req.query["hub.mode"] || "");
  const token = String(req.query["hub.verify_token"] || "");
  const challenge = String(req.query["hub.challenge"] || "");
  if (mode === "subscribe" && WHATSAPP_WEBHOOK_VERIFY_TOKEN && token === WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.status(403).send("forbidden");
});

/**
 * Webhook de entrada de mensagens WhatsApp.
 * POST /api/whatsapp/webhook
 */
app.post("/api/whatsapp/webhook", async (req, res) => {
  try {
    if (!shouldAuthorizeInbound(req)) {
      return res.status(401).json({ ok: false, error: "Webhook não autorizado" });
    }
    const body = req.body || {};
    const messages = extractIncomingMessages(body);
    let processed = 0;
    for (const msg of messages) {
      await appendOutboxLog({ direction: "inbound", payload: msg });
      await processInboundWhatsappMessage(msg);
      processed += 1;
    }
    return res.json({ ok: true, data: { processed } });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || "Erro no webhook de WhatsApp" });
  }
});

/**
 * Endpoint de teste local para simular mensagem recebida.
 * POST /api/whatsapp/inbound-test
 * body: { from, text, name }
 */
app.post("/api/whatsapp/inbound-test", async (req, res) => {
  try {
    const from = normalizePhoneBR((req.body || {}).from);
    const text = String((req.body || {}).text || "").trim();
    const name = String((req.body || {}).name || "").trim();
    if (!from || !text) {
      return res.status(400).json({ ok: false, error: "from e text são obrigatórios" });
    }
    const result = await processInboundWhatsappMessage({ from, text, name });
    return res.json({ ok: true, data: result });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || "Erro no teste de inbound" });
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
startReminderWorker();

server.listen(PORT, () => {
  console.log(`[OrtoguIA] Backend de agentes rodando em http://localhost:${PORT}`);
  console.log(`[OrtoguIA] WebSocket de transcrição em ws://localhost:${PORT}/ws/transcribe`);
  console.log(`[OrtoguIA] Agentes:`, listAgents().map((a) => a.id).join(", "));
});
