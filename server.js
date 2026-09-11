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
import crypto from "node:crypto";

const app = express();

const PORT = Number(process.env.PORT || 3000);

const API_TOKEN =
  process.env.API_TOKEN || "";

const TZ =
  process.env.TZ ||
  "America/Sao_Paulo";

const ML_CLIENT_ID =
  process.env.ML_CLIENT_ID || "";

const ML_CLIENT_SECRET =
  process.env.ML_CLIENT_SECRET || "";

const ML_REDIRECT_URI =
  process.env.ML_REDIRECT_URI ||
  "https://ofertazap-api1.onrender.com/api/mercadolivre/callback";

// ======================================================
// EXPRESS
// ======================================================

app.use(
  cors({
    origin:
      process.env.FRONTEND_ORIGIN || "*"
  })
);

app.use(
  express.json({
    limit: "1mb"
  })
);

// ======================================================
// PASTAS
// ======================================================

const DATA_DIR =
  path.resolve("./data");

const AUTH_DIR =
  path.resolve("./auth_info_baileys");

fs.mkdirSync(
  DATA_DIR,
  { recursive: true }
);

fs.mkdirSync(
  AUTH_DIR,
  { recursive: true }
);

// ======================================================
// ARQUIVOS
// ======================================================

const GROUPS_FILE =
  path.join(
    DATA_DIR,
    "groups.json"
  );

const JOBS_FILE =
  path.join(
    DATA_DIR,
    "jobs.json"
  );

const ML_TOKEN_FILE =
  path.join(
    DATA_DIR,
    "mercadolivre.json"
  );

// ======================================================
// JSON
// ======================================================

function loadJson(
  file,
  fallback = []
) {
  try {

    if (
      !fs.existsSync(file)
    ) {
      return fallback;
    }

    return JSON.parse(
      fs.readFileSync(
        file,
        "utf8"
      )
    );

  } catch {

    return fallback;

  }
}

function saveJson(
  file,
  data
) {

  fs.writeFileSync(
    file,
    JSON.stringify(
      data,
      null,
      2
    ),
    "utf8"
  );

}

// ======================================================
// ESTADO
// ======================================================

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

let mlTokens =
  loadJson(
    ML_TOKEN_FILE,
    {}
  );

let sock =
  null;

let qrDataUrl =
  null;

let connectionState =
  "disconnected";

let lastError =
  null;

let mlOAuthState =
  null;

// ======================================================
// MERCADO LIVRE
// ======================================================

function requireMercadoLivreConfig() {

  const missing = [];

  if (
    !ML_CLIENT_ID
  ) {
    missing.push(
      "ML_CLIENT_ID"
    );
  }

  if (
    !ML_CLIENT_SECRET
  ) {
    missing.push(
      "ML_CLIENT_SECRET"
    );
  }

  if (
    !ML_REDIRECT_URI
  ) {
    missing.push(
      "ML_REDIRECT_URI"
    );
  }

  if (
    missing.length
  ) {

    throw new Error(
      "Mercado Livre OAuth não configurado. " +
      "Variáveis ausentes: " +
      missing.join(", ")
    );

  }

}

// ======================================================
// URL OAUTH
// ======================================================

function buildMercadoLivreAuthUrl() {

  requireMercadoLivreConfig();

  mlOAuthState =
    crypto
      .randomBytes(24)
      .toString("hex");

  const url =
    new URL(
      "https://auth.mercadolivre.com.br/authorization"
    );

  url.searchParams.set(
    "response_type",
    "code"
  );

  url.searchParams.set(
    "client_id",
    ML_CLIENT_ID
  );

  url.searchParams.set(
    "redirect_uri",
    ML_REDIRECT_URI
  );

  url.searchParams.set(
    "state",
    mlOAuthState
  );

  url.searchParams.set(
    "scope",
    "offline_access read write"
  );

  return url.toString();

}

// ======================================================
// TROCAR CODE POR TOKEN
// ======================================================

