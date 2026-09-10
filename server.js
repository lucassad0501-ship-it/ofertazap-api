import "dotenv/config";
import express from "express";
import cors from "cors";
import cron from "node-cron";
import QRCode from "qrcode";
import pino from "pino";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  default as makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore
} from "@whiskeysockets/baileys";

import { Boom } from "@hapi/boom";

// ======================================================
// OFERTAZAP API V12
// ======================================================

const APP_VERSION = "V12";

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
// DIRETÓRIOS
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

function loadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) {
      return fallback;
    }

    return JSON.parse(
      fs.readFileSync(file, "utf8")
    );
  } catch (error) {
    console.error(
      `Erro lendo ${file}:`,
      error.message
    );

    return fallback;
  }
}

function saveJson(file, data) {
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
      `Erro salvando ${file}:`,
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
// WHATSAPP
// ======================================================

let sock = null;

let qrDataUrl = null;

let connectionState =
  "disconnected";

let lastError = null;

// ======================================================
// OAUTH
// ======================================================

let oauthState = null;

// ======================================================
// FUNÇÕES MERCADO LIVRE
// ======================================================

function getMissingMercadoLivreVars() {

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

  return missing;
}

function mercadoLivreConfigured() {

  return (
    Boolean(ML_CLIENT_ID) &&
    Boolean(ML_CLIENT_SECRET) &&
    Boolean(ML_REDIRECT_URI)
  );

}

// ======================================================
// OAUTH URL
// ======================================================

function buildMercadoLivreAuthUrl() {

  const missing =
    getMissingMercadoLivreVars();

  if (missing.length) {

    throw new Error(
      "Mercado Livre OAuth não configurado. " +
      "Variáveis ausentes: " +
      missing.join(", ")
    );

  }

  oauthState =
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
    oauthState
  );

  url.searchParams.set(
    "scope",
    "offline_access read write"
  );

  return url.toString();
}

// ======================================================
// TOKEN
// ======================================================

