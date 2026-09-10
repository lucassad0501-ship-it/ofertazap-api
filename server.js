import "dotenv/config";
import express from "express";
import cors from "cors";
import cron from "node-cron";
import QRCode from "qrcode";
import pino from "pino";
import { randomUUID } from "node:crypto";
import { Boom } from "@hapi/boom";

import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore
} from "@whiskeysockets/baileys";

import fs from "node:fs";
import path from "node:path";

const app = express();

const PORT = Number(process.env.PORT || 3000);
const API_TOKEN = process.env.API_TOKEN || "";
const TZ = process.env.TZ || "America/Sao_Paulo";

app.use(
  cors({
    origin: process.env.FRONTEND_ORIGIN || "*"
  })
);

app.use(
  express.json({
    limit: "1mb"
  })
);

// ======================================================
// DIRETÓRIOS
// ======================================================

const DATA_DIR = path.resolve("./data");
const AUTH_DIR = path.resolve("./auth_info_baileys");

fs.mkdirSync(DATA_DIR, {
  recursive: true
});

fs.mkdirSync(AUTH_DIR, {
  recursive: true
});

// ======================================================
// ARQUIVOS
// ======================================================

const GROUPS_FILE = path.join(DATA_DIR, "groups.json");
const JOBS_FILE = path.join(DATA_DIR, "jobs.json");

// ======================================================
// FUNÇÕES DE ARQUIVO
// ======================================================

function loadJson(file, fallback = []) {
  try {
    if (!fs.existsSync(file)) {
      return fallback;
    }

    return JSON.parse(
      fs.readFileSync(file, "utf8")
    );
  } catch (err) {
    console.error(
      "Erro ao ler arquivo:",
      file,
      err.message
    );

    return fallback;
  }
}

function saveJson(file, data) {
  fs.writeFileSync(
    file,
    JSON.stringify(data, null, 2),
    "utf8"
  );
}

// ======================================================
// ESTADO DO SISTEMA
// ======================================================

let groups = loadJson(
  GROUPS_FILE,
  []
);

let jobs = loadJson(
  JOBS_FILE,
  []
);

let sock = null;

let qrDataUrl = null;

let connectionState = "disconnected";

let lastError = null;

// ======================================================
// LIMPAR SESSÃO DO WHATSAPP
// ======================================================

function resetWhatsAppAuth() {
  try {
    if (fs.existsSync(AUTH_DIR)) {
      for (const name of fs.readdirSync(AUTH_DIR)) {
        fs.rmSync(
          path.join(AUTH_DIR, name),
          {
            recursive: true,
            force: true
          }
        );
      }
    }

    qrDataUrl = null;

    console.log(
      "Sessão do WhatsApp limpa. Um novo QR será gerado."
    );
  } catch (err) {
    lastError =
      "Falha ao limpar sessão do WhatsApp: " +
      err.message;

    console.error(lastError);
  }
}

// ======================================================
// AUTENTICAÇÃO DA API
// ======================================================

function authMiddleware(req, res, next) {
  if (!API_TOKEN) {
    return res.status(503).json({
      error:
        "API_TOKEN não configurado no servidor"
    });
  }

  const authorization =
    req.headers.authorization || "";

  const bearer =
    authorization.startsWith("Bearer ")
      ? authorization.slice(7)
      : "";

  const token =
    bearer ||
    req.headers["x-api-token"] ||
    "";

  if (token !== API_TOKEN) {
    return res.status(401).json({
      error: "Token inválido"
    });
  }

  next();
}

// ======================================================
// ROTAS BÁSICAS
// ======================================================

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "OfertaZap API",
    status: connectionState,
    health: "/api/health"
  });
});

// ======================================================
// HEALTH
// ======================================================

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "OfertaZap API",
    time: new Date().toISOString()
  });
});

// Todas as outras rotas /api precisam do token
app.use(
  "/api",
  authMiddleware
);

// ======================================================
// STATUS
// ======================================================

app.get("/api/status", (_req, res) => {
  res.json({
    ok: true,
    whatsapp: connectionState,
    qrAvailable: Boolean(qrDataUrl),
    groups: groups.length,
    jobs: jobs.length,
    lastError
  });
});