async function exchangeMercadoLivreCode(
  code
) {

  requireMercadoLivreConfig();

  const body =
    new URLSearchParams({

      grant_type:
        "authorization_code",

      client_id:
        ML_CLIENT_ID,

      client_secret:
        ML_CLIENT_SECRET,

      code,

      redirect_uri:
        ML_REDIRECT_URI

    });

  const response =
    await fetch(
      "https://api.mercadolibre.com/oauth/token",
      {

        method:
          "POST",

        headers: {

          accept:
            "application/json",

          "content-type":
            "application/x-www-form-urlencoded"

        },

        body

      }
    );

  const data =
    await response.json();

  if (
    !response.ok
  ) {

    throw new Error(
      data.error_description ||
      data.message ||
      "Falha ao obter token do Mercado Livre"
    );

  }

  mlTokens = {

    ...data,

    savedAt:
      new Date().toISOString()

  };

  saveJson(
    ML_TOKEN_FILE,
    mlTokens
  );

  return data;

}

// ======================================================
// RENOVAR TOKEN
// ======================================================

async function refreshMercadoLivreToken() {

  requireMercadoLivreConfig();

  if (
    !mlTokens.refresh_token
  ) {

    throw new Error(
      "Mercado Livre ainda não foi autorizado."
    );

  }

  const body =
    new URLSearchParams({

      grant_type:
        "refresh_token",

      client_id:
        ML_CLIENT_ID,

      client_secret:
        ML_CLIENT_SECRET,

      refresh_token:
        mlTokens.refresh_token

    });

  const response =
    await fetch(
      "https://api.mercadolibre.com/oauth/token",
      {

        method:
          "POST",

        headers: {

          accept:
            "application/json",

          "content-type":
            "application/x-www-form-urlencoded"

        },

        body

      }
    );

  const data =
    await response.json();

  if (
    !response.ok
  ) {

    throw new Error(
      data.error_description ||
      data.message ||
      "Falha ao renovar token do Mercado Livre"
    );

  }

  mlTokens = {

    ...data,

    savedAt:
      new Date().toISOString()

  };

  saveJson(
    ML_TOKEN_FILE,
    mlTokens
  );

  return data;

}

// ======================================================
// ACCESS TOKEN
// ======================================================

async function getMercadoLivreAccessToken() {

  if (
    !mlTokens.access_token
  ) {

    throw new Error(
      "Mercado Livre não conectado. Autorize a conta primeiro."
    );

  }

  const savedAt =
    new Date(
      mlTokens.savedAt || 0
    ).getTime();

  const expiresAt =
    savedAt +
    Number(
      mlTokens.expires_in ||
      21600
    ) *
    1000;

  if (
    Date.now() <
    expiresAt - 120000
  ) {

    return mlTokens.access_token;

  }

  const refreshed =
    await refreshMercadoLivreToken();

  return refreshed.access_token;

}

// ======================================================
// EXTRAIR MLB
// ======================================================

function extractMercadoLivreItemId(
  value
) {

  const text =
    String(
      value || ""
    );

  const match =
    text.match(
      /\bMLB[-_]?\d{6,}\b/i
    );

  if (
    !match
  ) {

    return null;

  }

  return match[0]
    .replace(
      /[-_]/g,
      ""
    )
    .toUpperCase();

}

// ======================================================
// RESOLVER LINK MERCADO LIVRE
// ======================================================