async function exchangeCode(code) {

  if (
    !mercadoLivreConfigured()
  ) {

    throw new Error(
      "Mercado Livre OAuth não configurado."
    );

  }

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
// REFRESH TOKEN
// ======================================================

async function refreshToken() {

  if (
    !mlTokens.refresh_token
  ) {

    throw new Error(
      "Refresh token do Mercado Livre não encontrado."
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
      "Erro ao renovar token do Mercado Livre."
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

async function getAccessToken() {

  if (
    !mlTokens.access_token
  ) {

    throw new Error(
      "Mercado Livre ainda não conectado."
    );

  }

  const saved =
    new Date(
      mlTokens.savedAt || 0
    ).getTime();

  const expires =
    saved +
    Number(
      mlTokens.expires_in || 21600
    ) *
    1000;

  if (
    Date.now() <
    expires - 120000
  ) {

    return mlTokens.access_token;

  }

  const renewed =
    await refreshToken();

  return renewed.access_token;
}

// ======================================================
// EXTRAIR MLB
// ======================================================

function extractMLB(value) {

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

async function resolveMLB(value) {

  const original =
    String(
      value || ""
    ).trim();

  if (!original) {

    throw new Error(
      "Informe o link do Mercado Livre."
    );

  }

  // Link direto
  const direct =
    extractMLB(original);

  if (direct) {
    return direct;
  }

  let current =
    original;

  const visited =
    new Set();

  const candidates =
    [];

  function addCandidate(value) {

    if (!value) {
      return;
    }

    let text =
      String(value)
        .trim()
        .replace(
          /\\u0026/g,
          "&"
        )
        .replace(
          /\\\//g,
          "/"
        );

    candidates.push(
      text
    );
  }

  for (
    let i = 0;
    i < 10;
    i++
  ) {

    if (
      visited.has(current)
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
                "text/html,application/xhtml+xml," +
                "application/json;q=0.9,*/*;q=0.8",

              "accept-language":
                "pt-BR,pt;q=0.9"
            }
          }
        );

    } catch (error) {

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

    if (location) {

      try {

        const next =
          new URL(
            location,
            current
          ).toString();

        addCandidate(
          next
        );

        const found =
          extractMLB(next);

        if (found) {
          return found;
        }

        current =
          next;

        continue;

      } catch {}

    }

    let html = "";

    try {
      html =
        await response.text();
    } catch {}

    // Procurar MLB no HTML
    const htmlIds =
      html.match(
        /\bMLB[-_]?\d{6,}\b/gi
      ) || [];

    if (
      htmlIds.length
    ) {

      return extractMLB(
        htmlIds[0]
      );

    }

    // Canonical
    const canonical =
      html.match(
        /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i
      );

    if (
      canonical?.[1]
    ) {

      addCandidate(
        canonical[1]
      );

    }

    // OG URL
    const og =
      html.match(
        /<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i
      );

    if (
      og?.[1]
    ) {

      addCandidate(
        og[1]
      );

    }

    // Procurar URLs completas
    const urls =
      html.match(
        /https?:\/\/[^\s"'<>]+/gi
      ) || [];

    for (
      const url
      of urls
    ) {

      addCandidate(
        url
      );

    }

    // Verificar candidatos
    for (
      const candidate
      of candidates
    ) {

      const found =
        extractMLB(
          candidate
        );

      if (found) {
        return found;
      }

    }

    // Tentar próxima URL
    const nextUrl =
      candidates
        .reverse()
        .find(
          candidate =>
            /^https?:\/\//i.test(
              candidate
            ) &&
            !visited.has(
              candidate
            )
        );

    if (nextUrl) {

      current =
        nextUrl;

      continue;

    }

    break;
  }

  throw new Error(
    "Não consegui identificar o ID do anúncio (MLB) nesse link."
  );
}

// ======================================================
// PRODUTO MERCADO LIVRE
// ======================================================

async function getProduct(link) {

  const itemId =
    await resolveMLB(
      link
    );

  const token =
    await getAccessToken();

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
    response.status === 401
  ) {

    const renewed =
      await refreshToken();

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

  if (!response.ok) {

    throw new Error(
      data.message ||
      data.error ||
      "Erro ao consultar produto."
    );

  }

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
// AUTENTICAÇÃO API
// ======================================================

function authenticate(
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

  const bearer =
    authorization.startsWith(
      "Bearer "
    )
      ? authorization.substring(7)
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
        APP_VERSION,

      time:
        new Date().toISOString()

    });

  }
);

// ======================================================
// DIAGNÓSTICO PÚBLICO
// NÃO MOSTRA SEGREDO
// ======================================================

app.get(
  "/api/mercadolivre/diagnostico",
  (_req, res) => {

    const missing =
      getMissingMercadoLivreVars();

    res.json({

      ok:
        true,

      version:
        APP_VERSION,

      mercadoLivre: {

        configured:
          missing.length === 0,

        clientId:
          Boolean(ML_CLIENT_ID),

        clientSecret:
          Boolean(ML_CLIENT_SECRET),

        redirectUri:
          Boolean(ML_REDIRECT_URI),

        missing,

        connected:
          Boolean(
            mlTokens.access_token
          )

      }

    });

  }
);

// ======================================================
// PROTEGER DEMAIS API
// ======================================================

app.use(
  "/api",
  authenticate
);

// ======================================================
// STATUS
// ======================================================

app.get(
  "/api/status",
  (_req, res) => {

    const missing =
      getMissingMercadoLivreVars();

    res.json({

      ok:
        true,

      version:
        APP_VERSION,

      whatsapp: {
        status:
          connectionState,

        qrAvailable:
          Boolean(qrDataUrl)
      },

      groups:
        groups.length,

      jobs:
        jobs.length,

      mercadoLivre: {

        configured:
          missing.length === 0,

        connected:
          Boolean(
            mlTokens.access_token
          ),

        missing

      },

      lastError

    });

  }
);

// ======================================================
// MERCADO LIVRE STATUS
// ======================================================

app.get(
  "/api/mercadolivre/status",
  (_req, res) => {

    const missing =
      getMissingMercadoLivreVars();

    res.json({

      ok:
        true,

      version:
        APP_VERSION,

      configured:
        missing.length === 0,

      missing,

      connected:
        Boolean(
          mlTokens.access_token
        ),

      diagnostics: {

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
          )

      }

    });

  }
);

// ======================================================
// MERCADO LIVRE AUTH
// ======================================================

app.get(
  "/api/mercadolivre/auth",
  (_req, res) => {

    try {

      const url =
        buildMercadoLivreAuthUrl();

      res.json({

        ok:
          true,

        version:
          APP_VERSION,

        authorizationUrl:
          url

      });

    } catch (error) {

      res
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
            `Erro: ${
              error_description ||
              error
            }`
          );

      }

      if (!code) {

        return res
          .status(400)
          .send(
            "Código OAuth não recebido."
          );

      }

      if (
        !oauthState ||
        state !== oauthState
      ) {

        return res
          .status(400)
          .send(
            "Estado OAuth inválido ou expirado."
          );

      }

      await exchangeCode(
        code
      );

      oauthState =
        null;

      res.send(
        `
        <!DOCTYPE html>

        <html lang="pt-BR">

        <head>

          <meta charset="UTF-8">

          <meta name="viewport"
            content="width=device-width,initial-scale=1">

          <title>OfertaZap</title>

          <style>

            body{
              font-family:Arial;
              background:#07110d;
              color:white;
              text-align:center;
              padding:50px 20px;
            }

            .box{
              max-width:500px;
              margin:auto;
              padding:30px;
              border-radius:20px;
              background:#102019;
            }

            h1{
              color:#20d66b;
            }

          </style>

        </head>

        <body>

          <div class="box">

            <h1>
              ✅ Mercado Livre conectado!
            </h1>

            <p>
              A conta foi autorizada
              com sucesso.
            </p>

            <p>
              Você pode fechar esta página
              e voltar ao OfertaZap.
            </p>

          </div>

        </body>

        </html>
        `
      );

    } catch (error) {

      console.error(
        "OAuth:",
        error.message
      );

      res
        .status(400)
        .send(
          `Erro OAuth: ${error.message}`
        );

    }

  }
);

