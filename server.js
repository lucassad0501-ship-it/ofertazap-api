import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import QRCode from 'qrcode';
import pino from 'pino';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Boom } from '@hapi/boom';
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore
} from '@whiskeysockets/baileys';
import puppeteer from 'puppeteer';
import nodemailer from 'nodemailer';

const app = express();

const PORT = Number(process.env.PORT || 3000);
const TZ = process.env.TZ || 'America/Sao_Paulo';

const API_TOKEN = process.env.API_TOKEN || '';

const MASTER_LOGIN = (
  process.env.MASTER_LOGIN ||
  process.env.MASTER_EMAIL ||
  ''
).trim().toLowerCase();

const MASTER_PASSWORD = process.env.MASTER_PASSWORD || '';

const JWT_SECRET =
  process.env.JWT_SECRET ||
  API_TOKEN ||
  'change-this-secret';

const ROOT = path.resolve(
  process.env.DATA_DIR ||
    (fs.existsSync('/data') ? '/data/ofertazap' : './data')
);

const AUTH_ROOT = path.resolve(
  process.env.BAILEYS_AUTH_ROOT ||
    path.join(ROOT, 'clientes')
);

fs.mkdirSync(ROOT, { recursive: true });
fs.mkdirSync(AUTH_ROOT, { recursive: true });

app.use(
  cors({
    origin: process.env.FRONTEND_ORIGIN || '*'
  })
);

app.use(
  express.json({
    limit: '6mb'
  })
);

/* =========================================================
   ARQUIVOS
========================================================= */

const files = {
  db: path.join(ROOT, 'saas.json'),
  products: path.join(ROOT, 'products.json'),
  jobs: path.join(ROOT, 'jobs.json'),
  groups: path.join(ROOT, 'groups.json'),
  templates: path.join(ROOT, 'templates.json'),
  logs: path.join(ROOT, 'logs.json')
};

/* =========================================================
   E-MAIL
========================================================= */

const mailer =
  process.env.SMTP_HOST &&
  process.env.SMTP_USER &&
  process.env.SMTP_PASS
    ? nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        secure:
          String(process.env.SMTP_SECURE || 'false') === 'true',
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS
        }
      })
    : null;

async function sendCodeEmail(to, code, type) {
  if (!mailer) {
    console.log(
      `[EMAIL TEST] ${type} para ${to}: ${code}`
    );
    return false;
  }

  await mailer.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject:
      type === 'verification'
        ? 'OfertaZap — confirme seu e-mail'
        : 'OfertaZap — recuperação de senha',
    text:
      `Seu código OfertaZap é: ${code}. ` +
      `Ele expira em 15 minutos.`
  });

  return true;
}

/* =========================================================
   UTILIDADES
========================================================= */

function load(file, defaultValue) {
  try {
    return fs.existsSync(file)
      ? JSON.parse(fs.readFileSync(file, 'utf8'))
      : defaultValue;
  } catch {
    return defaultValue;
  }
}

function save(file, data) {
  const tmp = file + '.tmp';

  fs.writeFileSync(
    tmp,
    JSON.stringify(data, null, 2)
  );

  fs.renameSync(tmp, file);
}

/* =========================================================
   BANCO LOCAL JSON
========================================================= */

const defaultDb = {
  users: [],

  plans: [
    {
      id: 'p1',
      name: 'Plano 1',
      limit: 200,
      price: 29.9
    },
    {
      id: 'p2',
      name: 'Plano 2',
      limit: 300,
      price: 49.9
    },
    {
      id: 'p3',
      name: 'Plano 3',
      limit: 700,
      price: 79.9
    }
  ],

  subscriptions: [],

  settings: {
    brand: 'OfertaZap'
  }
};

const defaultTemplates = [
  {
    id: 't1',
    name: '🔥 Oferta imperdível',
    text:
      '🔥 OFERTA IMPERDÍVEL!\n\n' +
      '📦 {produto}\n' +
      '💰 De {preco_antigo} por {preco}\n' +
      '🏷️ {desconto} OFF\n\n' +
      '👉 Comprar agora:\n' +
      '{link}'
  },

  {
    id: 't2',
    name: '🚨 Corre que pode acabar',
    text:
      '🚨 CORRE QUE PODE ACABAR!\n\n' +
      '🛍️ {produto}\n' +
      '💰 {preco}\n\n' +
      '🔥 Aproveite enquanto está disponível!\n\n' +
      '👇 {link}'
  },

  {
    id: 't3',
    name: '💥 Promoção do dia',
    text:
      '💥 PROMOÇÃO DO DIA!\n\n' +
      '{produto}\n' +
      '🔥 {preco}\n' +
      '🏷️ {desconto} OFF\n\n' +
      '👉 Confira:\n' +
      '{link}'
  }
];

let db = load(files.db, defaultDb);
let products = load(files.products, []);
let jobs = load(files.jobs, []);
let groups = load(files.groups, []);
let templates = load(files.templates, defaultTemplates);
let logs = load(files.logs, []);

/* =========================================================
   AUTENTICAÇÃO
========================================================= */

const wa = new Map();

function hash(password, salt) {
  return crypto
    .scryptSync(String(password), salt, 64)
    .toString('hex');
}

function verify(password, user) {
  return crypto.timingSafeEqual(
    Buffer.from(hash(password, user.salt), 'hex'),
    Buffer.from(user.passwordHash, 'hex')
  );
}

function b64(value) {
  return Buffer.from(
    JSON.stringify(value)
  ).toString('base64url');
}

function token(user) {
  const header = b64({
    alg: 'HS256',
    typ: 'JWT'
  });

  const payload = b64({
    sub: user.id,
    role: user.role,
    iat: Date.now()
  });

  const signature = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(header + '.' + payload)
    .digest('base64url');

  return (
    header +
    '.' +
    payload +
    '.' +
    signature
  );
}

function auth(req, res, next) {
  try {
    const raw =
      req.headers.authorization || '';

    const value = raw.replace(
      /^Bearer\s+/,
      ''
    );

    if (!value) {
      throw new Error('Token ausente');
    }

    const [header, payload, signature] =
      value.split('.');

    const expected = crypto
      .createHmac('sha256', JWT_SECRET)
      .update(header + '.' + payload)
      .digest('base64url');

    const ok = crypto.timingSafeEqual(
      Buffer.from(signature || ''),
      Buffer.from(expected)
    );

    if (!ok) {
      throw new Error('Token inválido');
    }

    const data = JSON.parse(
      Buffer.from(
        payload,
        'base64url'
      ).toString()
    );

    const user = db.users.find(
      x =>
        x.id === data.sub &&
        x.active !== false
    );

    if (!user) {
      throw new Error(
        'Usuário inválido'
      );
    }

    req.user = user;

    next();
  } catch {
    res.status(401).json({
      error: 'Não autorizado'
    });
  }
}