async function resolveMercadoLivreItemId(
  value
) {

  const original =
    String(
      value || ""
    ).trim();

  if (
    !original
  ) {

    throw new Error(
      "Informe o link do Mercado Livre."
    );

  }

  // --------------------------------------------
  // Link já contém MLB
  // --------------------------------------------

  const direct =
    extractMercadoLivreItemId(
      original
    );

  if (
    direct
  ) {

    return direct;

  }

  if (
    !/^https?:\/\//i.test(
      original
    )
  ) {

    throw new Error(
      "Digite uma URL válida do Mercado Livre."
    );

  }

  const candidates = [
    original
  ];

  const visited =
    new Set();

  let current =
    original;

  function addCandidate(
    value,
    base
  ) {

    if (
      !value
    ) {
      return;
    }

    let text =
      String(
        value
      ).trim();

    text =
      text
        .replace(
          /\\u0026/g,
          "&"
        )
        .replace(
          /\\\//g,
          "/"
        );

    try {

      if (
        base &&
        !/^https?:\/\//i.test(
          text
        )
      ) {

        text =
          new URL(
            text,
            base
          ).toString();

      }

    } catch {}

    if (
      text
    ) {

      candidates.push(
        text
      );

    }

  }

  // --------------------------------------------
  // Até 10 redirecionamentos
  // --------------------------------------------

  for (
    let step = 0;
    step < 10;
    step++
  ) {

    if (
      visited.has(
        current
      )
    ) {

      break;

    }

    visited.add(
      current
    );

    let response;

    try {

      response =
        await fetch(
          current,
          {

            redirect:
              "manual",

            headers: {

              "user-agent":
                "Mozilla/5.0 " +
                "(compatible; OfertaZap/1.0)",

              accept:
                "text/html,application/xhtml+xml," +
                "application/json;q=0.9,*/*;q=0.8",

              "accept-language":
                "pt-BR,pt;q=0.9,en;q=0.8"

            }

          }
        );

    } catch {

      throw new Error(
        "Não consegui abrir o link do Mercado Livre."
      );

    }

    // ------------------------------------------
    // URL da resposta
    // ------------------------------------------

    addCandidate(
      response.url ||
      current,
      current
    );

    // ------------------------------------------
    // Location
    // ------------------------------------------

    const location =
      response.headers.get(
        "location"
      );

    if (
      location
    ) {

      addCandidate(
        location,
        current
      );

      try {

        current =
          new URL(
            location,
            current
          ).toString();

        continue;

      } catch {}

    }

    // ------------------------------------------
    // HTML
    // ------------------------------------------

    let html =
      "";

    try {

      html =
        await response.text();

    } catch {}

    // ------------------------------------------
    // MLB direto no HTML
    // ------------------------------------------

    const ids =
      html.match(
        /\bMLB[-_]?\d{6,}\b/gi
      ) || [];

    if (
      ids.length
    ) {

      return ids[0]
        .replace(
          /[-_]/g,
          ""
        )
        .toUpperCase();

    }

    // ------------------------------------------
    // Canonical / OG / redirect / JavaScript
    // ------------------------------------------

    const patterns = [

      /(?:canonical|og:url)[^>]+(?:href|content)=["']([^"']+)["']/gi,

      /<meta[^>]+http-equiv=["']refresh["'][^>]+content=["'][^"']*url=([^"']+)["']/gi,

      /(?:window\.)?location(?:\.href|\.replace|\.assign)?\s*(?:=|\()\s*["']([^"']+)["']/gi,

      /https?:\\?\/\\?\/[^\s"'<>\\]+/gi

    ];

    for (
      const regex
      of patterns
    ) {

      let match;

      while (
        (
          match =
            regex.exec(
              html
            )
        ) !== null
      ) {

        addCandidate(
          match[1] ||
          match[0],
          current
        );

      }

    }

    // ------------------------------------------
    // Procurar MLB nos candidatos
    // ------------------------------------------

    for (
      const candidate
      of candidates
    ) {

      const id =
        extractMercadoLivreItemId(
          candidate
        );

      if (
        id
      ) {

        return id;

      }

    }

    // ------------------------------------------
    // Próxima URL
    // ------------------------------------------

    const next =
      candidates
        .slice()
        .reverse()
        .find(
          item =>
            /^https?:\/\//i.test(
              item
            ) &&
            !visited.has(
              item
            )
        );

    if (
      next
    ) {

      current =
        next;

      continue;

    }

    break;

  }

  throw new Error(
    "Não consegui identificar o ID do anúncio (MLB) nesse link. " +
    "O link pode não apontar diretamente para um anúncio do Mercado Livre."
  );

}

// ======================================================
// BUSCAR PRODUTO
// ======================================================