// ======================================================
// PRODUTO PREVIEW
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

      if (!productLink) {

        return res
          .status(400)
          .json({
            error:
              "Informe o link do produto."
          });

      }

      console.log(
        "Buscando produto:",
        productLink
      );

      const product =
        await getProduct(
          productLink
        );

      res.json({

        ok:
          true,

        version:
          APP_VERSION,

        product

      });

    } catch (error) {

      console.error(
        "Produto:",
        error.message
      );

      res
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
// GRUPOS
// ======================================================

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
  (
    req,
    res
  ) => {

    const {
      id,
      name,
      jid,
      inviteLink
    } =
      req.body || {};

    if (!name) {

      return res
        .status(400)
        .json({
          error:
            "Nome do grupo obrigatório."
        });

    }

    const group = {

      id:
        id ||
        crypto.randomUUID(),

      name,

      jid:
        jid ||
        null,

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

  }
);

app.delete(
  "/api/groups/:id",
  (
    req,
    res
  ) => {

    const old =
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
        old !== groups.length

    });

  }
);

// ======================================================
// JOBS
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

    const allowed =
      [
        "unica",
        "diaria",
        "semanal"
      ];

    if (
      !allowed.includes(
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

    if (!group) {

      return res
        .status(404)
        .json({
          error:
            "Grupo não encontrado."
        });

    }

    const job = {

      id:
        crypto.randomUUID(),

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

async function sendJob(job) {

  if (
    !sock ||
    connectionState !==
      "connected"
  ) {

    throw new Error(
      "WhatsApp não conectado."
    );

  }

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
      "Grupo não possui JID."
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

    return;
  }

  if (
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
      "pending";

    return;
  }

  job.status =
    "sent";
}

// ======================================================
// ENVIO MANUAL
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

    } catch (error) {

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

          ok:
            false,

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
        j =>
          j.id !==
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
        before !== jobs.length

    });

  }
);

// ======================================================
// PROCESSADOR DOS AGENDAMENTOS
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

    const scheduled =
      new Date(
        job.scheduledAt
      ).getTime();

    if (
      !Number.isFinite(
        scheduled
      )
    ) {

      job.status =
        "error";

      job.error =
        "Data inválida.";

      continue;
    }

    if (
      scheduled > now
    ) {

      continue;
    }

    try {

      await sendJob(
        job
      );

      console.log(
        "Mensagem enviada:",
        job.id
      );

    } catch (error) {

      console.error(
        "Erro envio:",
        error.message
      );

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

  try {

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
      async update => {

        const {
          connection,
          lastDisconnect,
          qr
        } = update;

        if (qr) {

          qrDataUrl =
            await QRCode.toDataURL(
              qr
            );

          console.log(
            "Novo QR Code disponível."
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

          const statusCode =
            new Boom(
              lastDisconnect?.error
            )
              ?.output
              ?.statusCode;

          lastError =
            String(
              statusCode ||
              lastDisconnect?.error?.message ||
              "Conexão encerrada"
            );

          console.log(
            "WhatsApp desconectado:",
            lastError
          );

          if (
            statusCode !==
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

  } catch (error) {

    connectionState =
      "disconnected";

    lastError =
      error.message;

    console.error(
      "WhatsApp:",
      error.message
    );

  }
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

        version:
          APP_VERSION,

        status:
          connectionState,

        qrAvailable:
          Boolean(qrDataUrl)

      });

    } catch (error) {

      res
        .status(500)
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
// QR
// ======================================================

app.get(
  "/api/whatsapp/qr",
  (_req, res) => {

    if (!qrDataUrl) {

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
// START SERVER
// ======================================================

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      "===================================="
    );

    console.log(
      `OfertaZap API ${APP_VERSION}`
    );

    console.log(
      `Porta: ${PORT}`
    );

    console.log(
      `Timezone: ${TZ}`
    );

    console.log(
      "Mercado Livre OAuth:",
      mercadoLivreConfigured()
        ? "CONFIGURADO"
        : "NÃO CONFIGURADO"
    );

    console.log(
      "ML_CLIENT_ID:",
      ML_CLIENT_ID
        ? "OK"
        : "AUSENTE"
    );

    console.log(
      "ML_CLIENT_SECRET:",
      ML_CLIENT_SECRET
        ? "OK"
        : "AUSENTE"
    );

    console.log(
      "ML_REDIRECT_URI:",
      ML_REDIRECT_URI
        ? "OK"
        : "AUSENTE"
    );

    console.log(
      "===================================="
    );

  }
);