function master(req, res, next) {
  if (req.user.role !== 'MASTER') {
    return res.status(403).json({
      error:
        'Somente administrador Master'
    });
  }

  next();
}

function client(req, res, next) {
  if (
    !['CLIENT', 'MASTER'].includes(
      req.user.role
    )
  ) {
    return res.status(403).json({
      error: 'Acesso negado'
    });
  }

  next();
}

/* =========================================================
   MASTER
========================================================= */

function ensureMaster() {
  if (!MASTER_LOGIN || !MASTER_PASSWORD) {
    throw new Error(
      'MASTER_LOGIN e MASTER_PASSWORD precisam estar configurados nas variáveis do Render.'
    );
  }

  let user = db.users.find(
    x => x.role === 'MASTER'
  );

  if (!user) {
    const salt = crypto
      .randomBytes(16)
      .toString('hex');

    db.users.push({
      id: 'master',
      role: 'MASTER',
      name: 'Administrador Master',
      email: MASTER_LOGIN,
      passwordHash: hash(
        MASTER_PASSWORD,
        salt
      ),
      salt,
      active: true,
      createdAt:
        new Date().toISOString()
    });

    save(files.db, db);
    return;
  }

  if (
    user.email !== MASTER_LOGIN
  ) {
    user.email = MASTER_LOGIN;

    const salt = crypto
      .randomBytes(16)
      .toString('hex');

    user.passwordHash = hash(
      MASTER_PASSWORD,
      salt
    );

    user.salt = salt;
    user.active = true;

    save(files.db, db);
  }
}

/* =========================================================
   ASSINATURAS
========================================================= */

function subOf(userId) {
  return db.subscriptions.find(
    s => s.userId === userId
  );
}

function activeSub(userId) {
  const subscription =
    subOf(userId);

  if (!subscription) {
    return null;
  }

  if (
    subscription.status !==
    'active'
  ) {
    return null;
  }

  if (
    new Date(
      subscription.expiresAt
    ) <= new Date()
  ) {
    return null;
  }

  return subscription;
}

/* =========================================================
   QUOTA
========================================================= */

function jobProductIds(job) {
  if (
    Array.isArray(job?.productIds)
  ) {
    return job.productIds.filter(
      Boolean
    );
  }

  if (job?.productId) {
    return [job.productId];
  }

  return [];
}

function quota(userId) {
  const subscription =
    activeSub(userId);

  if (!subscription) {
    return {
      limit: 0,
      used: 0,
      remaining: 0
    };
  }

  const plan =
    db.plans.find(
      p =>
        p.id ===
        subscription.planId
    ) || db.plans[0];

  const used =
    new Set();

  for (
    const job of jobs.filter(
      j =>
        j.userId === userId &&
        j.enabled !== false
    )
  ) {
    for (
      const id of jobProductIds(
        job
      )
    ) {
      used.add(id);
    }
  }

  const limit =
    Number(plan.limit) || 0;

  return {
    limit,
    used: used.size,
    remaining: Math.max(
      0,
      limit - used.size
    )
  };
}

function assertQuota(
  userId,
  productIds
) {
  const q = quota(userId);

  const current =
    new Set();

  for (
    const job of jobs.filter(
      j =>
        j.userId === userId &&
        j.enabled !== false
    )
  ) {
    for (
      const id of jobProductIds(
        job
      )
    ) {
      current.add(id);
    }
  }

  for (
    const id of productIds || []
  ) {
    if (id) {
      current.add(id);
    }
  }

  if (
    current.size > q.limit
  ) {
    throw new Error(
      `Limite do plano atingido: ${q.limit} produtos na agenda.`
    );
  }
}

/* =========================================================
   LOG
========================================================= */

function log(
  action,
  userId,
  meta = {}
) {
  logs.unshift({
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    action,
    userId,
    meta
  });

  logs = logs.slice(0, 2000);

  save(files.logs, logs);
}

/* =========================================================
   MERCADO LIVRE
========================================================= */

function money(value) {
  if (
    value === null ||
    value === undefined ||
    value === ''
  ) {
    return '';
  }

  return Number(value).toLocaleString(
    'pt-BR',
    {
      style: 'currency',
      currency: 'BRL'
    }
  );
}

function discount(oldPrice, price) {
  if (
    oldPrice &&
    price &&
    oldPrice > price
  ) {
    return (
      Math.round(
        (1 - price / oldPrice) *
          100
      ) + '%'
    );
  }

  return '';
}

function itemIds(value) {
  return [
    ...new Set(
      (
        String(value || '')
          .match(
            /\bMLB[-_]?\d{6,}\b/gi
          ) || []
      ).map(id =>
        id
          .replace(/[-_]/g, '')
          .toUpperCase()
      )
    )
  ];
}

async function mlItem(id) {
  const response =
    await fetch(
      'https://api.mercadolibre.com/items/' +
        encodeURIComponent(id)
    );

  if (!response.ok) {
    throw new Error(
      'Produto Mercado Livre não encontrado'
    );
  }

  return response.json();
}