// ======================================================
// QR CODE
// ======================================================

app.get(
  "/api/whatsapp/qr",
  (_req, res) => {
    if (!qrDataUrl) {
      return res.status(404).json({
        error:
          "QR Code ainda não disponível"
      });
    }

    res.json({
      ok: true,
      qr: qrDataUrl
    });
  }
);

// ======================================================
// INICIAR WHATSAPP
// ======================================================

async function startWhatsApp() {
  if (
    connectionState === "connecting" ||
    connectionState === "connected"
  ) {
    return;
  }

  connectionState = "connecting";
  qrDataUrl = null;
  lastError = null;

  try {
    const {
      state,
      saveCreds
    } = await useMultiFileAuthState(
      AUTH_DIR
    );

    let version;

    try {
      const latest =
        await fetchLatestBaileysVersion();

      version = latest.version;

      console.log(
        "Versão Baileys/WhatsApp:",
        version.join(".")
      );
    } catch (err) {
      console.warn(
        "Não foi possível obter a versão mais recente. Usando a versão padrão do pacote."
      );
    }

    const socketOptions = {
      logger: pino({
        level: "silent"
      }),

      auth: {
        creds: state.creds,

        keys:
          makeCacheableSignalKeyStore(
            state.keys,
            pino({
              level: "silent"
            })
          )
      },

      printQRInTerminal: false,

      browser: [
        "OfertaZap",
        "Chrome",
        "1.0.0"
      ],

      generateHighQualityLinkPreview:
        false
    };

    if (version) {
      socketOptions.version = version;
    }

    sock =
      makeWASocket(
        socketOptions
      );

    sock.ev.on(
      "creds.update",
      saveCreds
    );

    sock.ev.on(
      "connection.update",
      async ({
        connection,
        lastDisconnect,
        qr
      }) => {
        try {
          // ==========================================
          // QR RECEBIDO
          // ==========================================

          if (qr) {
            console.log(
              "QR recebido do WhatsApp."
            );

            qrDataUrl =
              await QRCode.toDataURL(
                qr,
                {
                  width: 420,
                  margin: 2
                }
              );

            connectionState =
              "connecting";
          }

          // ==========================================
          // CONECTADO
          // ==========================================

          if (
            connection === "open"
          ) {
            connectionState =
              "connected";

            qrDataUrl = null;
            lastError = null;

            console.log(
              "WhatsApp conectado."
            );

            return;
          }

          // ==========================================
          // DESCONECTADO
          // ==========================================

          if (
            connection === "close"
          ) {
            connectionState =
              "disconnected";

            const error =
              lastDisconnect?.error;

            const code =
              new Boom(error)
                ?.output
                ?.statusCode;

            const reason = String(
              code ||
                error?.message ||
                "Conexão encerrada"
            );

            lastError = reason;

            console.error(
              "WhatsApp desconectado:",
              reason
            );

            // ========================================
            // LOGOUT / SESSÃO INVÁLIDA
            // ========================================

            if (
              code ===
                DisconnectReason.loggedOut ||
              code === 401
            ) {
              console.log(
                "Sessão anterior inválida/desconectada. Limpando credenciais..."
              );

              resetWhatsAppAuth();

              setTimeout(() => {
                startWhatsApp()
                  .catch(err => {
                    lastError =
                      err.message;

                    connectionState =
                      "disconnected";

                    console.error(
                      "Erro ao reiniciar após logout:",
                      err.message
                    );
                  });
              }, 1500);

              return;
            }

            // ========================================
            // OUTRAS DESCONECTADAS
            // ========================================

            setTimeout(() => {
              startWhatsApp()
                .catch(err => {
                  lastError =
                    err.message;

                  connectionState =
                    "disconnected";

                  console.error(
                    "Erro ao reconectar:",
                    err.message
                  );
                });
            }, 5000);
          }
        } catch (err) {
          lastError =
            err.message;

          console.error(
            "connection.update:",
            err.message
          );
        }
      }
    );
  } catch (err) {
    connectionState =
      "disconnected";

    lastError =
      err.message;

    console.error(
      "Falha ao iniciar WhatsApp:",
      err.message
    );

    throw err;
  }
}

