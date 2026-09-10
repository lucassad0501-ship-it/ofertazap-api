
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import QRCode from "qrcode";
import cron from "node-cron";
import fs from "fs";
import path from "path";
import pino from "pino";
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";

dotenv.config();

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT || 3000);
const API_TOKEN = process.env.API_TOKEN || "CHANGE_ME";
const DATA_DIR = process.env.DATA_DIR || "./data";
const AUTH_DIR = process.env.AUTH_DIR || "./auth_info_baileys";

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(AUTH_DIR, { recursive: true });

const GROUPS_FILE = path.join(DATA_DIR, "groups.json");
const JOBS_FILE = path.join(DATA_DIR, "jobs.json");

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallback; }
}
function saveJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

let groups = loadJson(GROUPS_FILE, []);
let jobs = loadJson(JOBS_FILE, []);

let sock = null;
let waStatus = "disconnected";
let qrDataUrl = null;
let lastError = null;
let starting = false;

function auth(req, res, next) {
  if (req.path === "/health") return next();
  const token = req.get("Authorization")?.replace(/^Bearer\s+/i, "") || req.get("X-API-Token");
  if (!API_TOKEN || API_TOKEN === "CHANGE_ME" || token !== API_TOKEN) {
    return res.status(401).json({ error: "Token inválido" });
  }
  next();
}

app.use("/api", auth);

app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "OfertaZap API", time: new Date().toISOString() });
});

app.get("/api/status", (req, res) => {
  res.json({
    ok: true,
    whatsapp: waStatus,
    connected: waStatus === "connected",
    qrAvailable: Boolean(qrDataUrl),
    groups: groups.length,
    jobs: jobs.length,
    lastError
  });
});

app.get("/api/whatsapp/qr", (req, res) => {
  if (!qrDataUrl) return res.status(404).json({ error: "QR indisponível", status: waStatus });
  res.json({ qr: qrDataUrl, status: waStatus });
});

async function startWhatsApp() {
  if (starting || waStatus === "connected") return;
  starting = true;
  lastError = null;
  waStatus = "connecting";

  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: "silent" }),
      printQRInTerminal: false,
      browser: ["OfertaZap", "Chrome", "1.0"]
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        qrDataUrl = await QRCode.toDataURL(qr);
        waStatus = "qr";
      }

      if (connection === "open") {
        waStatus = "connected";
        qrDataUrl = null;
        lastError = null;
        console.log("OfertaZap WhatsApp conectado.");
      }

      if (connection === "close") {
        waStatus = "disconnected";
        qrDataUrl = null;
        const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
        lastError = String(code ?? "connection_closed");
        starting = false;

        if (code !== DisconnectReason.loggedOut) {
          setTimeout(() => startWhatsApp().catch(console.error), 5000);
        }
      }
    });
  } catch (err) {
    waStatus = "error";
    lastError = err?.message || String(err);
    starting = false;
    console.error(err);
  }
  starting = false;
}

app.post("/api/whatsapp/start", async (req, res) => {
  await startWhatsApp();
  res.json({ ok: true, status: waStatus, qrAvailable: Boolean(qrDataUrl) });
});

function inviteCode(link) {
  try {
    const u = new URL(link);
    if (u.hostname !== "chat.whatsapp.com") return null;
    return u.pathname.split("/").filter(Boolean)[0] || null;
  } catch { return null; }
}

app.get("/api/groups", (req, res) => res.json(groups));

app.post("/api/groups", async (req, res) => {
  const name = String(req.body?.name || "").trim();
  const inviteLink = String(req.body?.inviteLink || "").trim();
  if (!name || !inviteLink) return res.status(400).json({ error: "name e inviteLink são obrigatórios" });

  const code = inviteCode(inviteLink);
  if (!code) return res.status(400).json({ error: "Link de convite inválido" });
  if (groups.some(g => g.inviteLink === inviteLink)) return res.status(409).json({ error: "Grupo já cadastrado" });
  if (!sock || waStatus !== "connected") return res.status(409).json({ error: "WhatsApp não conectado" });

  try {
    let jid = null;
    try {
      const info = await sock.groupGetInviteInfo(code);
      jid = info?.id || null;
    } catch {}

    if (!jid) jid = await sock.groupAcceptInvite(code);

    const metadata = await sock.groupMetadata(jid);
    const group = {
      id: crypto.randomUUID(),
      name: name || metadata.subject || "Grupo WhatsApp",
      subject: metadata.subject,
      inviteLink,
      chatId: jid,
      createdAt: new Date().toISOString()
    };
    groups.push(group);
    saveJson(GROUPS_FILE, groups);
    res.status(201).json(group);
  } catch (err) {
    res.status(400).json({ error: err?.message || "Não foi possível entrar/localizar o grupo" });
  }
});

