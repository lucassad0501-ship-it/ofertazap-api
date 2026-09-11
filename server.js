import "dotenv/config";
import express from "express";
import cors from "cors";
import cron from "node-cron";
import QRCode from "qrcode";
import pino from "pino";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Boom } from "@hapi/boom";

import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore
} from "@whiskeysockets/baileys";

// ======================================================
// OFERTAZAP API V12
// ======================================================

const app = express();

const PORT =
  Number(process.env.PORT || 10000);

const API_TOKEN =
  String(process.env.API_TOKEN || "").trim();

const TZ =
  process.env.TZ ||
  "America/Sao_Paulo";

const ML_CLIENT_ID =
  String(process.env.ML_CLIENT_ID || "").trim();

const ML_CLIENT_SECRET =
  String(process.env.ML_CLIENT_SECRET || "").trim();

const ML_REDIRECT_URI =
  String(
    process.env.ML_REDIRECT_URI ||
    "https://ofertazap-api1.onrender.com/api/mercadolivre/callback"
  ).trim();

// ======================================================
// EXPRESS
// ======================================================

app.use(
  cors({
    origin: "*"
  })
);

app.use(
  express.json({
    limit: "2mb"
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
  path.join(DATA_DIR, "groups.json");

const JOBS_FILE =
  path.join(DATA_DIR, "jobs.json");

const ML_FILE =
  path.join(DATA_DIR, "mercadolivre.json");

// ======================================================
// JSON
// ======================================================

function loadJson(
  file,
  fallback
) {

  try {

    if (!fs.existsSync(file)) {
      return fallback;
    }

    return JSON.parse(
      fs.readFileSync(
        file,
        "utf8"
      )
    );

  } catch (error) {

    console.error(
      "Erro lendo arquivo:",
      file,
      error.message
    );

    return fallback;

  }

}

function saveJson(
  file,
  data
) {

  try {

    fs.writeFileSync(
      file,
      JSON.stringify(
        data,
        null,
        2
      ),
      "utf8"
    );

  } catch (error) {

    console.error(
      "Erro salvando:",
      file,
      error.message
    );

  }

}

// ======================================================
// DADOS
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
    ML_FILE,
    {}
  );

// ======================================================
// ESTADO WHATSAPP
// ======================================================

let sock =
  null;

let qrDataUrl =
  null;

let connectionState =
  "disconnected";

let lastError =
  null;

// ======================================================
// ESTADO OAUTH
// ======================================================

let mlOAuthState =
  null;

// ======================================================
// MERCADO LIVRE
// ======================================================

function mercadoLivreConfigured() {

  return Boolean(
    ML_CLIENT_ID &&
    ML_CLIENT_SECRET &&
    ML_REDIRECT_URI
  );

}

function requireMercadoLivreConfig() {

  if (
    !mercadoLivreConfigured()
  ) {

    throw new Error(
      "Mercado Livre OAuth não configurado. " +
      "Verifique ML_CLIENT_ID, ML_CLIENT_SECRET " +
      "e ML_REDIRECT_URI no Render."
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
      .randomBytes(32)
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
    new URLSearchParams();

  body.set(
    "grant_type",
    "authorization_code"
  );

  body.set(
    "client_id",
    ML_CLIENT_ID
  );

  body.set(
    "client_secret",
    ML_CLIENT_SECRET
  );

  body.set(
    "code",
    code
  );

  body.set(
    "redirect_uri",
    ML_REDIRECT_URI
  );

  const response =
    await fetch(
      "https://api.mercadolibre.com/oauth/token",
      {
        method: "POST",

        headers: {
          "content-type":
            "application/x-www-form-urlencoded",

          accept:
            "application/json"
        },

        body
      }
    );

  const data =
    await response.json();

  if (!response.ok) {

    throw new Error(
      data.error_description ||
      data.message ||
      "Erro ao obter token do Mercado Livre."
    );

  }

  mlTokens = {
    ...data,
    savedAt:
      new Date().toISOString()
  };

  saveJson(
    ML_FILE,
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
      "Mercado Livre ainda não está conectado."
    );

  }

  const body =
    new URLSearchParams();

  body.set(
    "grant_type",
    "refresh_token"
  );

  body.set(
    "client_id",
    ML_CLIENT_ID
  );

  body.set(
    "client_secret",
    ML_CLIENT_SECRET
  );

  body.set(
    "refresh_token",
    mlTokens.refresh_token
  );

  const response =
    await fetch(
      "https://api.mercadolibre.com/oauth/token",
      {
        method: "POST",

        headers: {
          "content-type":
            "application/x-www-form-urlencoded",

          accept:
            "application/json"
        },

        body
      }
    );

  const data =
    await response.json();

  if (!response.ok) {

    throw new Error(
      data.error_description ||
      data.message ||
      "Erro renovando token."
    );

  }

  mlTokens = {
    ...data,
    savedAt:
      new Date().toISOString()
  };

  saveJson(
    ML_FILE,
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

  const saved =
    new Date(
      mlTokens.savedAt || 0
    ).getTime();

  const expires =
    saved +
    Number(
      mlTokens.expires_in ||
      21600
    ) *
    1000;

  if (
    Date.now() <
    expires - 120000
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

  if (!match) {
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
// RESOLVER LINK
// ======================================================

async function resolveMercadoLivreItemId(
  value
) {

  const original =
    String(
      value || ""
    ).trim();

  if (!original) {

    throw new Error(
      "Informe o link do Mercado Livre."
    );

  }

  const direct =
    extractMercadoLivreItemId(
      original
    );

  if (direct) {
    return direct;
  }

  if (
    !/^https?:\/\//i.test(
      original
    )
  ) {

    throw new Error(
      "Digite uma URL válida."
    );

  }

  let current =
    original;

  const visited =
    new Set();

  const candidates =
    [];

  function addCandidate(
    value,
    base
  ) {

    if (!value) {
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
      !candidates.includes(
        text
      )
    ) {

      candidates.push(
        text
      );

    }

  }

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
                "(Linux; Android 10) " +
                "AppleWebKit/537.36 " +
                "Chrome/140 Mobile Safari/537.36",

              accept:
                "text/html," +
                "application/xhtml+xml," +
                "application/json;q=0.9," +
                "*/*;q=0.8",

              "accept-language":
                "pt-BR,pt;q=0.9"

            }

          }
        );

    } catch {

      throw new Error(
        "Não consegui abrir o link do Mercado Livre."
      );

    }

    addCandidate(
      current
    );

    addCandidate(
      response.url
    );

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

      const found =
        extractMercadoLivreItemId(
          location
        );

      if (found) {
        return found;
      }

      try {

        current =
          new URL(
            location,
            current
          ).toString();

        continue;

      } catch {}

    }

    let html =
      "";

    try {

      html =
        await response.text();

    } catch {}

    // MLB direto
    const ids =
      html.match(
        /\bMLB[-_]?\d{6,}\b/gi
      ) || [];

    if (
      ids.length
    ) {

      return extractMercadoLivreItemId(
        ids[0]
      );

    }

    // URLs escondidas
    const patterns = [

      /(?:canonical|og:url)[^>]+(?:href|content)=["']([^"']+)["']/gi,

      /<meta[^>]+http-equiv=["']refresh["'][^>]+content=["'][^"']*url=([^"']+)["']/gi,

      /(?:window\.)?location(?:\.href|\.replace|\.assign)?\s*(?:=|)\s*["']([^"']+)["']/gi,

      /https?:\\?\/\\?\/[^\s"'<>\+/gi

    ];

    for (
      const regex of patterns
    ) {

      let match;

      while (
        (match =
          regex.exec(
            html
          )) !== null
      ) {

        addCandidate(
          match[1] ||
          match[0],
          current
        );

      }

    }

    for (
      const candidate
      of candidates
    ) {

      const found =
        extractMercadoLivreItemId(
          candidate
        );

      if (found) {
        return found;
      }

    }

    const next =
      candidates
        .slice()
        .reverse()
        .find(
          x =>
            /^https?:\/\//i.test(
              x
            ) &&
            !visited.has(
              x
            )
        );

    if (next) {

      current =
        next;

      continue;

    }

    break;

  }

  throw new Error(
    "Não consegui identificar o ID do anúncio (MLB) nesse link."
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

  const token =
    await getMercadoLivreAccessToken();

  let response =
    await fetch(
      `https://api.mercadolibre.com/items/${encodeURIComponent(itemId)}`,
      {
        headers: {
          Authorization:
            `Bearer ${token}`,

          accept:
            "application/json"
        }
      }
    );

  let data =
    await response.json();

  // Token expirado
  if (
    response.status ===
    401
  ) {

    const renewed =
      await refreshMercadoLivreToken();

    response =
      await fetch(
        `https://api.mercadolibre.com/items/${encodeURIComponent(itemId)}`,
        {
          headers: {
            Authorization:
              `Bearer ${renewed.access_token}`,

            accept:
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
      "Falha ao consultar produto."
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
      data.title || "",

    price:
      data.price ?? null,

    oldPrice:
      data.original_price ?? null,

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
// AUTHENTICAÇÃO
// ======================================================

function authMiddleware(
  req,
  res,
  next
) {

  if (!API_TOKEN) {

    return res
      .status(503)
      .json({
        error:
          "API_TOKEN não configurado."
      });

  }

  const authorization =
    req.headers.authorization ||
    "";

  let token =
    "";

  if (
    authorization.startsWith(
      "Bearer "
    )
  ) {

    token =
      authorization
        .slice(7)
        .trim();

  }

  if (
    !token &&
    req.headers["x-api-token"]
  ) {

    token =
      String(
        req.headers[
          "x-api-token"
        ]
      ).trim();

  }

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
// RAIZ
// ======================================================

app.get(
  "/",
  (_req, res) => {

    res.json({

      ok:
        true,

      service:
        "OfertaZap API",

      version:
        "V12",

      status:
        connectionState

    });

  }
);

// ======================================================
// HEALTH PÚBLICO
// ======================================================

app.get(
  "/api/health",
  (_req, res) => {

    res.json({

      ok:
        true,

      service:
        "OfertaZap API",

      version:
        "V12",

      time:
        new Date().toISOString()

    });

  }
);

// ======================================================
// MERCADO LIVRE AUTH
// PÚBLICO
// ======================================================

app.get(
  "/api/mercadolivre/auth",
  (req, res) => {

    try {

      const authorizationUrl =
        buildMercadoLivreAuthUrl();

      // ?redirect=1
      // abre diretamente o Mercado Livre

      if (
        String(
          req.query.redirect ||
          ""
        ) === "1"
      ) {

        return res.redirect(
          authorizationUrl
        );

      }

      return res.json({

        ok:
          true,

        version:
          "V12",

        authorizationUrl

      });

    } catch (error) {

      return res
        .status(503)
        .json({

          ok:
            false,

          error:
            error.message

        });

    }

  }
);

// ======================================================
// CALLBACK OAUTH
// PÚBLICO
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
      } =
        req.query;

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

      return res.send(`
        <!DOCTYPE html>

        <html lang="pt-BR">

        <head>

          <meta charset="UTF-8">

          <meta
            name="viewport"
            content="width=device-width,initial-scale=1"
          >

          <title>
            OfertaZap
          </title>

        </head>

        <body style="
          font-family:Arial;
          background:#111;
          color:#fff;
          text-align:center;
          padding:50px;
        ">

          <h1>
            ✅ Mercado Livre conectado!
          </h1>

          <p>
            Sua conta foi autorizada com sucesso.
          </p>

          <p>
            Você pode fechar esta página
            e voltar ao OfertaZap.
          </p>

        </body>

        </html>
      `);

    } catch (error) {

      console.error(
        "OAuth:",
        error.message
      );

      return res
        .status(400)
        .send(`
          <h2>
            ❌ Erro ao conectar Mercado Livre
          </h2>

          <p>
            ${
              String(
                error.message
              ).replace(
                /[<>]/g,
                ""
              )
            }
          </p>
        `);

    }

  }
);

// ======================================================
// A PARTIR DAQUI API PROTEGIDA
// ======================================================

app.use(
  "/api",
  authMiddleware
);

// ======================================================
// STATUS MERCADO LIVRE
// ======================================================

app.get(
  "/api/mercadolivre/status",
  (_req, res) => {

    const missing =
      [];

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

      version:
        "V12",

      configured:
        missing.length === 0,

      clientId:
        Boolean(
          ML_CLIENT_ID
        ),

      clientSecret:
        Boolean(
          ML_CLIENT_SECRET
        ),

      redirectUri:
        Boolean(
          ML_REDIRECT_URI
        ),

      missing,

      connected:
        Boolean(
          mlTokens.access_token &&
          mlTokens.refresh_token
        ),

      userId:
        mlTokens.user_id ||
        null

    });

  }
);

// ======================================================
// PRODUTO
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
        String(
          link ||
          url ||
          ""
        ).trim();

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

      return res.json({

        ok:
          true,

        product

      });

    } catch (error) {

      console.error(
        "Produto:",
        error.message
      );

      return res
        .status(400)
        .json({

          ok:
            false,

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

      version:
        "V12",

      whatsapp:
        connectionState,

      qrAvailable:
        Boolean(qrDataUrl),

      groups:
        groups.length,

      jobs:
        jobs.length,

      mercadoLivre:
        mercadoLivreConfigured()
          ? "configured"
          : "not_configured",

      lastError

    });

  }
);