async function resolveML(link) {
  const direct =
    itemIds(link);

  for (
    const id of direct
  ) {
    try {
      return await mlItem(id);
    } catch {}
  }

  const candidates = [link];
  const seen = new Set();

  const add = value => {
    try {
      if (
        value &&
        !seen.has(value)
      ) {
        seen.add(value);

        candidates.push(
          new URL(
            value,
            link
          ).toString()
        );
      }
    } catch {}
  };

  for (
    let n = 0;
    n < 10 &&
    n < candidates.length;
    n++
  ) {
    const url =
      candidates[n];

    try {
      const response =
        await fetch(url, {
          redirect: 'manual',
          headers: {
            'user-agent':
              'Mozilla/5.0',
            'accept-language':
              'pt-BR,pt;q=0.9'
          }
        });

      const text =
        await response.text();

      const ids = itemIds(
        (response.headers.get(
          'location'
        ) || '') +
          '\n' +
          text
      );

      for (
        const id of ids
      ) {
        try {
          return await mlItem(id);
        } catch {}
      }

      add(
        response.headers.get(
          'location'
        )
      );

      for (
        const match of text.matchAll(
          /(?:canonical|og:url|twitter:url)[^>]+(?:content|href)=["']([^"']+)/gi
        )
      ) {
        add(match[1]);
      }
    } catch {}
  }

  if (
    /^https?:\/\/(www\.)?meli\.la/i.test(
      link
    )
  ) {
    let browser;

    try {
      browser =
        await puppeteer.launch({
          headless: true,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage'
          ]
        });

      const page =
        await browser.newPage();

      await page.setViewport({
        width: 390,
        height: 844,
        isMobile: true
      });

      await page.goto(
        link,
        {
          waitUntil:
            'domcontentloaded',
          timeout: 25000
        }
      );

      try {
        await page.waitForNetworkIdle({
          idleTime: 800,
          timeout: 8000
        });
      } catch {}

      const data =
        await page.evaluate(
          () => ({
            url: location.href,
            html:
              document.documentElement
                .outerHTML
          })
        );

      for (
        const id of itemIds(
          data.url +
            '\n' +
            data.html
        )
      ) {
        try {
          return await mlItem(id);
        } catch {}
      }
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  }

  throw new Error(
    'Não consegui identificar o anúncio Mercado Livre neste link.'
  );
}

/* =========================================================
   WHATSAPP
========================================================= */

function cleanPhone(phone) {
  return String(phone || '')
    .replace(/\D/g, '');
}

async function startWA(
  userId,
  options = {}
) {
  const existing =
    wa.get(userId);

  if (
    existing &&
    existing.state ===
      'connected'
  ) {
    return existing;
  }

  if (
    existing &&
    existing.state ===
      'connecting'
  ) {
    return existing;
  }

  const authDir =
    path.join(
      AUTH_ROOT,
      String(userId)
    );

  fs.mkdirSync(
    authDir,
    {
      recursive: true
    }
  );

  const {
    state,
    saveCreds
  } =
    await useMultiFileAuthState(
      authDir
    );

  let version;

  try {
    const result =
      await fetchLatestBaileysVersion();

    version = result.version;
  } catch {}

  const socket =
    makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(
          state.keys,
          pino({
            level: 'silent'
          })
        )
      },

      version,

      printQRInTerminal: false,

      logger: pino({
        level: 'silent'
      }),

      browser: [
        'OfertaZap',
        'Chrome',
        '1.0.0'
      ],

      generateHighQualityLinkPreview:
        false
    });

  const session = {
    sock: socket,
    state: 'connecting',
    qr: null,
    pairingCode: null,
    lastError: null
  };

  wa.set(
    userId,
    session
  );

  socket.ev.on(
    'creds.update',
    saveCreds
  );

  socket.ev.on(
    'connection.update',
    async update => {
      const {
        connection,
        lastDisconnect,
        qr
      } = update;

      if (qr) {
        try {
          session.qr =
            await QRCode.toDataURL(
              qr
            );
        } catch {
          session.qr = qr;
        }
      }

      if (
        connection ===
        'open'
      ) {
        session.state =
          'connected';

        session.qr = null;
        session.pairingCode =
          null;
        session.lastError = null;

        console.log(
          `WhatsApp conectado: ${userId}`
        );

        try {
          await syncGroups(
            userId
          );
        } catch (error) {
          console.error(
            'Erro ao sincronizar grupos:',
            error.message
          );
        }
      }

      if (
        connection ===
        'close'
      ) {
        session.state =
          'disconnected';

        const statusCode =
          new Boom(
            lastDisconnect?.error
          )?.output
            ?.statusCode;

        const shouldReconnect =
          statusCode !==
          DisconnectReason.loggedOut;

        session.lastError =
          lastDisconnect?.error
            ?.message ||
          'WhatsApp desconectado';

        wa.delete(userId);

        if (
          shouldReconnect
        ) {
          setTimeout(
            () =>
              startWA(
                userId,
                options
              ).catch(
                error =>
                  console.error(
                    'Reconexão WA:',
                    error.message
                  )
              ),
            3000
          );
        }
      }
    }
  );

  return session;
}

/* =========================================================
   SINCRONIZAÇÃO DOS GRUPOS
========================================================= */

async function syncGroups(
  userId
) {
  const session =
    wa.get(userId);

  if (
    !session?.sock ||
    session.state !==
      'connected'
  ) {
    return;
  }

  const metadata =
    await session.sock.groupFetchAllParticipating();

  const existing =
    groups.filter(
      g => g.userId === userId
    );

  const known =
    new Map(
      existing.map(
        g => [g.jid, g]
      )
    );

  for (
    const [jid, info] of Object.entries(
      metadata || {}
    )
  ) {
    const current =
      known.get(jid);

    if (current) {
      current.name =
        info.subject ||
        current.name ||
        'Grupo';

      current.status =
        'connected';
    } else {
      groups.push({
        id: crypto.randomUUID(),
        userId,
        name:
          info.subject ||
          'Grupo',
        jid,
        inviteLink: '',
        status:
          'connected',
        createdAt:
          new Date().toISOString()
      });
    }
  }

  save(
    files.groups,
    groups
  );
}

/* =========================================================
   AUTENTICAÇÃO
========================================================= */

app.post(
  '/api/auth/register',
  (req, res) => {
    try {
      const {
        name,
        email,
        password
      } = req.body || {};

      if (
        !name ||
        !email ||
        !password
      ) {
        throw new Error(
          'Nome, e-mail e senha são obrigatórios.'
        );
      }

      const normalized =
        String(email)
          .trim()
          .toLowerCase();

      if (
        db.users.some(
          u =>
            u.email ===
            normalized
        )
      ) {
        throw new Error(
          'Este e-mail já está cadastrado.'
        );
      }

      if (
        String(password).length <
        6
      ) {
        throw new Error(
          'A senha deve possuir pelo menos 6 caracteres.'
        );
      }

      const salt =
        crypto
          .randomBytes(16)
          .toString('hex');

      const user = {
        id: crypto.randomUUID(),
        role: 'CLIENT',
        name: String(name).trim(),
        email: normalized,
        passwordHash:
          hash(
            password,
            salt
          ),
        salt,
        active: true,
        emailVerified: true,
        createdAt:
          new Date().toISOString()
      };

      db.users.push(user);

      save(
        files.db,
        db
      );

      log(
        'user_registered',
        user.id
      );

      res.json({
        ok: true,
        token: token(user),
        user
      });
    } catch (error) {
      res.status(400).json({
        error: error.message
      });
    }
  }
);

app.post(
  '/api/auth/login',
  (req, res) => {
    try {
      const {
        email,
        password
      } = req.body || {};

      const normalized =
        String(email || '')
          .trim()
          .toLowerCase();

      const user =
        db.users.find(
          u =>
            u.email ===
              normalized &&
            u.active !== false
        );

      if (
        !user ||
        !verify(
          password,
          user
        )
      ) {
        throw new Error(
          'E-mail ou senha inválidos.'
        );
      }

      log(
        'user_login',
        user.id
      );

      res.json({
        ok: true,
        token: token(user),
        user
      });
    } catch (error) {
      res.status(401).json({
        error: error.message
      });
    }
  }
);