app.post("/api/groups/:id/join", async (req, res) => {
  const group = groups.find(g => g.id === req.params.id);
  if (!group) return res.status(404).json({ error: "Grupo não encontrado" });
  if (!sock || waStatus !== "connected") return res.status(409).json({ error: "WhatsApp não conectado" });
  try {
    const code = inviteCode(group.inviteLink);
    const jid = await sock.groupAcceptInvite(code);
    group.chatId = jid || group.chatId;
    saveJson(GROUPS_FILE, groups);
    res.json(group);
  } catch (err) {
    res.status(400).json({ error: err?.message || "Falha ao entrar no grupo" });
  }
});

app.delete("/api/groups/:id", (req, res) => {
  groups = groups.filter(g => g.id !== req.params.id);
  saveJson(GROUPS_FILE, groups);
  res.json({ ok: true });
});

app.get("/api/jobs", (req, res) => res.json(jobs));

app.post("/api/jobs", (req, res) => {
  const { groupId, message, runAt, repeat = "none" } = req.body || {};
  if (!groupId || !message || !runAt) return res.status(400).json({ error: "groupId, message e runAt são obrigatórios" });
  if (!groups.some(g => g.id === groupId)) return res.status(404).json({ error: "Grupo não encontrado" });

  const job = {
    id: crypto.randomUUID(),
    groupId,
    message: String(message),
    runAt: new Date(runAt).toISOString(),
    repeat,
    sent: false,
    createdAt: new Date().toISOString()
  };
  jobs.push(job);
  saveJson(JOBS_FILE, jobs);
  res.status(201).json(job);
});

async function sendJob(job) {
  const group = groups.find(g => g.id === job.groupId);
  if (!group?.chatId) throw new Error("Grupo sem chatId");
  if (!sock || waStatus !== "connected") throw new Error("WhatsApp não conectado");

  await sock.sendMessage(group.chatId, { text: job.message });
  job.lastSentAt = new Date().toISOString();

  if (job.repeat === "daily") {
    job.runAt = new Date(new Date(job.runAt).getTime() + 86400000).toISOString();
    job.sent = false;
  } else if (job.repeat === "weekly") {
    job.runAt = new Date(new Date(job.runAt).getTime() + 7 * 86400000).toISOString();
    job.sent = false;
  } else {
    job.sent = true;
  }
  saveJson(JOBS_FILE, jobs);
}

app.post("/api/jobs/:id/send", async (req, res) => {
  const job = jobs.find(j => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: "Agendamento não encontrado" });
  try {
    await sendJob(job);
    res.json({ ok: true, job });
  } catch (err) {
    res.status(400).json({ error: err?.message || "Falha ao enviar" });
  }
});

app.delete("/api/jobs/:id", (req, res) => {
  jobs = jobs.filter(j => j.id !== req.params.id);
  saveJson(JOBS_FILE, jobs);
  res.json({ ok: true });
});

cron.schedule("* * * * *", async () => {
  if (!sock || waStatus !== "connected") return;
  const now = Date.now();
  for (const job of jobs.filter(j => !j.sent && new Date(j.runAt).getTime() <= now)) {
    try { await sendJob(job); }
    catch (err) { console.error("Falha no agendamento", job.id, err?.message); }
  }
}, { timezone: process.env.TZ || "America/Sao_Paulo" });

app.listen(PORT, "0.0.0.0", () => {
  console.log(`OfertaZap API rodando na porta ${PORT}`);
});