// ======================================================
// QR
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
            "QR Code não disponível."
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

      browser:
        [
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

        console.log(
          "WhatsApp desconectado:",
          lastError
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

                    connectionState =
                      "disconnected";

                    lastError =
                      error.message;

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
// START WHATSAPP
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
          Boolean(qrDataUrl)

      });

    } catch (error) {

      connectionState =
        "disconnected";

      lastError =
        error.message;

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
            "Informe name, inviteLink ou jid."
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

      const group = {

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
        group
      );

      saveJson(
        GROUPS_FILE,
        groups
      );

      res.json({

        ok:
          true,

        group

      });

    } catch (error) {

      res
        .status(400)
        .json({
          error:
            error.message
        });

    }

  }
);

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

app.post(
  "/api/groups/:id/join",
  async (
    req,
    res
  ) => {

    try {

      const group =
        groups.find(
          g =>
            g.id ===
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
              "Grupo não possui link de convite."
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

    } catch (error) {

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
        g =>
          g.id ===
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
      g =>
        g.id ===
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

  if (
    job.repeat ===
      "diaria"
  ) {

    const next =
      new Date(
        job.scheduledAt
      );

    next.setDate(
      next.getDate() + 1
    );

    job.scheduledAt =
      next.toISOString();

    job.status =
      "pending";

  } else if (
    job.repeat ===
      "semanal"
  ) {

    const next =
      new Date(
        job.scheduledAt
      );

    next.setDate(
      next.getDate() + 7
    );

    job.scheduledAt =
      next.toISOString();

    job.status =
