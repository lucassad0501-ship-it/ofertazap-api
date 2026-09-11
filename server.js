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
const API_TOKEN = process.env.API_TOKEN || "";
const TZ = process.env.TZ || "America/Sao_Paulo";

const ML_CLIENT_ID = process.env.ML_CLIENT_ID || "";
const ML_CLIENT_SECRET = process.env.ML_CLIENT_SECRET || "";
const ML_REDIRECT_URI =
  process.env.ML_REDIRECT_URI ||
  "https://ofertazap-api1.onrender.com/api/mercadolivre/callback";

app.use(cors({
  origin: process.env.FRONTEND_ORIGIN || "*"
}));

app.use(express.json({
  limit: "1mb"
}));

// ======================================================
// DIRETÓRIOS
// ======================================================

const DATA_DIR = path.resolve("./data");
const AUTH_DIR = path.resolve("./auth_info_baileys");

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(AUTH_DIR, { recursive: true });

const GROUPS_FILE = path.join(DATA_DIR, "groups.json");
const JOBS_FILE = path.join(DATA_DIR, "jobs.json");
const ML_TOKEN_FILE = path.join(DATA_DIR, "mercadolivre.json");

// ======================================================
// UTILITÁRIOS
// ======================================================

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

// ======================================================
// ESTADO
// ======================================================

let groups = loadJson(GROUPS_FILE, []);
let jobs = loadJson(JOBS_FILE, []);

let sock = null;
let qrDataUrl = null;
let connectionState = "disconnected";
let lastError = null;

let mlOAuthState = null;
let mlTokens = loadJson(ML_TOKEN_FILE, {});

// ======================================================
// MERCADO LIVRE - CONFIGURAÇÃO
// ======================================================

function requireMercadoLivreConfig() {
  if (
    !ML_CLIENT_ID ||
    !ML_CLIENT_SECRET ||
    !ML_REDIRECT_URI
  ) {
    throw new Error(
      "Mercado Livre OAuth não configurado. Verifique ML_CLIENT_ID, ML_CLIENT_SECRET e ML_REDIRECT_URI no Render."
    );
  }
}

// ======================================================
// MERCADO LIVRE - URL OAUTH
// ======================================================

function buildMercadoLivreAuthUrl() {
  requireMercadoLivreConfig();

  mlOAuthState = crypto
    .randomBytes(24)
    .toString("hex");

  const url = new URL(
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
// MERCADO LIVRE - TROCAR CODE POR TOKEN
// ======================================================

async function exchangeMercadoLivreCode(code) {
  requireMercadoLivreConfig();

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: ML_CLIENT_ID,
    client_secret: ML_CLIENT_SECRET,
    code,
    redirect_uri: ML_REDIRECT_URI
  });

  const response = await fetch(
    "https://api.mercadolibre.com/oauth/token",
    {
      method: "POST",

      headers: {
        accept: "application/json",
        "content-type":
          "application/x-www-form-urlencoded"
      },

      body
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data.error_description ||
      data.message ||
      "Falha ao obter token do Mercado Livre"
    );
  }

  mlTokens = {
    ...data,
    savedAt: new Date().toISOString()
  };

  saveJson(
    ML_TOKEN_FILE,
    mlTokens
  );

  return data;
}

// ======================================================
// MERCADO LIVRE - RENOVAR TOKEN
// ======================================================

async function refreshMercadoLivreToken() {
  requireMercadoLivreConfig();

  if (!mlTokens.refresh_token) {
    throw new Error(
      "Mercado Livre ainda não foi autorizado. Conecte a conta primeiro."
    );
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: ML_CLIENT_ID,
    client_secret: ML_CLIENT_SECRET,
    refresh_token: mlTokens.refresh_token
  });

  const response = await fetch(
    "https://api.mercadolibre.com/oauth/token",
    {
      method: "POST",

      headers: {
        accept: "application/json",
        "content-type":
          "application/x-www-form-urlencoded"
      },

      body
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data.error_description ||
      data.message ||
      "Falha ao renovar token do Mercado Livre"
    );
  }

  mlTokens = {
    ...data,
    savedAt: new Date().toISOString()
  };

  saveJson(
    ML_TOKEN_FILE,
    mlTokens
  );

  return data;
}

