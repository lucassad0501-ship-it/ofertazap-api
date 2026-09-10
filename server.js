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

app.use(cors({
  origin: process.env.FRONTEND_ORIGIN || "*"
}));

app.use(express.json({
  limit: "1mb"
}));

const DATA_DIR = path.resolve("./data");
const AUTH_DIR = path.resolve("./auth_info_baileys");

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(AUTH_DIR, { recursive: true });

const GROUPS_FILE = path.join(DATA_DIR, "groups.json");
const JOBS_FILE = path.join(DATA_DIR, "jobs.json");

function loadJson(file, fallback = []) {
  try {
    if (!fs.existsSync(file)) return fallback;

    return JSON.parse(
      fs.readFileSync(file, "utf8")
    );
  } catch {
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

/*
==================================================
 LIMPA A SESSÃO ANTIGA DO WHATSAPP
==================================================
*/

function resetWhatsAppAuth() {

  try {

    if (fs.existsSync(AUTH_DIR)) {

      for (const name of fs.readdirSync(AUTH_DIR)) {

        const filePath = path.join(
          AUTH_DIR,
          name
        );

        fs.rmSync(
          filePath,
          {
            recursive: true,
            force: true
          }
        );

      }

    }

    qrDataUrl = null;

    console.log(
      "Sessão antiga do WhatsApp removida."
    );

  } catch (err) {

    lastError =
      "Erro ao limpar sessão: " +
      err.message;

    console.error(lastError);

  }

}


/*
==================================================
 VARIÁVEIS
==================================================
*/

let groups =
  loadJson(
    GROUPS_FILE,
    []
  );

let jobs =
  loadJson(
    JOBS_FILE,
    []
  );

let sock = null;

let qrDataUrl = null;

let connectionState =
  "disconnected";

let lastError = null;


/*
==================================================
 AUTENTICAÇÃO
==================================================
*/

function authMiddleware(
  req,
  res,
  next
) {

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


/*
==================================================
 ROTAS PÚBLICAS
==================================================
*/

app.get("/", (_req, res) => {

  res.json({

    ok: true,

    service:
      "OfertaZap API",

    status:
      connectionState,

    health:
      "/api/health"

  });

});


app.get(
  "/api/health",
  (_req, res) => {

    res.json({

      ok: true,

      service:
        "OfertaZap API",

      time:
        new Date().toISOString()

    });

  }
);


/*
==================================================
 PROTEÇÃO API
==================================================
*/

app.use(
  "/api",
  authMiddleware
);


/*
==================================================
 STATUS
==================================================
*/

app.get(
  "/api/status",
  (_req, res) => {

    res.json({

      ok: true,

      whatsapp:
        connectionState,

      qrAvailable:
        Boolean(qrDataUrl),

      groups:
        groups.length,

      jobs:
        jobs.length,

      lastError

    });

  }
);


/*
==================================================
 QR CODE
==================================================
*/

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

      qr:
        qrDataUrl

    });

  }
);


/*
==================================================
 INICIAR WHATSAPP
==================================================
*/