// ======================================================
// START WHATSAPP
// ======================================================

app.post(
  "/api/whatsapp/start",
  async (_req, res) => {
    try {
      await startWhatsApp();

      // Pequena espera para tentar capturar o QR
      await new Promise(
        resolve =>
          setTimeout(resolve, 500)
      );

      res.json({
        ok: true,

        status:
          connectionState,

        qrAvailable:
          Boolean(qrDataUrl),

        message: qrDataUrl
          ? "QR Code disponível"
          : "WhatsApp iniciado. Aguardando QR ou reconexão."
      });
    } catch (err) {
      lastError =
        err.message;

      connectionState =
        "disconnected";

      res.status(500).json({
        error: err.message
      });
    }
  }
);

// ======================================================
// RESET WHATSAPP
// ======================================================

app.post(
  "/api/whatsapp/reset",
  async (_req, res) => {
    try {
      if (sock) {
        try {
          sock.end(
            undefined
          );
        } catch {}

        sock = null;
      }

      connectionState =
        "disconnected";

      lastError = null;

      resetWhatsAppAuth();

      res.json({
        ok: true,

        message:
          "Sessão do WhatsApp limpa. Agora inicie o WhatsApp para gerar um novo QR."
      });
    } catch (err) {
      lastError =
        err.message;

      res.status(500).json({
        error: err.message
      });
    }
  }
);

// ======================================================
// EXTRAIR CÓDIGO DO LINK DO GRUPO
// ======================================================

function extractInviteCode(
  value
) {
  const match =
    String(value || "").match(
      /chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/i
    );

  return (
    match?.[1] ||
    null
  );
}

// ======================================================
// LISTAR GRUPOS
// ======================================================

app.get(
  "/api/groups",
  (_req, res) => {
    res.json({
      ok: true,
      groups
    });
  }
);

// ======================================================
// CADASTRAR GRUPO
// ======================================================

app.post(
  "/api/groups",
  async (req, res) => {
    const {
      name,
      inviteLink,
      jid
    } = req.body || {};

    if (
      !name &&
      !inviteLink &&
      !jid
    ) {
      return res.status(400).json({
        error:
          "Informe name, inviteLink ou jid"
      });
    }

    let groupJid =
      jid || null;

    let groupName =
      name ||
      "Grupo WhatsApp";

    try {
      if (!sock) {
        return res.status(409).json({
          error:
            "WhatsApp não está conectado"
        });
      }

      // ==========================================
      // USANDO LINK DE CONVITE
      // ==========================================

      if (
        !groupJid &&
        inviteLink
      ) {
        const code =
          extractInviteCode(
            inviteLink
          );

        if (!code) {
          return res.status(400).json({
            error:
              "Link de convite inválido"
          });
        }

        const info =
          await sock.groupGetInviteInfo(
            code
          );

        groupJid =
          info.id;

        groupName =
          name ||
          info.subject ||
          groupName;

        try {
          await sock.groupAcceptInvite(
            code
          );
        } catch {}
      }

      // ==========================================
      // SALVAR GRUPO
      // ==========================================

      const item = {
        id: randomUUID(),

        name: groupName,

        jid: groupJid,

        inviteLink:
          inviteLink || null,

        createdAt:
          new Date().toISOString()
      };

      groups.push(item);

      saveJson(
        GROUPS_FILE,
        groups
      );

      res.json({
        ok: true,
        group: item
      });
    } catch (err) {
      res.status(400).json({
        error: err.message
      });
    }
  }
);

// ======================================================
// EXCLUIR GRUPO
// ======================================================

app.delete(
  "/api/groups/:id",
  (req, res) => {
    const before =
      groups.length;

    groups =
      groups.filter(
        g =>
          g.id !==
          req.params.id
      );

    saveJson(
      GROUPS_FILE,
      groups
    );

    res.json({
      ok: true,

      removed:
        before !==
        groups.length
    });
  }
);

// ======================================================
// LISTAR AGENDAMENTOS
// ======================================================

app.get(
  "/api/jobs",
  (_req, res) => {
    res.json({
      ok: true,
      jobs
    });
  }
);