app.get(
  '/api/auth/me',
  auth,
  (req, res) => {
    res.json({
      ok: true,
      user: req.user,
      subscription:
        subOf(req.user.id) ||
        null,
      quota:
        req.user.role ===
        'CLIENT'
          ? quota(req.user.id)
          : null
    });
  }
);

/* =========================================================
   HEALTH
========================================================= */

app.get(
  '/api/health',
  (_, res) => {
    res.json({
      ok: true,
      service:
        'OfertaZap SaaS V33',
      database:
        'JSON',
      time:
        new Date().toISOString()
    });
  }
);

/* =========================================================
   DASHBOARD
========================================================= */

app.get(
  '/api/dashboard',
  auth,
  client,
  (req, res) => {
    const uid =
      req.user.id;

    const userProducts =
      products.filter(
        p =>
          p.userId === uid
      );

    const userJobs =
      jobs.filter(
        j =>
          j.userId === uid
      );

    const userGroups =
      groups.filter(
        g =>
          g.userId === uid
      );

    const waSession =
      wa.get(uid);

    res.json({
      ok: true,

      products:
        userProducts.length,

      groups:
        userGroups.length,

      jobs:
        userJobs.length,

      pending:
        userJobs.filter(
          j =>
            j.status ===
            'pending'
        ).length,

      errors:
        userJobs.filter(
          j =>
            j.status ===
            'error'
        ).length,

      whatsapp:
        waSession?.state ||
        'disconnected',

      quota:
        req.user.role ===
        'CLIENT'
          ? quota(uid)
          : null
    });
  }
);

/* =========================================================
   PRODUTOS
========================================================= */

app.get(
  '/api/products',
  auth,
  client,
  (req, res) => {
    res.json({
      products:
        products.filter(
          p =>
            p.userId ===
            req.user.id
        )
    });
  }
);

app.post(
  '/api/products',
  auth,
  client,
  (req, res) => {
    try {
      const body =
        req.body || {};

      if (
        !body.name
      ) {
        throw new Error(
          'Nome do produto é obrigatório.'
        );
      }

      if (
        !body.link
      ) {
        throw new Error(
          'Link do produto é obrigatório.'
        );
      }

      const product = {
        id: crypto.randomUUID(),
        userId:
          req.user.id,
        name:
          String(
            body.name
          ).trim(),
        price:
          body.price !==
          undefined
            ? Number(
                body.price
              )
            : null,
        oldPrice:
          body.oldPrice
            ? Number(
                body.oldPrice
              )
            : null,
        discount:
          body.discount ||
          '',
        category:
          body.category ||
          '',
        link:
          String(
            body.link
          ).trim(),
        imageData:
          body.imageData ||
          '',
        imageUrl:
          body.imageUrl ||
          '',
        message:
          body.message ||
          '',
        createdAt:
          new Date().toISOString()
      };

      if (
        product.imageData &&
        product.imageData.length >
          4500000
      ) {
        throw new Error(
          'Imagem muito grande.'
        );
      }

      products.push(
        product
      );

      save(
        files.products,
        products
      );

      log(
        'product_created',
        req.user.id,
        {
          productId:
            product.id
        }
      );

      res.json({
        ok: true,
        product
      });
    } catch (error) {
      res.status(400).json({
        error: error.message
      });
    }
  }
);

app.patch(
  '/api/products/:id',
  auth,
  client,
  (req, res) => {
    try {
      const product =
        products.find(
          p =>
            p.id ===
              req.params.id &&
            p.userId ===
              req.user.id
        );

      if (!product) {
        return res.status(404).json({
          error:
            'Produto não encontrado.'
        });
      }

      Object.assign(
        product,
        req.body || {}
      );

      if (
        product.price !==
        undefined &&
        product.price !==
        null &&
        product.price !==
        ''
      ) {
        product.price =
          Number(
            product.price
          );
      }

      if (
        product.oldPrice
      ) {
        product.oldPrice =
          Number(
            product.oldPrice
          );
      }

      save(
        files.products,
        products
      );

      res.json({
        ok: true,
        product
      });
    } catch (error) {
      res.status(400).json({
        error: error.message
      });
    }
  }
);

app.delete(
  '/api/products/:id',
  auth,
  client,
  (req, res) => {
    products =
      products.filter(
        p =>
          !(
            p.id ===
              req.params.id &&
            p.userId ===
              req.user.id
          )
      );

    save(
      files.products,
      products
    );

    res.json({
      ok: true
    });
  }
);

/* =========================================================
   MERCADO LIVRE
========================================================= */

app.post(
  '/api/mercadolivre/product',
  auth,
  client,
  async (req, res) => {
    try {
      const link =
        String(
          req.body?.link ||
            ''
        ).trim();

      if (!link) {
        throw new Error(
          'Informe o link do Mercado Livre.'
        );
      }

      const item =
        await resolveML(link);

      const price =
        Number(
          item.price || 0
        );

      const oldPrice =
        Number(
          item.original_price ||
            0
        );

      let imageUrl =
        item.thumbnail ||
        item.pictures?.[0]
          ?.url ||
        '';

      if (
        imageUrl &&
        imageUrl.includes(
          '-I.jpg'
        )
      ) {
        imageUrl =
          imageUrl.replace(
            '-I.jpg',
            '-O.jpg'
          );
      }

      res.json({
        ok: true,
        product: {
          name:
            item.title ||
            'Produto Mercado Livre',

          price,

          oldPrice:
            oldPrice ||
            null,

          discount:
            discount(
              oldPrice,
              price
            ),

          category:
            item.category_id ||
            '',

          link,

          imageUrl,

          message: ''
        }
      });
    } catch (error) {
      res.status(400).json({
        error: error.message
      });
    }
  }
);

/* =========================================================
   TEMPLATES
========================================================= */

app.get(
  '/api/templates',
  auth,
  client,
  (req, res) => {
    res.json({
      templates:
        templates.filter(
          t =>
            !t.userId ||
            t.userId ===
              req.user.id
        )
    });
  }
);

app.post(
  '/api/templates',
  auth,
  client,
  (req, res) => {
    try {
      if (
        !req.body?.name ||
        !req.body?.text
      ) {
        throw new Error(
          'Nome e texto são obrigatórios.'
        );
      }

      const template = {
        id: crypto.randomUUID(),
        userId:
          req.user.id,
        name:
          String(
            req.body.name
          ),
        text:
          String(
            req.body.text
          ),
        createdAt:
          new Date().toISOString()
      };

      templates.push(
        template
      );

      save(
        files.templates,
        templates
      );

      res.json({
        ok: true,
        template
      });
    } catch (error) {
      res.status(400).json({
        error: error.message
      });
    }
  }
);