// ======================================================
// MERCADO LIVRE - TOKEN ATUAL
// ======================================================

async function getMercadoLivreAccessToken() {
  if (!mlTokens.access_token) {
    throw new Error(
      "Mercado Livre não conectado. Autorize a conta primeiro."
    );
  }

  const savedAt = new Date(
    mlTokens.savedAt || 0
  ).getTime();

  const expiresAt =
    savedAt +
    Number(
      mlTokens.expires_in || 21600
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
// MERCADO LIVRE - EXTRAIR IDs
// ======================================================

function extractMercadoLivreItemIds(value) {
  const text = String(value || "");

  const matches =
    text.match(
      /\bMLB[-_]?\d{6,}\b/gi
    ) || [];

  return [
    ...new Set(
      matches.map(id =>
        id
          .replace(/[-_]/g, "")
          .toUpperCase()
      )
    )
  ];
}

function extractMercadoLivreItemId(value) {
  return (
    extractMercadoLivreItemIds(value)[0] ||
    null
  );
}

// ======================================================
// MERCADO LIVRE - RESOLVEDOR INTELIGENTE
// ======================================================
//
// IMPORTANTE:
// Não confia simplesmente no primeiro MLB encontrado.
// Cada ID é validado na API oficial.
//
// ======================================================

async function resolveMercadoLivreItemId(
  value,
  accessToken
) {
  const original =
    String(value || "").trim();

  if (!original) {
    throw new Error(
      "Informe o link do Mercado Livre."
    );
  }

  if (!accessToken) {
    throw new Error(
      "Mercado Livre não conectado. Autorize a conta primeiro."
    );
  }

  // ----------------------------------------------------
  // VALIDA UM ITEM DIRETAMENTE NA API
  // ----------------------------------------------------

  async function validarItem(itemId) {
    try {
      const response = await fetch(
        `https://api.mercadolibre.com/items/${encodeURIComponent(itemId)}`,
        {
          headers: {
            Authorization:
              `Bearer ${accessToken}`,

            Accept:
              "application/json"
          }
        }
      );

      if (!response.ok) {
        return null;
      }

      const data =
        await response.json();

      if (
        !data ||
        !data.id
      ) {
        return null;
      }

      return data;
    } catch {
      return null;
    }
  }

  // ----------------------------------------------------
  // SE JÁ EXISTE MLB NA URL
  // ----------------------------------------------------

  const directIds =
    extractMercadoLivreItemIds(
      original
    );

  for (const itemId of directIds) {
    const valid =
      await validarItem(itemId);

    if (valid) {
      return valid.id;
    }
  }

  // ----------------------------------------------------
  // VERIFICA URL
  // ----------------------------------------------------

  if (
    !/^https?:\/\//i.test(
      original
    )
  ) {
    throw new Error(
      "Digite uma URL válida do Mercado Livre."
    );
  }

  // ----------------------------------------------------
  // CANDIDATOS
  // ----------------------------------------------------

  const candidates = [
    original
  ];

  const visited =
    new Set();

  let current =
    original;

  function addCandidate(
    valueToAdd,
    base = current
  ) {
    if (!valueToAdd) return;

    let text =
      String(valueToAdd).trim();

    text =
      text
        .replace(
          /\\u0026/g,
          "&"
        )
        .replace(
          /\\\//g,
          "/"
        )
        .replace(
          /&amp;/gi,
          "&"
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
      text &&
      !candidates.includes(text)
    ) {
      candidates.push(text);
    }
  }

  // ----------------------------------------------------
  // PERCORRE REDIRECIONAMENTOS
  // ----------------------------------------------------

  for (
    let step = 0;
    step < 10;
    step++
  ) {
    if (
      visited.has(current)
    ) {
      break;
    }

    visited.add(current);

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
                "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/120 Safari/537.36",

              accept:
                "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",

              "accept-language":
                "pt-BR,pt;q=0.9,en;q=0.8"
            }
          }
        );
    } catch {
      throw new Error(
        "Não consegui abrir o link do Mercado Livre. Confira se o link está correto."
      );
    }

    addCandidate(
      response.url ||
        current,
      current
    );

    // --------------------------------------------------
    // LOCATION
    // --------------------------------------------------

    const location =
      response.headers.get(
        "location"
      );

    if (location) {
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

    // --------------------------------------------------
    // HTML
    // --------------------------------------------------

    let html = "";

    try {
      html =
        await response.text();
    } catch {}

    // --------------------------------------------------
    // PADRÕES DE URL
    // --------------------------------------------------

    const patterns = [
      /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/gi,

      /<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/gi,

      /(?:canonical|og:url)[^>]+(?:href|content)=["']([^"']+)["']/gi,

      /<meta[^>]+http-equiv=["']refresh["'][^>]+content=["'][^"']*url=([^"']+)["']/gi,

      /(?:window\.)?location(?:\.href|\.replace|\.assign)?\s*(?:=|\()\s*["']([^"']+)["']/gi,

      /https?:\\?\/\\?\/[^\s"'<>\\]+/gi
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

    // --------------------------------------------------
    // COLETA TODOS OS MLB
    // --------------------------------------------------

    const allIds = [];

    for (
      const candidate
      of candidates
    ) {
      for (
        const id
        of extractMercadoLivreItemIds(
          candidate
        )
      ) {
        if (
          !allIds.includes(id)
        ) {
          allIds.push(id);
        }
      }
    }

    // --------------------------------------------------
    // TESTA TODOS OS IDS
    // --------------------------------------------------

    for (
      const id of allIds
    ) {
      const valid =
        await validarItem(id);

      if (valid) {
        console.log(
          `[Mercado Livre] Item válido encontrado: ${valid.id}`
        );

        return valid.id;
      }

      console.log(
        `[Mercado Livre] Item ignorado (não encontrado): ${id}`
      );
    }

    // --------------------------------------------------
    // PRÓXIMA URL
    // --------------------------------------------------

    const next =
      candidates
        .slice()
        .reverse()
        .find(
          url =>
            /^https?:\/\//i.test(
              url
            ) &&
            !visited.has(
              url
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
    "Não consegui encontrar um anúncio válido do Mercado Livre nesse link. O link pode ter expirado, apontar para uma página intermediária ou o anúncio pode ter sido removido."
  );
}

// ======================================================
// MERCADO LIVRE - BUSCAR PRODUTO
// ======================================================

async function getMercadoLivreProduct(value) {
  let accessToken =
    await getMercadoLivreAccessToken();

  const itemId =
    await resolveMercadoLivreItemId(
      value,
      accessToken
    );

  async function buscarItem(token) {
    return fetch(
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
  }

  let response =
    await buscarItem(
      accessToken
    );

  // ----------------------------------------------------
  // TOKEN EXPIRADO
  // ----------------------------------------------------

  if (
    response.status === 401
  ) {
    const refreshed =
      await refreshMercadoLivreToken();

    accessToken =
      refreshed.access_token;

    response =
      await buscarItem(
        accessToken
      );
  }

  let data = {};

  try {
    data =
      await response.json();
  } catch {}

  if (!response.ok) {
    throw new Error(
      data.message ||
      data.error_description ||
      data.error ||
      `Não foi possível consultar o anúncio ${itemId}.`
    );
  }

  // ----------------------------------------------------
  // IMAGENS
  // ----------------------------------------------------

  const pictures =
    Array.isArray(
      data.pictures
    )
      ? data.pictures
          .map(
            p =>
              p.secure_url ||
              p.url
          )
          .filter(Boolean)
      : [];

  // ----------------------------------------------------
  // PRODUTO
  // ----------------------------------------------------

  return {
    id:
      data.id,

    title:
      data.title || "",

    price:
      data.price ?? null,

    oldPrice:
      data.original_price ??
      null,

    currency:
      data.currency_id ||
      "BRL",

    image:
      pictures[0] ||
      null,

    pictures,

    permalink:
      data.permalink ||
      null
  };
}

// ======================================================
// MERCADO LIVRE - CALLBACK OAUTH
// ======================================================
//
// Público porque o Mercado Livre redireciona o navegador.
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

      if (error) {
        return res
          .status(400)
          .send(
            `Autorização cancelada: ${
              error_description ||
              error
            }`
          );
      }

      if (!code) {
        return res
          .status(400)
          .send(
            "Código de autorização não recebido."
          );
      }

      if (
        !mlOAuthState ||
        state !== mlOAuthState
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

      res.send(`
        <h2>OfertaZap conectado ao Mercado Livre ✅</h2>
        <p>Você pode fechar esta página e voltar ao painel.</p>
      `);

    } catch (err) {
      res
        .status(400)
        .send(`
          <h2>Erro ao conectar Mercado Livre</h2>
          <p>${String(
            err.message
          ).replace(
            /[<>]/g,
            ""
          )}</p>
        `);
    }
  }
);

// ======================================================
// AUTENTICAÇÃO DA API
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
          "API_TOKEN não configurado no servidor"
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
    token !== API_TOKEN
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
      ok: true,
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
// HEALTH PÚBLICO
// ======================================================

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

// ======================================================
// MERCADO LIVRE - INICIAR OAUTH
// ======================================================
//
// IMPORTANTE:
// Fica antes do authMiddleware.
// Assim o navegador consegue iniciar o OAuth.
// ======================================================

app.get(
  "/api/mercadolivre/auth",
  (
    req,
    res
  ) => {
    try {
      const authorizationUrl =
        buildMercadoLivreAuthUrl();

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
        ok: true,
        authorizationUrl
      });

    } catch (err) {
      return res
        .status(503)
        .json({
          ok: false,
          error:
            err.message
        });
    }
  }
);