// ======================================================
// CRIAR AGENDAMENTO
// ======================================================

app.post(
  "/api/jobs",
  (req, res) => {
    const {
      groupId,
      message,
      scheduledAt,
      repeat
    } = req.body || {};

    // ==========================================
    // VALIDAÇÃO
    // ==========================================

    if (
      !groupId ||
      !message ||
      !scheduledAt
    ) {
      return res.status(400).json({
        error:
          "groupId, message e scheduledAt são obrigatórios"
      });
    }

    // ==========================================
    // REPETIÇÃO
    // ==========================================

    const repeatType =
      repeat || "unica";

    const allowedRepeat = [
      "unica",
      "diaria",
      "semanal"
    ];

    if (
      !allowedRepeat.includes(
        repeatType
      )
    ) {
      return res.status(400).json({
        error:
          "Repetição inválida. Use unica, diaria ou semanal."
      });
    }

    // ==========================================
    // LOCALIZAR GRUPO
    // ==========================================

    const group =
      groups.find(
        g =>
          g.id ===
          groupId
      );

    if (!group) {
      return res.status(404).json({
        error:
          "Grupo não encontrado"
      });
    }

    // ==========================================
    // VALIDAR DATA
    // ==========================================

    const date =
      new Date(
        scheduledAt
      );

    if (
      !Number.isFinite(
        date.getTime()
      )
    ) {
      return res.status(400).json({
        error:
          "scheduledAt inválido"
      });
    }

    // ==========================================
    // CRIAR JOB
    // ==========================================

    const job = {
      id: randomUUID(),

      groupId,

      message,

      scheduledAt,

      repeat: repeatType,

      status: "pending",

      createdAt:
        new Date().toISOString(),

      lastStatus: null,

      lastError: null,

      sentAt: null
    };

    jobs.push(job);

    saveJson(
      JOBS_FILE,
      jobs
    );

    res.json({
      ok: true,
      job
    });
  }
);

// ======================================================
// CALCULAR PRÓXIMA DATA DA REPETIÇÃO
// ======================================================

function getNextScheduledAt(
  scheduledAt,
  repeat
) {
  const date =
    new Date(
      scheduledAt
    );

  if (
    !Number.isFinite(
      date.getTime()
    )
  ) {
    throw new Error(
      "Data de agendamento inválida"
    );
  }

  if (
    repeat === "diaria"
  ) {
    date.setDate(
      date.getDate() + 1
    );
  }

  if (
    repeat === "semanal"
  ) {
    date.setDate(
      date.getDate() + 7
    );
  }

  return date.toISOString();
}

// ======================================================
// ENVIAR AGENDAMENTO
// ======================================================

async function sendJob(
  job
) {
  const group =
    groups.find(
      g =>
        g.id ===
        job.groupId
    );

  if (!group?.jid) {
    throw new Error(
      "Grupo sem JID"
    );
  }

  if (
    !sock ||
    connectionState !==
      "connected"
  ) {
    throw new Error(
      "WhatsApp não conectado"
    );
  }

  // ==========================================
  // ENVIO
  // ==========================================

  await sock.sendMessage(
    group.jid,
    {
      text: job.message
    }
  );

  const sentAt =
    new Date().toISOString();

  job.sentAt =
    sentAt;

  job.lastStatus =
    "sent";

  job.lastError =
    null;

  // ==========================================
  // REPETIÇÃO DIÁRIA / SEMANAL
  // ==========================================

  if (
    job.repeat ===
      "diaria" ||
    job.repeat ===
      "semanal"
  ) {
    job.scheduledAt =
      getNextScheduledAt(
        job.scheduledAt,
        job.repeat
      );

    job.status =
      "pending";

    console.log(
      `Agendamento repetitivo atualizado: ${job.id} -> ${job.scheduledAt}`
    );
  } else {
    // ========================================
    // ENVIO ÚNICO
    // ========================================

    job.status =
      "sent";

    console.log(
      `Agendamento enviado: ${job.id}`
    );
  }
}

// ======================================================
// ENVIAR AGENDAMENTO MANUALMENTE
// ======================================================