async function startWhatsApp() {

  if (
    connectionState === "connecting" ||
    connectionState === "connected"
  ) {

    return;

  }

  connectionState =
    "connecting";

  qrDataUrl =
    null;

  lastError =
    null;


  try {

    const {
      state,
      saveCreds
    } =
      await useMultiFileAuthState(
        AUTH_DIR
      );


    /*
    ----------------------------------------------
    TENTA PEGAR A VERSÃO ATUAL
    ----------------------------------------------
    */

    let version;

    try {

      const latest =
        await fetchLatestBaileysVersion();

      version =
        latest.version;

      console.log(
        "Versão WhatsApp:",
        version.join(".")
      );

    } catch {

      console.log(
        "Usando versão padrão do Baileys."
      );

    }


    /*
    ----------------------------------------------
    CONFIGURAÇÃO SOCKET
    ----------------------------------------------
    */

    const socketOptions = {

      logger:
        pino({
          level: "silent"
        }),

      auth: {

        creds:
          state.creds,

        keys:
          makeCacheableSignalKeyStore(
            state.keys,
            pino({
              level: "silent"
            })
          )

      },

      printQRInTerminal:
        false,

      browser:
        [
          "OfertaZap",
          "Chrome",
          "1.0.0"
        ],

      generateHighQualityLinkPreview:
        false

    };


    if (version) {

      socketOptions.version =
        version;

    }


    /*
    ----------------------------------------------
    CRIA SOCKET
    ----------------------------------------------
    */

    sock =
      makeWASocket(
        socketOptions
      );


    /*
    ----------------------------------------------
    SALVAR CREDENCIAIS
    ----------------------------------------------
    */

    sock.ev.on(
      "creds.update",
      saveCreds
    );


    /*
    ----------------------------------------------
    EVENTOS DO WHATSAPP
    ----------------------------------------------
    */

    sock.ev.on(
      "connection.update",
      async ({
        connection,
        lastDisconnect,
        qr
      }) => {

        try {


          /*
          ==========================================
          RECEBEU QR
          ==========================================
          */

          if (qr) {

            console.log(
              "================================"
            );

            console.log(
              "QR CODE RECEBIDO!"
            );

            console.log(
              "================================"
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


          /*
          ==========================================
          CONECTOU
          ==========================================
          */

          if (
            connection === "open"
          ) {

            connectionState =
              "connected";

            qrDataUrl =
              null;

            lastError =
              null;

            console.log(
              "================================"
            );

            console.log(
              "WHATSAPP CONECTADO!"
            );

            console.log(
              "================================"
            );

            return;

          }


          /*
          ==========================================
          DESCONECTOU
          ==========================================
          */

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


            const reason =
              String(
                code ||
                error?.message ||
                "Conexão encerrada"
              );


            lastError =
              reason;


            console.error(
              "WhatsApp desconectado:",
              reason
            );


            /*
            ========================================
            LOGOUT / SESSÃO INVÁLIDA
            ========================================
            */

            if (
              code ===
                DisconnectReason.loggedOut ||
              code === 401
            ) {

              console.log(
                "Sessão antiga inválida."
              );

              console.log(
                "Limpando credenciais..."
              );


              resetWhatsAppAuth();


              setTimeout(
                () => {

                  startWhatsApp()
                    .catch(err => {

                      lastError =
                        err.message;

                      connectionState =
                        "disconnected";

                      console.error(
                        "Erro ao reiniciar:",
                        err.message
                      );

                    });

                },
                1500
              );


              return;

            }


            /*
            ========================================
            OUTROS ERROS
            ========================================
            */

            setTimeout(
              () => {

                startWhatsApp()
                  .catch(err => {

                    lastError =
                      err.message;

                    connectionState =
                      "disconnected";

                  });

              },
              5000
            );

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


/*
==================================================
 BOTÃO INICIAR WHATSAPP
==================================================
*/

app.post(
  "/api/whatsapp/start",
  async (_req, res) => {

    try {

      await startWhatsApp();


      await new Promise(
        resolve =>
          setTimeout(
            resolve,
            500
          )
      );


      res.json({

        ok: true,

        status:
          connectionState,

        qrAvailable:
          Boolean(qrDataUrl),

        message:
          qrDataUrl
            ? "QR Code disponível"
            : "WhatsApp iniciado. Aguardando QR."

      });


    } catch (err) {

      lastError =
        err.message;

      connectionState =
        "disconnected";


      res.status(500).json({

        error:
          err.message

      });

    }

  }
);


/*
==================================================
 RESET MANUAL DA SESSÃO
==================================================
*/

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

      lastError =
        null;


      resetWhatsAppAuth();


      res.json({

        ok: true,

        message:
          "Sessão apagada. Inicie o WhatsApp novamente para gerar um novo QR."

      });


    } catch (err) {

      lastError =
        err.message;


      res.status(500).json({

        error:
          err.message

      });

    }

  }
);


/*
==================================================
 GRUPOS
==================================================
*/

function extractInviteCode(
  value
) {

  const match =
    String(value || "")
      .match(
        /chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/i
      );

  return (
    match?.[1] ||
    null
  );

}


app.get(
  "/api/groups",
  (_req, res) => {

    res.json({

      ok: true,

      groups

    });

  }
);


app.post(
  "/api/groups",
  async (req, res) => {

    const {
      name,
      inviteLink,
      jid
    } =
      req.body || {};


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


      const item = {

        id:
          randomUUID(),

        name:
          groupName,

        jid:
          groupJid,

        inviteLink:
          inviteLink ||
          null,

        createdAt:
          new Date().toISOString()

      };


      groups.push(
        item
      );


      saveJson(
        GROUPS_FILE,
        groups
      );


      res.json({

        ok: true,

        group:
          item

      });


    } catch (err) {

      res.status(400).json({

        error:
          err.message

      });

    }

  }
);


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


/*
==================================================
 AGENDAMENTOS
==================================================
*/

app.get(
  "/api/jobs",
  (_req, res) => {

    res.json({

      ok: true,

      jobs

    });

  }
);


app.post(
  "/api/jobs",
  (req, res) => {

    const {
      groupId,
      message,
      scheduledAt
    } =
      req.body || {};


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


    const job = {

      id:
        randomUUID(),

      groupId,

      message,

      scheduledAt,

      status:
        "pending",

      createdAt:
        new Date().toISOString()

    };


    jobs.push(
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

  }
);


/*
==================================================
 ENVIO
==================================================
*/

async function sendJob(
  job
) {

  const group =
    groups.find(
      g =>
        g.id ===
        job.groupId
    );


  if (
    !group?.jid
  ) {

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


  await sock.sendMessage(
    group.jid,
    {
      text:
        job.message
    }
  );


  job.status =
    "sent";


  job.sentAt =
    new Date().toISOString();

}


/*
==================================================
 ENVIO MANUAL
==================================================
*/

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

        job,

        message:
          "Mensagem enviada com sucesso"

      });


    } catch (err) {

      job.status =
        "error";

      job.error =
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


/*
==================================================
 EXCLUIR AGENDAMENTO
==================================================
*/

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


/*
==================================================
 AGENDADOR
==================================================
*/

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


  for (
    const job of jobs
  ) {

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

      continue;

    }


    if (
      when >
      now
    ) {

      continue;

    }


    try {

      await sendJob(
        job
      );

    } catch (err) {

      job.status =
        "error";

      job.error =
        err.message;

    }

  }


  saveJson(
    JOBS_FILE,
    jobs
  );

}


/*
==================================================
 CRON
==================================================
*/

cron.schedule(
  "* * * * *",
  () => {

    processJobs()
      .catch(
        err =>
          console.error(
            "Scheduler:",
            err.message
          )
      );

  },
  {
    timezone:
      TZ
  }
);


/*
==================================================
 SERVIDOR
==================================================
*/

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      "================================"
    );

    console.log(
      "OFERTAZAP API ONLINE"
    );

    console.log(
      "Porta:",
      PORT
    );

    console.log(
      "Timezone:",
      TZ
    );

    console.log(
      "================================"
    );

  }
);