// ======================================================
// TODAS AS OUTRAS ROTAS /API EXIGEM TOKEN
// ======================================================

app.use(
  "/api",
  authMiddleware
);

// ======================================================
// MERCADO LIVRE - STATUS
// ======================================================

app.get(
  "/api/mercadolivre/status",
  (_req, res) => {
    const missing = [];

    if (!ML_CLIENT_ID) {
      missing.push(
        "ML_CLIENT_ID"
      );
    }

    if (!ML_CLIENT_SECRET) {
      missing.push(
        "ML_CLIENT_SECRET"
      );
    }

    if (!ML_REDIRECT_URI) {
      missing.push(
        "ML_REDIRECT_URI"
      );
    }

    res.json({
      ok: true,

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
// MERCADO LIVRE - PREVIEW DO PRODUTO
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
      } = req.body || {};

      const productLink =
        link || url;

      if (!productLink) {
        return res
          .status(400)
          .json({
            error:
              "Informe o link do Mercado Livre"
          });
      }

      const product =
        await getMercadoLivreProduct(
          productLink
        );

      res.json({
        ok: true,
        product
      });

    } catch (err) {
      res
        .status(400)
        .json({
          error:
            err.message
        });
    }
  }
);

// ======================================================
// STATUS GERAL
// ======================================================