app.post(
  "/api/jobs/:id/send",
  async (req, res) => {
    const job =
      jobs.find(
        j =>
          j.id ===
          req.params.id
      );

    if (!job) {
      return res.status(404).json({
        error:
          "Agendamento não encontrado"
      });
    }

    try {
      await sendJob(
        job
      );

      saveJson(
        JOBS_FILE,
        jobs
      );

      res.json({
        ok: true,
        job
      });
    } catch (err) {
      job.status =
        "error";

      job.error =
        err.message;

      job.lastError =
        err.message;

      saveJson(
        JOBS_FILE,
        jobs
      );

      res.status(400).json({
        error:
          err.message,
        job
      });
    }
  }
);

// ======================================================
// EXCLUIR AGENDAMENTO
// ======================================================

app.delete(
  "/api/jobs/:id",
  (req, res) => {
    const before =
      jobs.length;

    jobs =
      jobs.filter(
        j =>
          j.id !==
          req.params.id
      );

    saveJson(
      JOBS_FILE,
      jobs
    );

    res.json({
      ok: true,

      removed:
        before !==
        jobs.length
    });
  }
);

// ======================================================
// PAUSAR AGENDAMENTO
// ======================================================

app.post(
  "/api/jobs/:id/pause",
  (req, res) => {
    const job =
      jobs.find(
        j =>
          j.id ===
          req.params.id
      );

    if (!job) {
      return res.status(404).json({
        error:
          "Agendamento não encontrado"
      });
    }

    if (
      job.status ===
      "sent"
    ) {
      return res.status(400).json({
        error:
          "Esse agendamento já foi finalizado"
      });
    }

    job.status =
      "paused";

    saveJson(
      JOBS_FILE,
      jobs
    );

    res.json({
      ok: true,
      job
    });
  }
);

// ======================================================
// RETOMAR AGENDAMENTO
// ======================================================

app.post(
  "/api/jobs/:id/resume",
  (req, res) => {
    const job =
      jobs.find(
        j =>
          j.id ===
          req.params.id
      );

    if (!job) {
      return res.status(404).json({
        error:
          "Agendamento não encontrado"
      });
    }

    job.status =
      "pending";

    job.lastError =
      null;

    saveJson(
      JOBS_FILE,
      jobs
    );

    res.json({
      ok: true,
      job
    });
  }
);

// ======================================================
// PROCESSAR FILA
// ======================================================

async function processJobs() {
  if (
    !sock ||
    connectionState !==
      "connected"
  ) {
    return;
  }

  const now =
    Date.now();

  let changed =
    false;

  for (
    const job of jobs
  ) {
    // Somente pendentes
    if (
      job.status !==
      "pending"
    ) {
      continue;
    }

    const when =
      new Date(
        job.scheduledAt
      ).getTime();

    if (
      !Number.isFinite(
        when
      )
    ) {
      job.status =
        "error";

      job.error =
        "Data do agendamento inválida";

      job.lastError =
        job.error;

      changed = true;

      continue;
    }

    // Ainda não chegou o horário
    if (
      when > now
    ) {
      continue;
    }

    try {
      console.log(
        `Processando agendamento ${job.id}...`
      );

      await sendJob(
        job
      );

      changed = true;
    } catch (err) {
      job.status =
        "error";

      job.error =
        err.message;

      job.lastError =
        err.message;

      changed = true;

      console.error(
        `Erro no agendamento ${job.id}:`,
        err.message
      );
    }
  }

  if (changed) {
    saveJson(
      JOBS_FILE,
      jobs
    );
  }
}

// ======================================================
// SCHEDULER
// Executa a cada minuto
// ======================================================

cron.schedule(
  "* * * * *",
  () => {
    processJobs()
      .catch(err =>
        console.error(
          "Scheduler:",
          err.message
        )
      );
  },
  {
    timezone: TZ
  }
);

// ======================================================
// INICIAR SERVIDOR
// ======================================================

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `OfertaZap API rodando na porta ${PORT}`
    );

    console.log(
      `Timezone: ${TZ}`
    );

    console.log(
      "Repetição: diária e semanal ativadas."
    );
  }
);