app.delete(
  '/api/templates/:id',
  auth,
  client,
  (req, res) => {
    templates =
      templates.filter(
        t =>
          !(
            t.id ===
              req.params.id &&
            t.userId ===
              req.user.id
          )
      );

    save(
      files.templates,
      templates
    );

    res.json({
      ok: true
    });
  }
);

/* =========================================================
   GRUPOS
========================================================= */

app.get(
  '/api/groups',
  auth,
  client,
  (req, res) => {
    res.json({
      groups:
        groups.filter(
          g =>
            g.userId ===
            req.user.id
        )
    });
  }
);

app.post(
  '/api/groups',
  auth,
  client,
  async (req, res) => {
    try {
      const name =
        String(
          req.body?.name ||
            ''
        ).trim();

      const inviteLink =
        String(
          req.body?.inviteLink ||
            ''
        ).trim();

      const jid =
        String(
          req.body?.jid ||
            ''
        ).trim();

      if (!name) {
        throw new Error(
          'Nome do grupo é obrigatório.'
        );
      }

      if (
        groups.some(
          g =>
            g.userId ===
              req.user.id &&
            (
              g.jid === jid ||
              (
                inviteLink &&
                g.inviteLink ===
                  inviteLink
              )
            )
        )
      ) {
        throw new Error(
          'Esse grupo já está cadastrado.'
        );
      }

      const group = {
        id: crypto.randomUUID(),
        userId:
          req.user.id,
        name,
        inviteLink,
        jid,
        status:
          jid
            ? 'connected'
            : 'pending',
        createdAt:
          new Date().toISOString()
      };

      groups.push(
        group
      );

      save(
        files.groups,
        groups
      );

      res.json({
        ok: true,
        group
      });
    } catch (error) {
      res.status(400).json({
        error: error.message
      });
    }
  }
);

app.delete(
  '/api/groups/:id',
  auth,
  client,
  (req, res) => {
    groups =
      groups.filter(
        g =>
          !(
            g.id ===
              req.params.id &&
            g.userId ===
              req.user.id
          )
      );

    save(
      files.groups,
      groups
    );

    res.json({
      ok: true
    });
  }
);

/* =========================================================
   WHATSAPP STATUS
========================================================= */

app.get(
  '/api/whatsapp/status',
  auth,
  client,
  (req, res) => {
    const session =
      wa.get(
        req.user.id
      );

    const authPersistent =
      fs.existsSync(
        path.join(
          AUTH_ROOT,
          req.user.id,
          'creds.json'
        )
      );

    res.json({
      ok: true,

      state:
        session?.state ||
        'disconnected',

      connected:
        session?.state ===
        'connected',

      connecting:
        session?.state ===
        'connecting',

      qrAvailable:
        Boolean(
          session?.qr
        ),

      pairingCode:
        session?.pairingCode ||
        null,

      groups:
        groups.filter(
          g =>
            g.userId ===
            req.user.id
        ).length,

      lastError:
        session?.lastError ||
        null,

      authPersistent
    });
  }
);

/* =========================================================
   WHATSAPP QR
========================================================= */

app.get(
  '/api/whatsapp/qr',
  auth,
  client,
  async (req, res) => {
    const session =
      wa.get(
        req.user.id
      );

    if (!session?.qr) {
      return res.status(404).json({
        error:
          'QR ainda não disponível. Se a sessão já estiver salva, não é necessário QR.'
      });
    }

    res.json({
      ok: true,
      qr: session.qr
    });
  }
);

/* =========================================================
   WHATSAPP START
========================================================= */