app.get(
  "/api/status",
  (_req, res) => {
    res.json({
      ok: true,

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
// WHATSAPP - QR CODE
// ======================================================

app.get(
  "/api/whatsapp/qr",
  (_req, res) => {
    if (!qrDataUrl) {
      return res
        .status(404)
        .json({
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

// ======================================================
// WHATSAPP - INICIAR
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

      if (qr) {
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
            lastDisconnect
              ?.error
          )
            ?.output
            ?.statusCode;

        lastError =
          String(
            code ||
            lastDisconnect
              ?.error
              ?.message ||
            "Conexão encerrada"
          );

        if (
          code !==
          DisconnectReason.loggedOut
        ) {
          setTimeout(
            () =>
              startWhatsApp()
                .catch(
                  err => {
                    lastError =
                      err.message;

                    connectionState =
                      "disconnected";
                  }
                ),
            5000
          );
        }
      }
    }
  );
}

// ======================================================
// WHATSAPP - START API
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
        ok: true,

        status:
          connectionState,

        qrAvailable:
          Boolean(
            qrDataUrl
          )
      });

    } catch (err) {
      lastError =
        err.message;

      connectionState =
        "disconnected";

      res
        .status(500)
        .json({
          error:
            err.message
        });
    }
  }
);

// ======================================================
// WHATSAPP - CONVITE
// ======================================================

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

