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
import puppeteer from "puppeteer";

const app = express();
const PORT = Number(process.env.PORT || 3000);
const API_TOKEN = process.env.API_TOKEN || "";
const TZ = process.env.TZ || "America/Sao_Paulo";
const ML_CLIENT_ID = process.env.ML_CLIENT_ID || "";
const ML_CLIENT_SECRET = process.env.ML_CLIENT_SECRET || "";
const ML_REDIRECT_URI = process.env.ML_REDIRECT_URI || "https://ofertazap-api1.onrender.com/api/mercadolivre/callback";

app.use(cors({ origin: process.env.FRONTEND_ORIGIN || "*" }));
app.use(express.json({ limit: "5mb" }));

const DATA_DIR = path.resolve(process.env.DATA_DIR || "./data");
const AUTH_DIR = path.resolve(process.env.BAILEYS_AUTH_DIR || "./auth_info_baileys");
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(AUTH_DIR, { recursive: true });

const GROUPS_FILE = path.join(DATA_DIR, "groups.json");
const JOBS_FILE = path.join(DATA_DIR, "jobs.json");
const PRODUCTS_FILE = path.join(DATA_DIR, "products.json");
const ML_TOKEN_FILE = path.join(DATA_DIR, "mercadolivre.json");

function loadJson(file, fallback = []) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function saveJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

let groups = loadJson(GROUPS_FILE, []);
let jobs = loadJson(JOBS_FILE, []);
let products = loadJson(PRODUCTS_FILE, []);
let sock = null;
let qrDataUrl = null;
let connectionState = "disconnected";
let lastError = null;
let mlOAuthState = null;
let mlTokens = loadJson(ML_TOKEN_FILE, {});


function requireMercadoLivreConfig() {
  if (!ML_CLIENT_ID || !ML_CLIENT_SECRET || !ML_REDIRECT_URI) {
    throw new Error("Mercado Livre OAuth não configurado. Verifique ML_CLIENT_ID, ML_CLIENT_SECRET e ML_REDIRECT_URI no Render.");
  }
}

function buildMercadoLivreAuthUrl() {
  requireMercadoLivreConfig();
  mlOAuthState = crypto.randomBytes(24).toString("hex");
  const url = new URL("https://auth.mercadolivre.com.br/authorization");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", ML_CLIENT_ID);
  url.searchParams.set("redirect_uri", ML_REDIRECT_URI);
  url.searchParams.set("state", mlOAuthState);
  url.searchParams.set("scope", "offline_access read write");
  return url.toString();
}

async function exchangeMercadoLivreCode(code) {
  requireMercadoLivreConfig();
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: ML_CLIENT_ID,
    client_secret: ML_CLIENT_SECRET,
    code,
    redirect_uri: ML_REDIRECT_URI
  });
  const response = await fetch("https://api.mercadolibre.com/oauth/token", {
    method: "POST",
    headers: { "accept": "application/json", "content-type": "application/x-www-form-urlencoded" },
    body
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error_description || data.message || "Falha ao obter token do Mercado Livre");
  mlTokens = { ...data, savedAt: new Date().toISOString() };
  saveJson(ML_TOKEN_FILE, mlTokens);
  return data;
}

async function refreshMercadoLivreToken() {
  requireMercadoLivreConfig();
  if (!mlTokens.refresh_token) throw new Error("Mercado Livre ainda não foi autorizado. Conecte a conta primeiro.");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: ML_CLIENT_ID,
    client_secret: ML_CLIENT_SECRET,
    refresh_token: mlTokens.refresh_token
  });
  const response = await fetch("https://api.mercadolibre.com/oauth/token", {
    method: "POST",
    headers: { "accept": "application/json", "content-type": "application/x-www-form-urlencoded" },
    body
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error_description || data.message || "Falha ao renovar token do Mercado Livre");
  mlTokens = { ...data, savedAt: new Date().toISOString() };
  saveJson(ML_TOKEN_FILE, mlTokens);
  return data;
}

async function getMercadoLivreAccessToken() {
  if (!mlTokens.access_token) throw new Error("Mercado Livre não conectado. Autorize a conta primeiro.");
  const savedAt = new Date(mlTokens.savedAt || 0).getTime();
  const expiresAt = savedAt + Number(mlTokens.expires_in || 21600) * 1000;
  if (Date.now() < expiresAt - 120000) return mlTokens.access_token;
  const refreshed = await refreshMercadoLivreToken();
  return refreshed.access_token;
}

function extractMercadoLivreItemIds(value) {
  const text = String(value || "");
  const matches = text.match(/\bMLB[-_]?\d{6,}\b/gi) || [];
  return [...new Set(matches.map(id => id.replace(/[-_]/g, "").toUpperCase()))];
}