async function getMercadoLivreProduct(
  value
) {

  const itemId =
    await resolveMercadoLivreItemId(
      value
    );

  if (
    !itemId
  ) {

    throw new Error(
      "Não consegui identificar o ID do anúncio (MLB)."
    );

  }

  const token =
    await getMercadoLivreAccessToken();

  let response =
    await fetch(
      `https://api.mercadolibre.com/items/${encodeURIComponent(itemId)}`,
      {

        headers: {

          Authorization:
            `Bearer ${token}`,

          Accept:
            "application/json"

        }

      }
    );

  let data =
    await response.json();

  // --------------------------------------------
  // Token expirado
  // --------------------------------------------

  if (
    response.status === 401
  ) {

    const refreshed =
      await refreshMercadoLivreToken();

    response =
      await fetch(
        `https://api.mercadolibre.com/items/${encodeURIComponent(itemId)}`,
        {

          headers: {

            Authorization:
              `Bearer ${refreshed.access_token}`,

            Accept:
              "application/json"

          }

        }
      );

    data =
      await response.json();

  }

  if (
    !response.ok
  ) {

    throw new Error(
      data.message ||
      data.error ||
      "Falha ao consultar produto no Mercado Livre."
    );

  }

  const pictures =
    Array.isArray(
      data.pictures
    )
      ? data.pictures
          .map(
            picture =>
              picture.secure_url ||
              picture.url
          )
          .filter(Boolean)
      : [];

  return {

    id:
      data.id,

    title:
      data.title ||
      "",

    price:
      data.price ??
      null,

    oldPrice:
      data.original_price ??
      null,

    currency:
      data.currency_id ||
      "BRL",

    image:
      pictures[0] ||
      data.thumbnail ||
      null,

    pictures,

    permalink:
      data.permalink ||
      null

  };

}

// ======================================================
// CALLBACK MERCADO LIVRE
// ======================================================

app.get(
  "/api/mercadolivre/callback",
  async (
    req,
    res
  ) => {

    try {

      const {
        code,
        state,
        error,
        error_description
      } = req.query;

      if (
        error
      ) {

        return res
          .status(400)
          .send(
            `Autorização cancelada: ${
              error_description ||
              error
            }`
          );

      }

      if (
        !code
      ) {

        return res
          .status(400)
          .send(
            "Código de autorização não recebido."
          );

      }

      if (
        !mlOAuthState ||
        state !==
          mlOAuthState
      ) {

        return res
          .status(400)
          .send(
            "Estado OAuth inválido ou expirado."
          );

      }

      await exchangeMercadoLivreCode(
        code
      );

      mlOAuthState =
        null;

      res.send(
        `
        <h2>
          OfertaZap conectado ao Mercado Livre ✅
        </h2>

        <p>
          Você pode fechar esta página
          e voltar ao painel.
        </p>
        `
      );

    } catch (
      error
    ) {

      res
        .status(400)
        .send(
          `
          <h2>
            Erro ao conectar Mercado Livre
          </h2>

          <p>
            ${String(
              error.message
            ).replace(
              /[<>]/g,
              ""
            )}
          </p>
          `
        );

    }

  }
);

// ======================================================
// AUTENTICAÇÃO
// ======================================================

function authMiddleware(
  req,
  res,
  next
) {

  if (
    !API_TOKEN
  ) {

    return res
      .status(503)
      .json({
        error:
          "API_TOKEN não configurado no servidor."
      });

  }

  const auth =
    req.headers.authorization ||
    "";

  const bearer =
    auth.startsWith(
      "Bearer "
    )
      ? auth.slice(7)
      : "";

  const token =
    bearer ||
    req.headers[
      "x-api-token"
    ] ||
    "";

  if (
    token !==
    API_TOKEN
  ) {

    return res
      .status(401)
      .json({
        error:
          "Token inválido"
      });

  }

  next();

}

// ======================================================
// HOME
// ======================================================

app.get(
  "/",
  (_req, res) => {

    res.json({

      ok:
        true,

      service:
        "OfertaZap API",

      status:
        connectionState,

      health:
        "/api/health"

    });

  }
);

// ======================================================
// HEALTH
// ======================================================

app.get(
  "/api/health",
  (_req, res) => {

    res.json({

      ok:
        true,

      service:
        "OfertaZap API",

      time:
        new Date().toISOString()

    });

  }
);

// ======================================================
// PROTEGER API
// ======================================================

app.use(
  "/api",
  authMiddleware
);

// ======================================================
// MERCADO LIVRE AUTH
// ======================================================