// ======================================================
// GRUPOS - LISTAR
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
// GRUPOS - ADICIONAR
// ======================================================

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
      jid || null;

    let groupName =
      name ||
      "Grupo WhatsApp";

    try {
      if (!sock) {
        return res
          .status(409)
          .json({
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
          return res
            .status(400)
            .json({
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
      res
        .status(400)
        .json({
          error:
            err.message
        });
    }
  }
);

// ======================================================
// GRUPOS - EXCLUIR
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
// GRUPOS - ENTRAR
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
          g =>
            g.id ===
            req.params.id
        );

      if (!group) {
        return res
          .status(404)
          .json({
            error:
              "Grupo não encontrado"
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
              "WhatsApp não está conectado"
          });
      }

      if (
        !group.inviteLink
      ) {
        return res
          .status(400)
          .json({
            error:
              "Este grupo não possui link de convite"
          });
      }

      const code =
        extractInviteCode(
          group.inviteLink
        );

      if (!code) {
        return res
          .status(400)
          .json({
            error:
              "Link de convite inválido"
          });
      }

      const jid =
        await sock.groupAcceptInvite(
          code
        );

      if (jid) {
        group.jid =
          jid;
      }

      saveJson(
        GROUPS_FILE,
        groups
      );

      res.json({
        ok: true,

        message:
          "Grupo conectado.",

        group
      });

    } catch (err) {
      res
        .status(400)
        .json({
          error:
            err.message
        });
    }
  }
);

// ======================================================
// AGENDAMENTOS - LISTAR
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
// AGENDAMENTOS - CRIAR
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
            "groupId, message e scheduledAt são obrigatórios"
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
            "Repetição inválida. Use unica, diaria ou semanal."
        });
    }

    const group =
      groups.find(
        g =>
          g.id ===
          groupId
      );

    if (!group) {
      return res
        .status(404)
        .json({
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
      ok: true,
      job
    });
  }
);

// ======================================================
// ENVIO DO AGENDAMENTO
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

  // ----------------------------------------------------
  // REPETIÇÃO
  // ----------------------------------------------------

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
// AGENDAMENTO - ENVIAR AGORA
// ======================================================

app.post(
  "/api/jobs/:id/send",
  async (
    req,
    res
  ) => {
    const job =
      jobs.find(
        j =>
          j.id ===
          req.params.id
      );

    if (!job) {
      return res
        .status(404)
        .json({
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

      saveJson(
        JOBS_FILE,
        jobs
      );

      res
        .status(400)
        .json({
          error:
            err.message,

          job
        });
    }
  }
);

// ======================================================
// AGENDAMENTO - EXCLUIR
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
// PROCESSAR AGENDAMENTOS
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
      ) ||
      when > now
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

// ======================================================
// CRON - A CADA MINUTO
// ======================================================

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
  }
);