app.post(
  '/api/whatsapp/start',
  auth,
  client,
  async (req, res) => {
    try {
      const session =
        await startWA(
          req.user.id
        );

      res.json({
        ok: true,
        state:
          session.state,
        qrAvailable:
          Boolean(
            session.qr
          )
      });
    } catch (error) {
      res.status(400).json({
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   WHATSAPP PAIRING CODE
========================================================= */

app.post(
  '/api/whatsapp/pairing-code',
  auth,
  client,
  async (req, res) => {
    try {
      const phone =
        cleanPhone(
          req.body?.phone
        );

      if (
        !/^55?\d{10,13}$/.test(
          phone
        )
      ) {
        throw new Error(
          'Informe o número com DDI. Ex.: 5566999999999'
        );
      }

      let session =
        wa.get(
          req.user.id
        );

      if (
        session?.state ===
        'connected'
      ) {
        return res.json({
          ok: true,
          connected: true,
          message:
            'WhatsApp já está conectado.'
        });
      }

      if (
        !session ||
        session.state !==
          'connecting'
      ) {
        session =
          await startWA(
            req.user.id,
            {
              pairing: true
            }
          );
      }

      const code =
        await session.sock.requestPairingCode(
          phone
        );

      session.pairingCode =
        code;

      res.json({
        ok: true,
        code,
        state:
          session.state
      });
    } catch (error) {
      res.status(400).json({
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   WHATSAPP REINICIAR SESSÃO
========================================================= */

app.post(
  '/api/whatsapp/restart-session',
  auth,
  client,
  async (req, res) => {
    try {
      const uid =
        req.user.id;

      const session =
        wa.get(uid);

      try {
        await session?.sock?.logout();
      } catch {}

      wa.delete(uid);

      const dir =
        path.join(
          AUTH_ROOT,
          uid
        );

      fs.rmSync(
        dir,
        {
          recursive: true,
          force: true
        }
      );

      const newSession =
        await startWA(uid);

      res.json({
        ok: true,
        state:
          newSession.state,
        qrAvailable:
          Boolean(
            newSession.qr
          )
      });
    } catch (error) {
      res.status(400).json({
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   WHATSAPP DESCONECTAR
========================================================= */

app.post(
  '/api/whatsapp/disconnect',
  auth,
  client,
  async (req, res) => {
    const session =
      wa.get(
        req.user.id
      );

    try {
      await session?.sock?.logout();
    } catch {}

    if (session) {
      session.state =
        'disconnected';
    }

    res.json({
      ok: true
    });
  }
);

/* =========================================================
   MENSAGENS
========================================================= */

function renderMsg(
  template,
  product
) {
  return String(
    template || ''
  )
    .replaceAll(
      '{produto}',
      product.name ||
        'Produto'
    )
    .replaceAll(
      '{preco}',
      money(
        product.price
      )
    )
    .replaceAll(
      '{preco_antigo}',
      money(
        product.oldPrice
      )
    )
    .replaceAll(
      '{desconto}',
      product.discount ||
        discount(
          Number(
            product.oldPrice
          ),
          Number(
            product.price
          )
        ) ||
        ''
    )
    .replaceAll(
      '{link}',
      product.link ||
        ''
    );
}

/* =========================================================
   JOBS
========================================================= */

app.get(
  '/api/jobs',
  auth,
  client,
  (req, res) => {
    res.json({
      jobs:
        jobs.filter(
          j =>
            j.userId ===
            req.user.id
        ),
      quota:
        quota(
          req.user.id
        )
    });
  }
);

app.post(
  '/api/jobs',
  auth,
  client,
  (req, res) => {
    try {
      if (
        !activeSub(
          req.user.id
        )
      ) {
        throw new Error(
          'Assinatura vencida ou inativa. Escolha/ative um plano para agendar.'
        );
      }

      const productIds = [
        ...new Set(
          (
            Array.isArray(
              req.body.productIds
            )
              ? req.body.productIds
              : [
                  req.body.productId
                ]
          )
            .filter(Boolean)
            .map(String)
        )
      ];

      const groupIds = [
        ...new Set(
          (
            Array.isArray(
              req.body.groupIds
            )
              ? req.body.groupIds
              : [
                  req.body.groupId
                ]
          )
            .filter(Boolean)
            .map(String)
        )
      ];

      if (
        !productIds.length
      ) {
        throw new Error(
          'Selecione ou cadastre pelo menos um produto.'
        );
      }

      if (
        !groupIds.length
      ) {
        throw new Error(
          'Selecione pelo menos um grupo.'
        );
      }

      const ownProducts =
        products.filter(
          p =>
            p.userId ===
              req.user.id &&
            productIds.includes(
              p.id
            )
        );

      if (
        ownProducts.length !==
        productIds.length
      ) {
        throw new Error(
          'Um ou mais produtos não pertencem a esta conta.'
        );
      }

      const ownGroups =
        groups.filter(
          g =>
            g.userId ===
              req.user.id &&
            groupIds.includes(
              g.id
            )
        );

      if (
        ownGroups.length !==
        groupIds.length
      ) {
        throw new Error(
          'Um ou mais grupos não pertencem a esta conta.'
        );
      }

      if (
        ownGroups.some(
          g => !g.jid
        )
      ) {
        throw new Error(
          'Um ou mais grupos ainda não estão vinculados ao WhatsApp. Conecte o WhatsApp e tente novamente.'
        );
      }

      assertQuota(
        req.user.id,
        productIds
      );

      const when =
        new Date(
          req.body.scheduledAt
        );

      if (
        !Number.isFinite(
          when.getTime()
        )
      ) {
        throw new Error(
          'Data/horário inválidos.'
        );
      }

      const frequency =
        [
          'once',
          'daily',
          'weekly'
        ].includes(
          req.body.frequency
        )
          ? req.body.frequency
          : 'once';

      const job = {
        id: crypto.randomUUID(),
        userId:
          req.user.id,
        productIds,
        groupIds,
        scheduledAt:
          when.toISOString(),
        frequency,
        enabled: true,
        status: 'pending',
        sentCount: 0,
        messageTemplate:
          String(
            req.body
              .messageTemplate ||
              ''
          )
      };

      jobs.push(job);

      save(
        files.jobs,
        jobs
      );

      log(
        'job_created',
        req.user.id,
        {
          jobId:
            job.id,
          productIds,
          groupIds
        }
      );

      res.json({
        ok: true,
        job,
        quota:
          quota(
            req.user.id
          )
      });
    } catch (error) {
      res.status(400).json({
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   EDITAR JOB
========================================================= */

app.patch(
  '/api/jobs/:id',
  auth,
  client,
  (req, res) => {
    try {
      const job =
        jobs.find(
          j =>
            j.id ===
              req.params.id &&
            j.userId ===
              req.user.id
        );

      if (!job) {
        return res.status(404).json({
          error:
            'Agendamento não encontrado.'
        });
      }

      const next = {
        ...job,
        ...(req.body || {})
      };

      const productIds = [
        ...new Set(
          jobProductIds(
            next
          )
            .filter(Boolean)
            .map(String)
        )
      ];

      const groupIds = [
        ...new Set(
          (
            Array.isArray(
              next.groupIds
            )
              ? next.groupIds
              : [
                  next.groupId
                ]
          )
            .filter(Boolean)
            .map(String)
        )
      ];

      if (
        !productIds.length ||
        !groupIds.length
      ) {
        throw new Error(
          'Agendamento precisa de produto e grupo.'
        );
      }

      if (
        products.filter(
          p =>
            p.userId ===
              req.user.id &&
            productIds.includes(
              p.id
            )
        ).length !==
        productIds.length
      ) {
        throw new Error(
          'Produto inválido para esta conta.'
        );
      }

      if (
        groups.filter(
          g =>
            g.userId ===
              req.user.id &&
            groupIds.includes(
              g.id
            )
        ).length !==
        groupIds.length
      ) {
        throw new Error(
          'Grupo inválido para esta conta.'
        );
      }

      if (
        groups
          .filter(
            g =>
              g.userId ===
                req.user.id &&
              groupIds.includes(
                g.id
              )
          )
          .some(
            g => !g.jid
          )
      ) {
        throw new Error(
          'Grupo ainda não vinculado ao WhatsApp.'
        );
      }

      if (
        next.enabled !==
        false
      ) {
        assertQuota(
          req.user.id,
          productIds
        );
      }

      Object.assign(
        job,
        next,
        {
          productIds,
          groupIds
        }
      );

      save(
        files.jobs,
        jobs
      );

      res.json({
        ok: true,
        job,
        quota:
          quota(
            req.user.id
          )
      });
    } catch (error) {
      res.status(400).json({
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   DELETAR JOB
========================================================= */

app.delete(
  '/api/jobs/:id',
  auth,
  client,
  (req, res) => {
    jobs =
      jobs.filter(
        j =>
          !(
            j.id ===
              req.params.id &&
            j.userId ===
              req.user.id
          )
      );

    save(
      files.jobs,
      jobs
    );

    res.json({
      ok: true
    });
  }
);

/* =========================================================
   ENVIAR MENSAGEM
========================================================= */

async function sendOne(
  userId,
  job,
  product,
  group
) {
  const session =
    wa.get(userId);

  if (
    !session?.sock ||
    session.state !==
      'connected'
  ) {
    throw new Error(
      'WhatsApp desconectado.'
    );
  }

  const text =
    renderMsg(
      job.messageTemplate ||
        product.message ||
        templates[0].text,
      product
    );

  if (
    product.imageData
  ) {
    const match =
      String(
        product.imageData
      ).match(
        /^data:(.+?);base64,(.*)$/
      );

    if (match) {
      await session.sock.sendMessage(
        group.jid,
        {
          image:
            Buffer.from(
              match[2],
              'base64'
            ),
          caption: text
        }
      );
    } else if (
      product.imageUrl
    ) {
      await session.sock.sendMessage(
        group.jid,
        {
          image: {
            url:
              product.imageUrl
          },
          caption: text
        }
      );
    } else {
      await session.sock.sendMessage(
        group.jid,
        {
          text
        }
      );
    }
  } else if (
    product.imageUrl
  ) {
    await session.sock.sendMessage(
      group.jid,
      {
        image: {
          url:
            product.imageUrl
        },
        caption: text
      }
    );
  } else {
    await session.sock.sendMessage(
      group.jid,
      {
        text
      }
    );
  }

  job.sentCount =
    (job.sentCount || 0) +
    1;
}

/* =========================================================
   ENVIAR AGORA
========================================================= */

app.post(
  '/api/jobs/:id/send',
  auth,
  client,
  async (req, res) => {
    const job =
      jobs.find(
        j =>
          j.id ===
            req.params.id &&
          j.userId ===
            req.user.id
      );

    if (!job) {
      return res.status(404).json({
        error:
          'Agendamento não encontrado.'
      });
    }

    try {
      if (
        !activeSub(
          req.user.id
        )
      ) {
        throw new Error(
          'Assinatura vencida ou inativa.'
        );
      }

      const selectedGroups =
        groups.filter(
          g =>
            g.userId ===
              req.user.id &&
            (
              job.groupIds ||
              []
            ).includes(
              g.id
            )
        );

      const selectedProducts =
        products.filter(
          p =>
            p.userId ===
              req.user.id &&
            (
              job.productIds ||
              []
            ).includes(
              p.id
            )
        );

      if (
        !selectedGroups.length ||
        !selectedProducts.length
      ) {
        throw new Error(
          'Selecione pelo menos um produto e um grupo.'
        );
      }

      for (
        const product of selectedProducts
      ) {
        for (
          const group of selectedGroups
        ) {
          await sendOne(
            req.user.id,
            job,
            product,
            group
          );
        }
      }

      job.status =
        'sent';

      job.enabled =
        false;

      job.sentAt =
        new Date().toISOString();

      save(
        files.jobs,
        jobs
      );

      log(
        'job_sent_now',
        req.user.id,
        {
          jobId:
            job.id
        }
      );

      res.json({
        ok: true,
        job
      });
    } catch (error) {
      job.status =
        'error';

      job.error =
        error.message;

      save(
        files.jobs,
        jobs
      );

      res.status(400).json({
        error:
          error.message,
        job
      });
    }
  }
);

/* =========================================================
   PROCESSAMENTO DOS AGENDAMENTOS
========================================================= */

async function processJobs() {
  const now =
    Date.now();

  for (
    const job of jobs.filter(
      j =>
        j.enabled !== false &&
        j.status ===
          'pending'
    )
  ) {
    if (
      new Date(
        job.scheduledAt
      ).getTime() > now
    ) {
      continue;
    }

    const selectedGroups =
      groups.filter(
        g =>
          g.userId ===
            job.userId &&
          (
            job.groupIds ||
            []
          ).includes(
            g.id
          )
      );

    const selectedProducts =
      products.filter(
        p =>
          p.userId ===
            job.userId &&
          (
            job.productIds ||
            []
          ).includes(
            p.id
          )
      );

    try {
      for (
        const product of selectedProducts
      ) {
        for (
          const group of selectedGroups
        ) {
          await sendOne(
            job.userId,
            job,
            product,
            group
          );
        }
      }

      if (
        job.frequency ===
        'once'
      ) {
        job.status =
          'sent';

        job.enabled =
          false;
      } else if (
        job.frequency ===
        'daily'
      ) {
        job.scheduledAt =
          new Date(
            new Date(
              job.scheduledAt
            ).getTime() +
              864e5
          ).toISOString();
      } else if (
        job.frequency ===
        'weekly'
      ) {
        job.scheduledAt =
          new Date(
            new Date(
              job.scheduledAt
            ).getTime() +
              7 * 864e5
          ).toISOString();
      } else {
        job.status =
          'sent';

        job.enabled =
          false;
      }
    } catch (error) {
      job.error =
        error.message;

      job.status =
        'error';
    }
  }

  save(
    files.jobs,
    jobs
  );
}

cron.schedule(
  '* * * * *',
  () =>
    processJobs().catch(
      error =>
        console.error(
          'Jobs:',
          error
        )
    ),
  {
    timezone: TZ
  }
);

/* =========================================================
   EXPIRAÇÃO DE ASSINATURAS
========================================================= */

cron.schedule(
  '*/5 * * * *',
  () => {
    let changed =
      false;

    for (
      const subscription of db.subscriptions
    ) {
      if (
        subscription.status ===
          'active' &&
        new Date(
          subscription.expiresAt
        ) <= new Date()
      ) {
        subscription.status =
          'expired';

        changed =
          true;

        log(
          'subscription_expired',
          subscription.userId
        );
      }
    }

    if (changed) {
      save(
        files.db,
        db
      );
    }
  },
  {
    timezone: TZ
  }
);

/* =========================================================
   PLANOS
========================================================= */

app.get(
  '/api/plans',
  auth,
  client,
  (req, res) => {
    res.json({
      plans: db.plans
    });
  }
);

/* =========================================================
   SELECIONAR PLANO
========================================================= */

app.post(
  '/api/subscription/select',
  auth,
  client,
  (req, res) => {
    try {
      const plan =
        db.plans.find(
          p =>
            p.id ===
            req.body?.planId
        );

      if (!plan) {
        throw new Error(
          'Plano não encontrado.'
        );
      }

      let subscription =
        subOf(
          req.user.id
        );

      if (!subscription) {
        subscription = {
          id:
            crypto.randomUUID(),
          userId:
            req.user.id,
          status:
            'pending'
        };

        db.subscriptions.push(
          subscription
        );
      }

      subscription.requestedPlanId =
        plan.id;

      subscription.requestedPlanName =
        plan.name;

      subscription.requestedAt =
        new Date().toISOString();

      save(
        files.db,
        db
      );

      log(
        'subscription_plan_selected',
        req.user.id,
        {
          planId:
            plan.id
        }
      );

      res.json({
        ok: true,
        plan,
        subscription
      });
    } catch (error) {
      res.status(400).json({
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   WEBHOOK PAGAMENTO
========================================================= */

app.post(
  '/api/payments/webhook',
  (req, res) => {
    try {
      const secret =
        req.headers[
          'x-webhook-secret'
        ] || '';

      if (
        process.env
          .PAYMENT_WEBHOOK_SECRET &&
        secret !==
          process.env
            .PAYMENT_WEBHOOK_SECRET
      ) {
        return res.status(401).json({
          error:
            'Webhook não autorizado.'
        });
      }

      const {
        userId,
        status,
        planId,
        paymentId
      } =
        req.body || {};

      const user =
        db.users.find(
          u =>
            u.id ===
            userId
        );

      if (!user) {
        return res.status(404).json({
          error:
            'Cliente não encontrado.'
        });
      }

      let subscription =
        subOf(userId);

      if (!subscription) {
        subscription = {
          id:
            crypto.randomUUID(),
          userId
        };

        db.subscriptions.push(
          subscription
        );
      }

      if (
        [
          'approved',
          'paid',
          'confirmed'
        ].includes(status)
      ) {
        const base =
          new Date(
            subscription.expiresAt
          ) > new Date()
            ? new Date(
                subscription.expiresAt
              )
            : new Date();

        subscription.status =
          'active';

        subscription.planId =
          planId ||
          subscription.planId ||
          'p1';

        subscription.startedAt =
          new Date().toISOString();

        subscription.expiresAt =
          new Date(
            base.getTime() +
              30 * 864e5
          ).toISOString();

        subscription.paymentId =
          paymentId || '';

        user.active =
          true;

        log(
          'payment_confirmed',
          'system',
          {
            userId,
            planId,
            paymentId
          }
        );
      }

      save(
        files.db,
        db
      );

      res.json({
        ok: true,
        subscription
      });
    } catch (error) {
      res.status(400).json({
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   MASTER — CLIENTES
========================================================= */

app.get(
  '/api/master/users',
  auth,
  master,
  (req, res) => {
    res.json({
      users:
        db.users.map(
          user => ({
            id:
              user.id,
            name:
              user.name,
            email:
              user.email,
            role:
              user.role,
            active:
              user.active !==
              false,
            createdAt:
              user.createdAt,
            subscription:
              subOf(
                user.id
              ) || null
          })
        )
    });
  }
);

/* =========================================================
   MASTER — ATIVAR/DESATIVAR
========================================================= */

app.patch(
  '/api/master/users/:id',
  auth,
  master,
  (req, res) => {
    try {
      const user =
        db.users.find(
          u =>
            u.id ===
            req.params.id
        );

      if (!user) {
        return res.status(404).json({
          error:
            'Cliente não encontrado.'
        });
      }

      if (
        typeof req.body.active ===
        'boolean'
      ) {
        user.active =
          req.body.active;
      }

      save(
        files.db,
        db
      );

      res.json({
        ok: true,
        user
      });
    } catch (error) {
      res.status(400).json({
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   MASTER — ASSINATURA
========================================================= */

app.patch(
  '/api/master/users/:id/subscription',
  auth,
  master,
  (req, res) => {
    try {
      const user =
        db.users.find(
          u =>
            u.id ===
            req.params.id
        );

      if (!user) {
        return res.status(404).json({
          error:
            'Cliente não encontrado.'
        });
      }

      const plan =
        db.plans.find(
          p =>
            p.id ===
            req.body?.planId
        );

      if (!plan) {
        throw new Error(
          'Plano não encontrado.'
        );
      }

      let subscription =
        subOf(user.id);

      if (!subscription) {
        subscription = {
          id:
            crypto.randomUUID(),
          userId:
            user.id
        };

        db.subscriptions.push(
          subscription
        );
      }

      const days =
        Number(
          req.body?.days || 30
        );

      subscription.planId =
        plan.id;

      subscription.status =
        'active';

      subscription.startedAt =
        new Date().toISOString();

      subscription.expiresAt =
        new Date(
          Date.now() +
            days *
              864e5
        ).toISOString();

      user.active =
        true;

      save(
        files.db,
        db
      );

      log(
        'master_subscription_updated',
        req.user.id,
        {
          clientId:
            user.id,
          planId:
            plan.id,
          days
        }
      );

      res.json({
        ok: true,
        subscription
      });
    } catch (error) {
      res.status(400).json({
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   MASTER — LOGS
========================================================= */

app.get(
  '/api/master/logs',
  auth,
  master,
  (req, res) => {
    res.json({
      logs:
        logs.slice(
          0,
          500
        )
    });
  }
);

/* =========================================================
   MASTER — DASHBOARD
========================================================= */

app.get(
  '/api/master/dashboard',
  auth,
  master,
  (req, res) => {
    const clients =
      db.users.filter(
        u =>
          u.role ===
          'CLIENT'
      );

    const active =
      clients.filter(
        u =>
          activeSub(
            u.id
          )
      );

    const connected =
      clients.filter(
        u =>
          wa.get(
            u.id
          )?.state ===
          'connected'
      );

    res.json({
      ok: true,

      totalClients:
        clients.length,

      activeSubscriptions:
        active.length,

      connectedWhatsApp:
        connected.length,

      totalProducts:
        products.length,

      totalJobs:
        jobs.length,

      totalGroups:
        groups.length,

      errors:
        jobs.filter(
          j =>
            j.status ===
            'error'
        ).length
    });
  }
);

/* =========================================================
   FRONTEND
========================================================= */

app.use(
  express.static(
    path.join(
      process.cwd(),
      'public'
    )
  )
);

app.get(
  '/',
  (_, res) => {
    res.sendFile(
      path.join(
        process.cwd(),
        'public',
        'index.html'
      )
    );
  }
);

app.get(
  '/*splat',
  (_, res) => {
    res.sendFile(
      path.join(
        process.cwd(),
        'public',
        'index.html'
      )
    );
  }
);

/* =========================================================
   START
========================================================= */

ensureMaster();

app.listen(
  PORT,
  '0.0.0.0',
  () => {
    console.log(
      `OfertaZap SaaS V33 na porta ${PORT}`
    );

    console.log(
      `DATA_DIR=${ROOT}`
    );

    console.log(
      `AUTH_ROOT=${AUTH_ROOT}`
    );

    for (
      const user of db.users.filter(
        u =>
          u.role ===
            'CLIENT' &&
          u.active !== false
      )
    ) {
      if (
        activeSub(
          user.id
        )
      ) {
        startWA(
          user.id
        ).catch(
          error =>
            console.error(
              'WA',
              user.id,
              error.message
            )
        );
      }
    }
  }
);