app.get(
  "/api/mercadolivre/auth",
  (_req, res) => {

    try {

      res.json({

        ok:
          true,

        authorizationUrl:
          buildMercadoLivreAuthUrl()

      });

    } catch (
      error
    ) {

      res
        .status(503)
        .json({
          error:
            error.message
        });

    }

  }
);

// ======================================================
// MERCADO LIVRE STATUS
// ======================================================

app.get(
  "/api/mercadolivre/status",
  (_req, res) => {

    const missing = [];

    if (
      !ML_CLIENT_ID
    ) {

      missing.push(
        "ML_CLIENT_ID"
      );

    }

    if (
      !ML_CLIENT_SECRET
    ) {

      missing.push(
        "ML_CLIENT_SECRET"
      );

    }

    if (
      !ML_REDIRECT_URI
    ) {

      missing.push(
        "ML_REDIRECT_URI"
      );

    }

    res.json({

      ok:
        true,

      configured:
        missing.length ===
        0,

      missing,

      connected:
        Boolean(
          mlTokens.access_token &&
          mlTokens.refresh_token
        ),

      userId:
        mlTokens.user_id ||
        null,

      expiresAt:
        mlTokens.savedAt
          ? new Date(
              new Date(
                mlTokens.savedAt
              ).getTime() +
              Number(
                mlTokens.expires_in ||
                21600
              ) *
              1000
            ).toISOString()
          : null

    });

  }
);

// ======================================================
// PREVIEW PRODUTO
// ======================================================

app.post(
  "/api/products/preview",
  async (
    req,
    res
  ) => {

    try {

      const {
        link,
        url
      } =
        req.body || {};

      const productLink =
        link ||
        url;

      if (
        !productLink
      ) {

        return res
          .status(400)
          .json({
            error:
              "Informe o link do Mercado Livre."
          });

      }

      const product =
        await getMercadoLivreProduct(
          productLink
        );

      res.json({

        ok:
          true,

        product

      });

    } catch (
      error
    ) {

      console.error(
        "Erro produto:",
        error.message
      );

      res
        .status(400)
        .json({
          error:
            error.message
        });

    }

  }
);

// ======================================================
// STATUS
// ======================================================

app.get(
  "/api/status",
  (_req, res) => {

    res.json({

      ok:
        true,

      whatsapp:
        connectionState,

      qrAvailable:
        Boolean(
          qrDataUrl
        ),

      groups:
        groups.length,

      jobs:
        jobs.length,

      lastError

    });

  }
);

// ======================================================
// QR CODE
// ======================================================

app.get(
  "/api/whatsapp/qr",
  (_req, res) => {

    if (
      !qrDataUrl
    ) {

      return res
        .status(404)
        .json({
          error:
            "QR Code ainda não disponível."
        });

    }

    res.json({

      ok:
        true,

      qr:
        qrDataUrl

    });

  }
);

// ======================================================
// WHATSAPP
// ======================================================

async function startWhatsApp() {

  if (
    connectionState ===
      "connecting" ||
    connectionState ===
      "connected"
  ) {

    return;

  }

  connectionState =
    "connecting";

  lastError =
    null;

  const {
    state,
    saveCreds
  } =
    await useMultiFileAuthState(
      AUTH_DIR
    );

  const {
    version
  } =
    await fetchLatestBaileysVersion();

  sock =
    makeWASocket({

      version,

      logger:
        pino({
          level:
            "silent"
        }),

      auth: {

        creds:
          state.creds,

        keys:
          makeCacheableSignalKeyStore(
            state.keys,
            pino({
              level:
                "silent"
            })
          )

      },

      printQRInTerminal:
        false,

      browser: [
        "OfertaZap",
        "Chrome",
        "1.0.0"
      ]

    });

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

      if (
        qr
      ) {

        qrDataUrl =
          await QRCode.toDataURL(
            qr
          );

      }

      if (
        connection ===
        "open"
      ) {

        connectionState =
          "connected";

        qrDataUrl =
          null;

        lastError =
          null;

        console.log(
          "WhatsApp conectado."
        );

      }

      if (
        connection ===
        "close"
      ) {

        connectionState =
          "disconnected";

        const code =
          new Boom(
            lastDisconnect?.error
          )
            ?.output
            ?.statusCode;

        lastError =
          String(
            code ||
            lastDisconnect?.error?.message ||
            "Conexão encerrada"
          );

        if (
          code !==
          DisconnectReason.loggedOut
        ) {

          setTimeout(
            () => {

              startWhatsApp()
                .catch(
                  error => {

                    lastError =
                      error.message;

                    connectionState =
                      "disconnected";

                  }
                );

            },
            5000
          );

        }

      }

    }
  );

}