function extractMercadoLivreItemId(value) {
  return extractMercadoLivreItemIds(value)[0] || null;
}

// ======================================================
// MERCADO LIVRE - RESOLVEDOR INTELIGENTE
// Não confia no primeiro MLB encontrado.
// Cada candidato é validado na API oficial do Mercado Livre.
// ======================================================
async function resolveMercadoLivreItemId(value, accessToken) {
  const original = String(value || '').trim();
  if (!original) throw new Error('Informe o link do Mercado Livre.');
  if (!accessToken) throw new Error('Mercado Livre não conectado. Autorize a conta primeiro.');

  async function validarItem(itemId) {
    try {
      const r = await fetch(`https://api.mercadolibre.com/items/${encodeURIComponent(itemId)}`, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
      });
      if (!r.ok) return null;
      const data = await r.json();
      return data?.id ? data : null;
    } catch { return null; }
  }

  function normalizarId(v) {
    if (!v) return null;
    return String(v).replace(/[-_\s]/g, '').toUpperCase();
  }

  function extrairCandidatosProfundos(text) {
    const raw = String(text || '');
    const ids = new Set(extractMercadoLivreItemIds(raw));
    const patterns = [
      /(?:item[_-]?id|itemId|product[_-]?id|productId|catalog[_-]?product[_-]?id|catalogProductId|listing[_-]?id|listingId)\s*[:=]\s*["']?(MLB[-_]?\d{6,})["']?/gi,
      /(?:\/p\/|\/MLB[-_]?)(MLB[-_]?\d{6,})/gi,
      /\b(MLB[-_]?\d{6,})\b/gi
    ];
    for (const re of patterns) {
      let m;
      while ((m = re.exec(raw)) !== null) ids.add(normalizarId(m[1] || m[0]));
    }
    return [...ids].filter(Boolean);
  }

  async function findValidId(text) {
    for (const id of extrairCandidatosProfundos(text)) {
      const valid = await validarItem(id);
      if (valid) return valid.id;
    }
    return null;
  }

  // 1) Se o usuário já forneceu MLB..., não precisamos resolver encurtador.
  const direct = await findValidId(original);
  if (direct) return direct;

  if (!/^https?:\/\//i.test(original)) throw new Error('Digite uma URL válida do Mercado Livre.');

  let parsed;
  try { parsed = new URL(original); } catch { throw new Error('Digite uma URL válida do Mercado Livre.'); }
  const host = parsed.hostname.toLowerCase();
  const isShort = host === 'meli.la' || host === 'www.meli.la' || host.endsWith('.meli.la');

  const candidates = [];
  const visited = new Set();
  const queued = new Set();

  function addCandidate(v, baseUrl = original) {
    if (!v) return;
    let s = String(v).trim()
      .replace(/&amp;/gi, '&')
      .replace(/\\u0026/g, '&')
      .replace(/\\\//g, '/');
    try {
      if (!/^https?:\/\//i.test(s)) s = new URL(s, baseUrl).toString();
    } catch {}
    if (!/^https?:\/\//i.test(s)) return;
    if (!queued.has(s)) { queued.add(s); candidates.push(s); }
  }

  addCandidate(original);
  if (isShort && host !== 'www.meli.la') addCandidate(original.replace(/^https?:\/\/meli\.la/i, 'https://www.meli.la'));

  const commonHeaders = {
    'user-agent': 'Mozilla/5.0 (Linux; Android 13; SM-A515F) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36',
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'accept-language': 'pt-BR,pt;q=0.9,en-US;q=0.7,en;q=0.6',
    'cache-control': 'no-cache',
    'pragma': 'no-cache'
  };

  // 2) Resolve em múltiplos passos. Alguns meli.la caem em /social/ ou /sec/ antes do produto.
  for (let n = 0; n < 16; n++) {
    const current = candidates.find(x => !visited.has(x));
    if (!current) break;
    visited.add(current);

    for (const redirectMode of ['follow', 'manual']) {
      try {
        const r = await fetch(current, { redirect: redirectMode, headers: commonHeaders });
        const location = r.headers.get('location') || '';
        const html = await r.text();
        const id = await findValidId(`${r.url || current}\n${location}\n${html}`);
        if (id) return id;

        addCandidate(r.url, current);
        addCandidate(location, current);

        const patterns = [
          /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/gi,
          /<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/gi,
          /<meta[^>]+property=["']og:product:url["'][^>]+content=["']([^"']+)["']/gi,
          /<meta[^>]+name=["']twitter:url["'][^>]+content=["']([^"']+)["']/gi,
          /<meta[^>]+http-equiv=["']refresh["'][^>]+content=["'][^"']*url=([^"']+)["']/gi,
          /(?:window\.)?location(?:\.href|\.replace|\.assign)?\s*(?:=|\()\s*["']([^"']+)["']/gi,
          /(?:href|url|link|deeplink|redirect|destination|target)["']?\s*[:=]\s*["'](https?:\/\/[^"']+)["']/gi
        ];
        for (const re of patterns) {
          let m;
          while ((m = re.exec(html)) !== null) addCandidate(m[1], current);
        }

        // Extrai URLs completas e, principalmente, dados embutidos de item_id/product_id.
        const urls = html.match(/https?:\/\/[^\s<>"'\\]+/gi) || [];
        for (const u of urls.slice(0, 100)) addCandidate(u, current);
      } catch {}
    }
  }

  // 3) Navegador real (Chromium) para links meli.la que dependem de JavaScript/cookies.
  // Isso segue o redirecionamento como um navegador e então valida o MLB na API oficial.
  if (isShort) {
    let browser = null;
    try {
      browser = await puppeteer.launch({
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--no-first-run",
          "--no-zygote"
        ]
      });
      const page = await browser.newPage();
      await page.setUserAgent(commonHeaders["user-agent"]);
      await page.setExtraHTTPHeaders({
        "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.7,en;q=0.6"
      });
      await page.setViewport({ width: 390, height: 844, isMobile: true });
      await page.goto(original, { waitUntil: "domcontentloaded", timeout: 25000 });
      try { await page.waitForNetworkIdle({ idleTime: 800, timeout: 10000 }); } catch {}

      const finalUrl = page.url();
      const browserData = await page.evaluate(() => ({
        html: document.documentElement?.outerHTML || "",
        title: document.title || "",
        links: Array.from(document.querySelectorAll("a[href]"))
          .map(a => a.href)
          .filter(Boolean)
          .slice(0, 300),
        metas: Array.from(document.querySelectorAll("meta"))
          .map(m => ({
            name: m.getAttribute("name") || "",
            property: m.getAttribute("property") || "",
            content: m.getAttribute("content") || ""
          }))
          .slice(0, 300)
      }));

      const combined = [
        finalUrl,
        browserData.title,
        browserData.html,
        ...browserData.links,
        ...browserData.metas.map(x => `${x.name} ${x.property} ${x.content}`)
      ].join("\n");

      const id = await findValidId(combined);
      if (id) return id;

      // Alguns links exibem o produto em JSON-LD ou scripts depois do primeiro carregamento.
      const scripts = await page.evaluate(() =>
        Array.from(document.scripts).map(s => s.textContent || "").join("\n")
      );
      const id2 = await findValidId(`${finalUrl}\n${scripts}`);
      if (id2) return id2;
    } catch (browserError) {
      console.warn("[ML] navegador meli.la falhou:", browserError?.message || browserError);
    } finally {
      if (browser) {
        try { await browser.close(); } catch {}
      }
    }
  }

  // 3) Bridges de leitura para ambientes (como Render) onde meli.la pode bloquear fetch direto.
  if (isShort) {
    const bridges = [
      `https://r.jina.ai/${original}`,
      `https://r.jina.ai/http://${original.replace(/^https?:\/\//i, '')}`,
      `https://r.jina.ai/https://www.meli.la/${parsed.pathname.replace(/^\//, '')}`
    ];

    for (const bridge of bridges) {
      try {
        const r = await fetch(bridge, {
          redirect: 'follow',
          headers: { ...commonHeaders, 'user-agent': 'Mozilla/5.0 OfertaZap/17.0' }
        });
        const text = await r.text();
        const id = await findValidId(`${r.url || bridge}\n${text}`);
        if (id) return id;

        const urls = text.match(/https?:\/\/[^\s<>"'\\]+/gi) || [];
        for (const u of urls.slice(0, 100)) {
          addCandidate(u, bridge);
        }
      } catch {}
    }

    // Tenta novamente as URLs descobertas pelas bridges, mas ainda valida tudo na API oficial.
    for (let n = 0; n < 12; n++) {
      const current = candidates.find(x => !visited.has(x));
      if (!current) break;
      visited.add(current);
      try {
        const r = await fetch(current, { redirect: 'follow', headers: commonHeaders });
        const html = await r.text();
        const id = await findValidId(`${r.url || current}\n${r.headers.get('location') || ''}\n${html}`);
        if (id) return id;
      } catch {}
    }

    throw new Error('Não consegui resolver o link curto meli.la agora. Seu link de afiliado será preservado. Tente novamente em alguns segundos.');
  }

  throw new Error('Não consegui encontrar um anúncio válido do Mercado Livre nesse link.');
}
// ======================================================
// MERCADO LIVRE - BUSCAR PRODUTO
// ======================================================
async function getMercadoLivreProduct(value) {
  let accessToken = await getMercadoLivreAccessToken();

  const itemId = await resolveMercadoLivreItemId(value, accessToken);

  async function buscarItem(token) {
    return fetch(
      `https://api.mercadolibre.com/items/${encodeURIComponent(itemId)}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json"
        }
      }
    );
  }

  let response = await buscarItem(accessToken);

  if (response.status === 401) {
    const refreshed = await refreshMercadoLivreToken();
    accessToken = refreshed.access_token;
    response = await buscarItem(accessToken);
  }

  let data = {};
  try { data = await response.json(); } catch {}

  if (!response.ok) {
    throw new Error(
      data.message ||
      data.error_description ||
      data.error ||
      `Não foi possível consultar o anúncio ${itemId}.`
    );
  }

  const pictures = Array.isArray(data.pictures)
    ? data.pictures
        .map(p => p.secure_url || p.url)
        .filter(Boolean)
    : [];

  // Usa o endpoint oficial de preço vencedor. Ele retorna amount (venda) e
  // regular_amount (preço original quando há promoção).
  let salePrice = null;
  try {
    const pr = await fetch(
      `https://api.mercadolibre.com/items/${encodeURIComponent(itemId)}/sale_price?context=channel_marketplace`,
      { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } }
    );
    if (pr.status === 401) {
      const refreshed = await refreshMercadoLivreToken();
      accessToken = refreshed.access_token;
    } else if (pr.ok) {
      salePrice = await pr.json();
    }
  } catch {}

  const currentPrice = salePrice?.amount ?? data.price ?? null;
  const regularPrice = salePrice?.regular_amount ?? data.original_price ?? null;
  const discount = (regularPrice != null && currentPrice != null && Number(regularPrice) > Number(currentPrice))
    ? `${Math.round((1 - Number(currentPrice) / Number(regularPrice)) * 100)}% OFF`
    : "";

  return {
    id: data.id,
    title: data.title || "",
    price: currentPrice,
    oldPrice: regularPrice,
    discount,
    currency: salePrice?.currency_id || data.currency_id || "BRL",
    image: pictures[0] || null,
    pictures,
    permalink: data.permalink || null,
    source: "Mercado Livre API oficial"
  };
}

// ======================================================
// PREÇO/DESCONTO POR LINK — SEM DEPENDER DA IMAGEM
// ======================================================
function brlNumber(value) {
  if (value == null) return null;
  const s = String(value).replace(/\s/g, '').replace(/R\$/i, '').replace(/\./g, '').replace(',', '.');
  const n = Number(s.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}
function formatMoneyBR(n) {
  if (n == null || !Number.isFinite(Number(n))) return '';
  return Number(n).toLocaleString('pt-BR', { style:'currency', currency:'BRL' });
}
function calcDiscount(oldPrice, price) {
  if (oldPrice == null || price == null || oldPrice <= 0 || price >= oldPrice) return '';
  return `${Math.round((1 - price / oldPrice) * 100)}% OFF`;
}
function extractPriceData(text) {
  const source = String(text || '');
  let current = null, old = null, discount = '';

  // 1) Campos estruturados/JSON.
  const jsonPrice = source.match(/"(?:price|sale_price|amount)"\s*:\s*"?([0-9]+(?:[.,][0-9]{1,2})?)/i);
  const jsonOld = source.match(/"(?:highPrice|original_price|regular_amount|compare_at_price)"\s*:\s*"?([0-9]+(?:[.,][0-9]{1,2})?)/i);
  if (jsonPrice) current = brlNumber(jsonPrice[1]);
  if (jsonOld) old = brlNumber(jsonOld[1]);

  // 2) Captura todos os valores em reais encontrados no HTML/texto.
  const moneyMatches = source.match(/R\$\s*[0-9]{1,3}(?:\.[0-9]{3})*(?:,[0-9]{2})|R\$\s*[0-9]+(?:,[0-9]{2})?/gi) || [];
  const nums = [...new Set(moneyMatches.map(brlNumber).filter(v => v != null))];

  // 3) Descobre o percentual explícito, se existir.
  const dm = source.match(/(\d{1,3})\s*%\s*(?:OFF|desconto|de desconto)/i);
  const discountPct = dm ? Number(dm[1]) : null;
  if (dm) discount = `${dm[1]}% OFF`;

  // 4) Tenta encontrar um par de preços que corresponda ao desconto.
  // Isso resolve páginas onde o HTML mostra simplesmente: R$ 99,90 / R$ 149,90 / 33% OFF.
  if (nums.length >= 2 && (current == null || old == null)) {
    let best = null;
    for (let i = 0; i < nums.length; i++) {
      for (let j = i + 1; j < nums.length; j++) {
        const a = nums[i], b = nums[j];
        const lo = Math.min(a, b), hi = Math.max(a, b);
        if (hi <= lo || hi <= 0) continue;
        const pct = Math.round((1 - lo / hi) * 100);
        if (discountPct != null && pct === discountPct) {
          best = { price: lo, oldPrice: hi };
          break;
        }
      }
      if (best) break;
    }
    if (best) {
      if (current == null) current = best.price;
      if (old == null) old = best.oldPrice;
    }
  }

  // 5) Se ainda não houver preço atual, usa o menor valor encontrado.
  // O preço promocional normalmente é menor que o preço antigo.
  if (current == null && nums.length) current = Math.min(...nums);
  if (old == null && current != null) {
    const larger = nums.filter(n => n > current);
    if (larger.length) old = Math.max(...larger);
  }

  // 6) Padrões textuais ajudam quando há rótulos "de/por".
  if (old == null) {
    const oldPatterns = [
      /(?:de|antes|era|pre[cç]o\s*normal|pre[cç]o\s*original)[^R$]{0,100}R\$\s*([0-9.]+(?:,[0-9]{2})?)/i,
      /R\$\s*([0-9.]+(?:,[0-9]{2})?)[^\n]{0,80}(?:de desconto|off|economize)/i
    ];
    for (const re of oldPatterns) {
      const m = source.match(re);
      if (m) { old = brlNumber(m[1]); break; }
    }
  }

  if (!discount) discount = calcDiscount(old, current);
  return { price: current, oldPrice: old, discount };
}
async function scrapePriceOnly(original) {
  const parsed = new URL(original);
  const candidates = [original];
  if (parsed.hostname === 'meli.la' || parsed.hostname === 'www.meli.la') {
    candidates.push(`https://www.meli.la${parsed.pathname}${parsed.search}`);
  }
  const bridges = [
    `https://r.jina.ai/${original}`,
    `https://r.jina.ai/http://${original.replace(/^https?:\/\//i,'')}`,
    `https://r.jina.ai/https://www.meli.la${parsed.pathname}${parsed.search}`
  ];
  for (const url of [...candidates, ...bridges]) {
    try {
      const r = await fetch(url, { redirect:'follow', headers:{'user-agent':'Mozilla/5.0 OfertaZap/20.0','accept':'text/html,application/json,text/plain,*/*'} });
      const text = await r.text();
      const data = extractPriceData(`${r.url || url}\n${text}`);
      if (data.price != null || data.oldPrice != null || data.discount) return { ...data, source:url, resolvedUrl:r.url || url };
    } catch {}
  }
  return { price:null, oldPrice:null, discount:'' };
}
async function getPriceOnly(value) {
  const original = String(value || '').trim();
  if (!original) throw new Error('Informe o link da oferta.');

  let apiData = null;

  // 1) Se conseguirmos descobrir o MLB, consulta a API oficial de preços.
  try {
    const token = await getMercadoLivreAccessToken();
    const itemId = await resolveMercadoLivreItemId(original, token);
    let r = await fetch(`https://api.mercadolibre.com/items/${encodeURIComponent(itemId)}/prices`, {
      headers:{ Authorization:`Bearer ${token}`, Accept:'application/json' }
    });
    if (r.status === 401) {
      const fresh = await refreshMercadoLivreToken();
      r = await fetch(`https://api.mercadolibre.com/items/${encodeURIComponent(itemId)}/prices`, {
        headers:{ Authorization:`Bearer ${fresh.access_token}`, Accept:'application/json' }
      });
    }
    if (r.ok) {
      const d = await r.json();
      const active = (Array.isArray(d.prices) ? d.prices : []).filter(x => x && x.amount != null);
      const promo = active.find(x => x.type === 'promotion') || null;
      const standard = active.find(x => x.type === 'standard') || null;
      const price = promo?.amount ?? standard?.amount ?? null;
      const oldPrice = promo?.regular_amount ?? standard?.regular_amount ?? null;
      apiData = { price, oldPrice, discount: calcDiscount(oldPrice, price), itemId, source:'mercadolivre-api', link:original };

      // Se já temos preço atual + preço antigo, não precisamos raspar a página.
      if (price != null && oldPrice != null) return apiData;
    }
  } catch {}

  // 2) Fallback: lê os valores da página/bridge sem exigir que o MLB seja resolvido.
  const scraped = await scrapePriceOnly(original);
  if (scraped.price != null || scraped.oldPrice != null || scraped.discount) {
    const merged = {
      price: apiData?.price ?? scraped.price,
      oldPrice: apiData?.oldPrice ?? scraped.oldPrice,
      discount: apiData?.discount || scraped.discount,
      itemId: apiData?.itemId,
      source: apiData ? 'mercadolivre-api+page' : 'page',
      resolvedUrl: scraped.resolvedUrl,
      link: original
    };
    if (!merged.discount) merged.discount = calcDiscount(merged.oldPrice, merged.price);
    return merged;
  }

  if (apiData && (apiData.price != null || apiData.oldPrice != null || apiData.discount)) {
    return apiData;
  }

  throw new Error('Não consegui encontrar preço/desconto nesse link. Você pode informar o preço manualmente e manter o link de afiliado.');
}

// OAuth callback é público porque o Mercado Livre redireciona o navegador para esta rota.
app.get("/api/mercadolivre/callback", async (req, res) => {
  try {
    const { code, state, error, error_description } = req.query;
    if (error) return res.status(400).send(`Autorização cancelada: ${error_description || error}`);
    if (!code) return res.status(400).send("Código de autorização não recebido.");
    if (!mlOAuthState || state !== mlOAuthState) return res.status(400).send("Estado OAuth inválido ou expirado.");
    await exchangeMercadoLivreCode(code);
    mlOAuthState = null;
    res.send("<h2>OfertaZap conectado ao Mercado Livre ✅</h2><p>Você pode fechar esta página e voltar ao painel.</p>");
  } catch (err) {
    res.status(400).send(`<h2>Erro ao conectar Mercado Livre</h2><p>${String(err.message).replace(/[<>]/g, "")}</p>`);
  }
});

function authMiddleware(req, res, next) {
  if (!API_TOKEN) return res.status(503).json({ error: "API_TOKEN não configurado no servidor" });

  const auth = req.headers.authorization || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const token = bearer || req.headers["x-api-token"] || "";

  if (token !== API_TOKEN) return res.status(401).json({ error: "Token inválido" });
  next();
}

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "OfertaZap API",
    status: connectionState,
    health: "/api/health"
  });
});

// Health é público e fica ANTES da proteção por token.
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "OfertaZap API", version: "V17-MELILA-RESOLVER", time: new Date().toISOString() });
});

// ======================================================
// MERCADO LIVRE - INICIAR OAUTH
// PÚBLICO: o navegador precisa conseguir iniciar o OAuth
// sem enviar o API_TOKEN.
// ======================================================
app.get("/api/mercadolivre/auth", (req, res) => {
  try {
    const authorizationUrl = buildMercadoLivreAuthUrl();

    if (String(req.query.redirect || "") === "1") {
      return res.redirect(authorizationUrl);
    }

    return res.json({
      ok: true,
      authorizationUrl
    });
  } catch (err) {
    return res.status(503).json({
      ok: false,
      error: err.message
    });
  }
});


// Todas as outras rotas /api exigem API_TOKEN.
app.use("/api", authMiddleware);

app.get("/api/mercadolivre/status", (_req, res) => {
  const missing = [];
  if (!ML_CLIENT_ID) missing.push("ML_CLIENT_ID");
  if (!ML_CLIENT_SECRET) missing.push("ML_CLIENT_SECRET");
  if (!ML_REDIRECT_URI) missing.push("ML_REDIRECT_URI");

  res.json({
    ok: true,
    configured: missing.length === 0,
    missing,
    connected: Boolean(mlTokens.access_token && mlTokens.refresh_token),
    userId: mlTokens.user_id || null,
    expiresAt: mlTokens.savedAt ? new Date(new Date(mlTokens.savedAt).getTime() + Number(mlTokens.expires_in || 21600) * 1000).toISOString() : null
  });
});

app.post("/api/products/price-preview", async (req, res) => {
  try {
    const value = String(req.body?.link || req.body?.url || "").trim();
    if (!value) return res.status(400).json({ ok:false, error:"Informe o link da oferta" });
    const price = await getPriceOnly(value);
    res.json({ ok:true, price });
  } catch (err) {
    res.status(400).json({ ok:false, error:err.message });
  }
});

app.post("/api/products/preview", async (req, res) => {
  try {
    const { link, url } = req.body || {};
    const productLink = link || url;
    if (!productLink) return res.status(400).json({ error: "Informe o link do Mercado Livre" });
    const product = await getMercadoLivreProduct(productLink);
    res.json({ ok: true, product });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/mercadolivre/preco-link", async (req, res) => {
  try {
    const value = String(req.body?.link || req.body?.url || "").trim();
    if (!value) return res.status(400).json({ ok: false, error: "Informe o link do Mercado Livre" });
    const product = await getMercadoLivreProduct(value);
    res.json({
      ok: true,
      link: value,
      itemId: product.id,
      price: product.price,
      oldPrice: product.oldPrice,
      discount: product.discount,
      currency: product.currency
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post("/api/mercadolivre/resolve", async (req, res) => {
  try {
    const value = String(req.body?.link || req.body?.url || "").trim();
    if (!value) return res.status(400).json({ ok: false, error: "Informe o link do Mercado Livre" });
    const accessToken = await getMercadoLivreAccessToken();
    const itemId = await resolveMercadoLivreItemId(value, accessToken);
    res.json({ ok: true, itemId, originalLink: value });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.get("/api/status", (_req, res) => {
  res.json({
    ok: true,
    whatsapp: connectionState,
    connected: connectionState === "connected",
    ready: connectionState === "connected" && Boolean(sock),
    qrAvailable: Boolean(qrDataUrl),
    groups: groups.length,
    jobs: jobs.length,
    products: products.length,
    lastError
  });
});

app.get("/api/whatsapp/qr", (_req, res) => {
  if (!qrDataUrl) return res.status(404).json({ error: "QR Code ainda não disponível" });
  res.json({ ok: true, qr: qrDataUrl });
});

async function startWhatsApp() {
  if (connectionState === "connecting" || connectionState === "connected") return;

  connectionState = "connecting";
  lastError = null;

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    logger: pino({ level: "silent" }),
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" }))
    },
    printQRInTerminal: false,
    browser: ["OfertaZap", "Chrome", "1.0.0"]
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      qrDataUrl = await QRCode.toDataURL(qr);
    }

    if (connection === "open") {
      connectionState = "connected";
      qrDataUrl = null;
      lastError = null;
      console.log("WhatsApp conectado.");
    }

    if (connection === "close") {
      connectionState = "disconnected";
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      lastError = String(code || lastDisconnect?.error?.message || "Conexão encerrada");

      if (code !== DisconnectReason.loggedOut) {
        setTimeout(() => startWhatsApp().catch(err => {
          lastError = err.message;
          connectionState = "disconnected";
        }), 5000);
      }
    }
  });
}

app.post("/api/whatsapp/start", async (_req, res) => {
  try {
    await startWhatsApp();
    res.json({ ok: true, status: connectionState, qrAvailable: Boolean(qrDataUrl) });
  } catch (err) {
    lastError = err.message;
    connectionState = "disconnected";
    res.status(500).json({ error: err.message });
  }
});

function extractInviteCode(value) {
  const match = String(value || "").match(/chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/i);
  return match?.[1] || null;
}

app.get("/api/groups", (_req, res) => {
  res.json({ ok: true, groups });
});

app.post("/api/groups", async (req, res) => {
  const { name, inviteLink, jid } = req.body || {};
  if (!name && !inviteLink && !jid) {
    return res.status(400).json({ error: "Informe name, inviteLink ou jid" });
  }

  let groupJid = jid || null;
  let groupName = name || "Grupo WhatsApp";

  try {
    if (!sock) return res.status(409).json({ error: "WhatsApp não está conectado" });

    if (!groupJid && inviteLink) {
      const code = extractInviteCode(inviteLink);
      if (!code) return res.status(400).json({ error: "Link de convite inválido" });

      const info = await sock.groupGetInviteInfo(code);
      groupJid = info.id;
      groupName = name || info.subject || groupName;

      try {
        await sock.groupAcceptInvite(code);
      } catch {}
    }

    const item = {
      id: randomUUID(),
      name: groupName,
      jid: groupJid,
      inviteLink: inviteLink || null,
      createdAt: new Date().toISOString()
    };

    groups.push(item);
    saveJson(GROUPS_FILE, groups);
    res.json({ ok: true, group: item });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/groups/:id", (req, res) => {
  const before = groups.length;
  groups = groups.filter(g => g.id !== req.params.id);
  saveJson(GROUPS_FILE, groups);
  res.json({ ok: true, removed: before !== groups.length });
});

app.post("/api/groups/:id/join", async (req, res) => {
  try {
    const group = groups.find(g => g.id === req.params.id);
    if (!group) return res.status(404).json({ error: "Grupo não encontrado" });
    if (!sock || connectionState !== "connected") return res.status(409).json({ error: "WhatsApp não está conectado" });
    if (!group.inviteLink) return res.status(400).json({ error: "Este grupo não possui link de convite" });
    const code = extractInviteCode(group.inviteLink);
    if (!code) return res.status(400).json({ error: "Link de convite inválido" });
    const jid = await sock.groupAcceptInvite(code);
    if (jid) group.jid = jid;
    saveJson(GROUPS_FILE, groups);
    res.json({ ok: true, message: "Grupo conectado.", group });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/products/manual", (_req, res) => {
  res.json({ ok: true, products });
});

app.post("/api/products/manual", (req, res) => {
  const body = req.body || {};
  const { id = randomUUID(), name, price, oldPrice = "", discount = "", category = "", link, message = "", imageData = "", imageUrl = "" } = body;
  if (!name || !price || !link) {
    return res.status(400).json({ error: "name, price e link são obrigatórios" });
  }
  if (!imageData && !imageUrl) {
    return res.status(400).json({ error: "Adicione imageData ou imageUrl para o produto." });
  }
  if (imageData && String(imageData).length > 4500000) {
    return res.status(413).json({ error: "Imagem muito grande. Reduza a imagem antes de salvar." });
  }
  const product = { id: String(id), name: String(name), price: String(price), oldPrice: String(oldPrice || ""), discount: String(discount || ""), category: String(category || ""), link: String(link), message: String(message || ""), imageData: String(imageData || ""), imageUrl: String(imageUrl || ""), createdAt: products.find(p => String(p.id) === String(id))?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
  const index = products.findIndex(p => String(p.id) === String(id));
  if (index >= 0) products[index] = product; else products.unshift(product);
  saveJson(PRODUCTS_FILE, products);
  res.json({ ok: true, product });
});

app.delete("/api/products/manual/:id", (req, res) => {
  const before = products.length;
  products = products.filter(p => String(p.id) !== String(req.params.id));
  saveJson(PRODUCTS_FILE, products);
  res.json({ ok: true, removed: before !== products.length });
});

app.get("/api/jobs", (_req, res) => {
  res.json({ ok: true, jobs });
});

app.post("/api/jobs", (req, res) => {
  const { groupId, message, scheduledAt, repeat = "unica", imageUrl = null, imageData = null, product = null } = req.body || {};
  if (!groupId || !message || !scheduledAt) {
    return res.status(400).json({ error: "groupId, message e scheduledAt são obrigatórios" });
  }

  if (!["unica", "diaria", "semanal"].includes(repeat)) {
    return res.status(400).json({ error: "Repetição inválida. Use unica, diaria ou semanal." });
  }

  const group = groups.find(g => g.id === groupId);
  if (!group) return res.status(404).json({ error: "Grupo não encontrado" });

  const job = {
    id: randomUUID(),
    groupId,
    message,
    scheduledAt,
    repeat,
    imageUrl,
    imageData,
    product,
    status: "pending",
    createdAt: new Date().toISOString()
  };

  jobs.push(job);
  saveJson(JOBS_FILE, jobs);
  res.json({ ok: true, job });
});

async function sendJob(job) {
  const group = groups.find(g => g.id === job.groupId);
  if (!group?.jid) throw new Error("Grupo sem JID");
  if (!sock || connectionState !== "connected") throw new Error("WhatsApp não conectado");

  if (job.imageData && String(job.imageData).startsWith("data:image/")) {
    const base64 = String(job.imageData).split(",", 2)[1] || "";
    await sock.sendMessage(group.jid, { image: Buffer.from(base64, "base64"), caption: job.message });
  } else if (job.imageUrl) {
    await sock.sendMessage(group.jid, { image: { url: job.imageUrl }, caption: job.message });
  } else {
    await sock.sendMessage(group.jid, { text: job.message });
  }

  job.sentAt = new Date().toISOString();

  if (job.repeat === "diaria" || job.repeat === "semanal") {
    const current = new Date(job.scheduledAt);
    const days = job.repeat === "diaria" ? 1 : 7;
    current.setDate(current.getDate() + days);
    job.scheduledAt = current.toISOString();
    job.status = "pending";
    job.lastStatus = "sent";
  } else {
    job.status = "sent";
  }
}

app.post("/api/jobs/:id/send", async (req, res) => {
  const job = jobs.find(j => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: "Agendamento não encontrado" });

  try {
    await sendJob(job);
    saveJson(JOBS_FILE, jobs);
    res.json({ ok: true, job });
  } catch (err) {
    job.status = "error";
    job.error = err.message;
    saveJson(JOBS_FILE, jobs);
    res.status(400).json({ error: err.message, job });
  }
});

app.delete("/api/jobs/:id", (req, res) => {
  const before = jobs.length;
  jobs = jobs.filter(j => j.id !== req.params.id);
  saveJson(JOBS_FILE, jobs);
  res.json({ ok: true, removed: before !== jobs.length });
});

async function processJobs() {
  if (!sock || connectionState !== "connected") return;
  const now = Date.now();

  for (const job of jobs) {
    if (job.status !== "pending") continue;
    const when = new Date(job.scheduledAt).getTime();
    if (!Number.isFinite(when) || when > now) continue;

    try {
      await sendJob(job);
    } catch (err) {
      job.status = "error";
      job.error = err.message;
    }
  }

  saveJson(JOBS_FILE, jobs);
}

cron.schedule("* * * * *", () => {
  processJobs().catch(err => console.error("Scheduler:", err.message));
}, { timezone: TZ });

app.listen(PORT, "0.0.0.0", () => {
  console.log(`OfertaZap API rodando na porta ${PORT}`);
  console.log(`Timezone: ${TZ}`);
});
