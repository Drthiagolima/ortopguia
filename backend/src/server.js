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
const WHATSAPP_SEND_URL = String(process.env.WHATSAPP_SEND_URL || "").trim();
const WHATSAPP_SEND_TOKEN = String(process.env.WHATSAPP_SEND_TOKEN || "").trim();
const WHATSAPP_FROM = String(process.env.WHATSAPP_FROM || "").trim();

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

async function sendWhatsAppMessage(to, text, metadata = {}) {
  const phone = normalizePhoneBR(to);
  if (!phone) return { ok: false, error: "Telefone inválido" };
  const payload = {
    from: WHATSAPP_FROM || undefined,
    to: phone,
    text: String(text || ""),
    metadata,
  };

  if (!WHATSAPP_SEND_URL) {
    await appendOutboxLog({ direction: "outbound", provider: "mock", payload });
    return { ok: true, mock: true };
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