// ======================================================
// INICIAR WHATSAPP
// ======================================================

app.post(
  "/api/whatsapp/start",
  async (
    _req,
    res
  ) => {

    try {

      await startWhatsApp();

      res.json({

        ok:
          true,

        status:
          connectionState,

        qrAvailable:
          Boolean(
            qrDataUrl
          )

      });

    } catch (
      error
    ) {

      lastError =
        error.message;

      connectionState =
        "disconnected";

      res
        .status(500)
        .json({
          error:
            error.message
        });

    }

  }
);

// ======================================================
// GRUPOS
// ======================================================

function extractInviteCode(
  value
) {

  const match =
    String(
      value || ""
    ).match(
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

      ok:
        true,

      groups

    });

  }
);

app.post(
  "/api/groups",
  async (
    req,
    res
  ) => {

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

      return res
        .status(400)
        .json({
          error:
            "Informe name, inviteLink ou jid"
        });

    }

    let groupJid =
      jid ||
      null;

    let groupName =
      name ||
      "Grupo WhatsApp";

    try {

      if (
        !sock
      ) {

        return res
          .status(409)
          .json({
            error:
              "WhatsApp não está conectado."
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

        if (
          !code
        ) {

          return res
            .status(400)
            .json({
              error:
                "Link de convite inválido."
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

        ok:
          true,

        group:
          item

      });

    } catch (
      error
    ) {

      res
        .status(400)
        .json({
          error:
            error.message
        });

    }

  }
);

// ======================================================
// ENTRAR NO GRUPO
// ======================================================

app.post(
  "/api/groups/:id/join",
  async (
    req,
    res
  ) => {

    try {

      const group =
        groups.find(
          item =>
            item.id ===
            req.params.id
        );

      if (
        !group
      ) {

        return res
          .status(404)
          .json({
            error:
              "Grupo não encontrado."
          });

      }

      if (
        !sock ||
        connectionState !==
          "connected"
      ) {

        return res
          .status(409)
          .json({
            error:
              "WhatsApp não está conectado."
          });

      }

      if (
        !group.inviteLink
      ) {

        return res
          .status(400)
          .json({
            error:
              "Este grupo não possui link de convite."
          });

      }

      const code =
        extractInviteCode(
          group.inviteLink
        );

      if (
        !code
      ) {

        return res
          .status(400)
          .json({
            error:
              "Link de convite inválido."
          });

      }

      const jid =
        await sock.groupAcceptInvite(
          code
        );

      if (
        jid
      ) {

        group.jid =
          jid;

      }

      saveJson(
        GROUPS_FILE,
        groups
      );

      res.json({

        ok:
          true,

        message:
          "Grupo conectado.",

        group

      });

    } catch (
      error
    ) {

      res
        .status(400)
        .json({
          error:
            error.message
        });

    }

  }
);

// ======================================================
// EXCLUIR GRUPO
// ======================================================

app.delete(
  "/api/groups/:id",
  (
    req,
    res
  ) => {

    const before =
      groups.length;

    groups =
      groups.filter(
        group =>
          group.id !==
          req.params.id
      );

    saveJson(
      GROUPS_FILE,
      groups
    );

    res.json({

      ok:
        true,

      removed:
        before !==
        groups.length

    });

  }
);

// ======================================================
// AGENDAMENTOS
// ======================================================

app.get(
  "/api/jobs",
  (_req, res) => {

    res.json({

      ok:
        true,

      jobs

    });

  }
);

// ======================================================
// CRIAR AGENDAMENTO
// ======================================================

app.post(
  "/api/jobs",
  (
    req,
    res
  ) => {

    const {
      groupId,
      message,
      scheduledAt,
      repeat = "unica",
      imageUrl = null,
      product = null
    } =
      req.body || {};

    if (
      !groupId ||
      !message ||
      !scheduledAt
    ) {

      return res
        .status(400)
        .json({
          error:
            "groupId, message e scheduledAt são obrigatórios."
        });

    }

    if (
      ![
        "unica",
        "diaria",
        "semanal"
      ].includes(
        repeat
      )
    ) {

      return res
        .status(400)
        .json({
          error:
            "Repetição inválida."
        });

    }

    const group =
      groups.find(
        item =>
          item.id ===
          groupId
      );

    if (
      !group
    ) {

      return res
        .status(404)
        .json({
          error:
            "Grupo não encontrado."
        });

    }

    const job = {

      id:
        randomUUID(),

      groupId,

      message,

      scheduledAt,

      repeat,

      imageUrl,

      product,

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

      ok:
        true,

      job

    });

  }
);

// ======================================================
// ENVIAR JOB
// ======================================================

async function sendJob(
  job
) {

  const group =
    groups.find(
      item =>
        item.id ===
        job.groupId
    );

  if (
    !group?.jid
  ) {

    throw new Error(
      "Grupo sem JID."
    );

  }

  if (
    !sock ||
    connectionState !==
      "connected"
  ) {

    throw new Error(
      "WhatsApp não conectado."
    );

  }

  // --------------------------------------------
  // PRODUTO COM IMAGEM
  // --------------------------------------------

  if (
    job.imageUrl
  ) {

    await sock.sendMessage(
      group.jid,
      {

        image: {
          url:
            job.imageUrl
        },

        caption:
          job.message

      }
    );

  } else {

    await sock.sendMessage(
      group.jid,
      {

        text:
          job.message

      }
    );

  }

  job.sentAt =
    new Date().toISOString();

  // --------------------------------------------
  // REPETIÇÃO
  // --------------------------------------------

  if (
    job.repeat ===
      "diaria" ||
    job.repeat ===
      "semanal"
  ) {

    const current =
      new Date(
        job.scheduledAt
      );

    const days =
      job.repeat ===
        "diaria"
        ? 1
        : 7;

    current.setDate(
      current.getDate() +
      days
    );

    job.scheduledAt =
      current.toISOString();

    job.status =
      "pending";

    job.lastStatus =
      "sent";

  } else {

    job.status =
      "sent";

  }

}

// ======================================================
// ENVIAR MANUALMENTE
// ======================================================

app.post(
  "/api/jobs/:id/send",
  async (
    req,
    res
  ) => {

    const job =
      jobs.find(
        item =>
          item.id ===
          req.params.id
      );

    if (
      !job
    ) {

      return res
        .status(404)
        .json({
          error:
            "Agendamento não encontrado."
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

        ok:
          true,

        job

      });

    } catch (
      error
    ) {

      job.status =
        "error";

      job.error =
        error.message;

      saveJson(
        JOBS_FILE,
        jobs
      );

      res
        .status(400)
        .json({

          error:
            error.message,

          job

        });

    }

  }
);

// ======================================================
// EXCLUIR JOB
// ======================================================

app.delete(
  "/api/jobs/:id",
  (
    req,
    res
  ) => {

    const before =
      jobs.length;

    jobs =
      jobs.filter(
        job =>
          job.id !==
          req.params.id
      );

    saveJson(
      JOBS_FILE,
      jobs
    );

    res.json({

      ok:
        true,

      removed:
        before !==
        jobs.length

    });

  }
);

// ======================================================
// PROCESSADOR
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

  for (
    const job
    of jobs
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
      ) ||
      when > now
    ) {

      continue;

    }

    try {

      await sendJob(
        job
      );

    } catch (
      error
    ) {

      job.status =
        "error";

      job.error =
        error.message;

    }

  }

  saveJson(
    JOBS_FILE,
    jobs
  );

}

// ======================================================
// CRON
// ======================================================

cron.schedule(
  "* * * * *",
  () => {

    processJobs()
      .catch(
        error =>
          console.error(
            "Scheduler:",
            error.message
          )
      );

  },
  {
    timezone:
      TZ
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
      "Mercado Livre OAuth:",
      ML_CLIENT_ID &&
      ML_CLIENT_SECRET
        ? "configurado"
        : "não configurado"
    );

  }
);
