import "dotenv/config";
import express from "express";
import cors from "cors";
import cron from "node-cron";
import QRCode from "qrcode";
import pino from "pino";
import { randomUUID } from "node:crypto";
import { Boom } from "@hapi/boom";
import makeWASocket,{DisconnectReason,fetchLatestBaileysVersion,useMultiFileAuthState,makeCacheableSignalKeyStore} from "@whiskeysockets/baileys";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const app=express(),PORT=Number(process.env.PORT||3000),API_TOKEN=process.env.API_TOKEN||"",TZ=process.env.TZ||"America/Sao_Paulo";
const ML_CLIENT_ID=process.env.ML_CLIENT_ID||"",ML_CLIENT_SECRET=process.env.ML_CLIENT_SECRET||"",ML_REDIRECT_URI=process.env.ML_REDIRECT_URI||"https://ofertazap-api1.onrender.com/api/mercadolivre/callback";

app.use(cors({origin:process.env.FRONTEND_ORIGIN||"*"}));
app.use(express.json({limit:"1mb"}));

const DATA_DIR=path.resolve("./data"),AUTH_DIR=path.resolve("./auth_info_baileys");
fs.mkdirSync(DATA_DIR,{recursive:true});
fs.mkdirSync(AUTH_DIR,{recursive:true});

const GROUPS_FILE=path.join(DATA_DIR,"groups.json");
const JOBS_FILE=path.join(DATA_DIR,"jobs.json");
const ML_TOKEN_FILE=path.join(DATA_DIR,"mercadolivre.json");

function loadJson(file,fallback=[]){
  try{
    return fs.existsSync(file)?JSON.parse(fs.readFileSync(file,"utf8")):fallback
  }catch{
    return fallback
  }
}

function saveJson(file,data){
  fs.writeFileSync(file,JSON.stringify(data,null,2),"utf8")
}

let groups=loadJson(GROUPS_FILE,[]);
let jobs=loadJson(JOBS_FILE,[]);
let mlTokens=loadJson(ML_TOKEN_FILE,{});
let sock=null;
let qrDataUrl=null;
let connectionState="disconnected";
let lastError=null;
let mlOAuthState=null;


// ======================================================
// MERCADO LIVRE - OAUTH
// ======================================================

function requireML(){
  if(!ML_CLIENT_ID||!ML_CLIENT_SECRET||!ML_REDIRECT_URI){
    throw new Error(
      "Mercado Livre OAuth não configurado. Verifique ML_CLIENT_ID, ML_CLIENT_SECRET e ML_REDIRECT_URI no Render."
    )
  }
}

function buildMLAuthUrl(){
  requireML();

  mlOAuthState=crypto.randomBytes(24).toString("hex");

  const u=new URL(
    "https://auth.mercadolivre.com.br/authorization"
  );

  u.searchParams.set("response_type","code");
  u.searchParams.set("client_id",ML_CLIENT_ID);
  u.searchParams.set("redirect_uri",ML_REDIRECT_URI);
  u.searchParams.set("state",mlOAuthState);
  u.searchParams.set("scope","offline_access read write");

  return u.toString()
}

async function exchangeMLCode(code){
  requireML();

  const body=new URLSearchParams({
    grant_type:"authorization_code",
    client_id:ML_CLIENT_ID,
    client_secret:ML_CLIENT_SECRET,
    code,
    redirect_uri:ML_REDIRECT_URI
  });

  const r=await fetch(
    "https://api.mercadolibre.com/oauth/token",
    {
      method:"POST",
      headers:{
        accept:"application/json",
        "content-type":"application/x-www-form-urlencoded"
      },
      body
    }
  );

  const d=await r.json();

  if(!r.ok){
    throw new Error(
      d.error_description||
      d.message||
      "Falha ao obter token do Mercado Livre"
    )
  }

  mlTokens={
    ...d,
    savedAt:new Date().toISOString()
  };

  saveJson(
    ML_TOKEN_FILE,
    mlTokens
  );

  return d
}

async function refreshML(){
  requireML();

  if(!mlTokens.refresh_token){
    throw new Error(
      "Mercado Livre ainda não foi autorizado. Conecte a conta primeiro."
    )
  }

  const body=new URLSearchParams({
    grant_type:"refresh_token",
    client_id:ML_CLIENT_ID,
    client_secret:ML_CLIENT_SECRET,
    refresh_token:mlTokens.refresh_token
  });

  const r=await fetch(
    "https://api.mercadolibre.com/oauth/token",
    {
      method:"POST",
      headers:{
        accept:"application/json",
        "content-type":"application/x-www-form-urlencoded"
      },
      body
    }
  );

  const d=await r.json();

  if(!r.ok){
    throw new Error(
      d.error_description||
      d.message||
      "Falha ao renovar token do Mercado Livre"
    )
  }

  mlTokens={
    ...d,
    savedAt:new Date().toISOString()
  };

  saveJson(
    ML_TOKEN_FILE,
    mlTokens
  );

  return d
}

async function getMLToken(){
  if(!mlTokens.access_token){
    throw new Error(
      "Mercado Livre não conectado. Autorize a conta primeiro."
    )
  }

  const expiration=
    new Date(
      mlTokens.savedAt||0
    ).getTime()+
    Number(
      mlTokens.expires_in||21600
    )*1000;

  if(Date.now()<expiration-120000){
    return mlTokens.access_token
  }

  return(
    await refreshML()
  ).access_token
}


// ======================================================
// MERCADO LIVRE - ID
// ======================================================

function extractMLIds(value){
  const matches=
    String(value||"").match(
      /\bMLB[-_]?\d{6,}\b/gi
    )||[];

  return[
    ...new Set(
      matches.map(
        x=>
          x
            .replace(/[-_]/g,"")
            .toUpperCase()
      )
    )
  ]
}


// ======================================================
// MERCADO LIVRE - RESOLVER V14
// ======================================================

async function resolveMercadoLivreItemId(
  value,
  token
){
  const original=
    String(value||"").trim();

  if(!original){
    throw new Error(
      "Informe o link do Mercado Livre."
    )
  }

  if(!token){
    throw new Error(
      "Mercado Livre não conectado. Autorize a conta primeiro."
    )
  }

  async function valid(id){
    try{
      const r=await fetch(
        `https://api.mercadolibre.com/items/${encodeURIComponent(id)}`,
        {
          headers:{
            Authorization:`Bearer ${token}`,
            Accept:"application/json"
          }
        }
      );

      if(!r.ok){
        return null
      }

      const d=await r.json();

      return d?.id?d:null
    }catch{
      return null
    }
  }

  // Primeiro tenta MLB que já esteja no texto.
  for(
    const id of
    extractMLIds(original)
  ){
    const d=
      await valid(id);

    if(d){
      return d.id
    }
  }

  if(
    !/^https?:\/\//i.test(
      original
    )
  ){
    throw new Error(
      "Digite uma URL válida do Mercado Livre."
    )
  }

  const candidates=[
    original
  ];

  const seen=
    new Set();

  let networkError=null;


  function clean(value){
    return String(
      value||""
    )
      .trim()
      .replace(
        /\\u0026/g,
        "&"
      )
      .replace(
        /\\u003A/gi,
        ":"
      )
      .replace(
        /\\u002F/gi,
        "/"
      )
      .replace(
        /\\\//g,
        "/"
      )
      .replace(
        /&amp;/gi,
        "&"
      )
      .replace(
        /&#x2F;/gi,
        "/"
      )
      .replace(
        /&#47;/g,
        "/"
      )
      .replace(
        /&quot;/gi,
        '"'
      )
      .replace(
        /&#39;/gi,
        "'"
      )
  }


  function add(value,base){
    if(!value){
      return
    }

    let x=
      clean(value);

    try{
      if(
        base&&
        !/^https?:\/\//i.test(
          x
        )
      ){
        x=
          new URL(
            x,
            base
          ).toString()
      }
    }catch{}

    if(
      /^https?:\/\//i.test(x)&&
      !candidates.includes(x)
    ){
      candidates.push(x)
    }
  }


  function parse(html,base){
    if(!html){
      return
    }

    const h=
      clean(html);


    const patterns=[
      /(?:href|src|data-url|data-href|data-link)\s*=\s*["']([^"']+)["']/gi,

      /https?:\/\/[^\s"'<>\\]+/gi,

      /(?:window\.)?location(?:\.href|\.replace|\.assign)?\s*(?:=|\()\s*["']([^"']+)["']/gi,

      /url\s*=\s*([^"'<>;]+)/gi
    ];


    for(
      const regex of
      patterns
    ){
      let m;

      while(
        (m=regex.exec(h))!==null
      ){
        add(
          m[1]||m[0],
          base
        )
      }
    }


    // Procura links relativos que já contenham MLB.
    const relative=
      /(?:href|data-url|data-href)\s*=\s*["'](\/[^"']*(?:MLB[-_]?\d{6,}|\/p\/MLB\d{6,})[^"']*)["']/gi;

    let m;

    while(
      (m=relative.exec(h))!==null
    ){
      add(
        m[1],
        base
      )
    }


    // Algumas páginas sociais do Mercado Livre
    // destacam o produto principal nesse bloco.
    const featured=
      h.match(
        /rl-card-featured[\s\S]{0,250000}/gi
      )||[];

    for(
      const block of
      featured
    ){
      const a=
        block.match(
          /(?:href|data-url|data-href)\s*=\s*["']([^"']+)["']/i
        );

      if(a){
        add(
          a[1],
          base
        )
      }
    }
  }


  async function inspect(url){
    const headersList=[
      {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",

        accept:
          "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",

        "accept-language":
          "pt-BR,pt;q=0.9,en;q=0.8"
      },

      {
        "user-agent":
          "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36",

        accept:
          "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",

        "accept-language":
          "pt-BR,pt;q=0.9,en;q=0.8"
      }
    ];


    for(
      const headers of
      headersList
    ){
      try{
        const r=
          await fetch(
            url,
            {
              redirect:"follow",
              headers
            }
          );

        add(
          r.url||url,
          url
        );

        const location=
          r.headers.get(
            "location"
          );

        if(location){
          add(
            location,
            url
          )
        }

        let html="";

        try{
          html=
            await r.text()
        }catch{}

        parse(
          html,
          r.url||url
        );

        return{
          r,
          html
        }
      }catch(e){
        networkError=e
      }
    }

    return null
  }


  // Até 20 redirecionamentos/páginas.
  for(
    let n=0;
    n<20;
    n++
  ){
    const current=
      candidates.find(
        x=>!seen.has(x)
      );

    if(!current){
      break
    }

    seen.add(
      current
    );

    const result=
      await inspect(
        current
      );

    if(!result){
      continue
    }

    const{
      r,
      html
    }=
      result;


    add(
      r.url||current,
      current
    );


    const location=
      r.headers.get(
        "location"
      );

    if(location){
      add(
        location,
        current
      )
    }


    parse(
      html,
      r.url||current
    );


    // Valida todos os MLB encontrados.
    const ids=[];

    for(
      const candidate of
      candidates
    ){
      for(
        const id of
        extractMLIds(
          candidate
        )
      ){
        if(
          !ids.includes(id)
        ){
          ids.push(id)
        }
      }
    }


    for(
      const id of
      ids
    ){
      const d=
        await valid(id);

      if(d){
        console.log(
          `[Mercado Livre V14] Item válido encontrado: ${d.id}`
        );

        return d.id
      }
    }
  }


  if(networkError){
    console.error(
      "[Mercado Livre V14] Erro de rede:",
      networkError.message,
      networkError.cause?.code||""
    );

    throw new Error(
      "O servidor não conseguiu acessar o link do Mercado Livre. Tente novamente ou use o link completo do anúncio."
    )
  }


  throw new Error(
    "Não consegui encontrar um anúncio válido do Mercado Livre nesse link. Se for meli.la, ele pode apontar para uma vitrine/lista; nesse caso, use o link direto do produto."
  )
}


// ======================================================
// MERCADO LIVRE - PRODUTO
// ======================================================

async function getMLProduct(link){
  let token=
    await getMLToken();

  const id=
    await resolveMercadoLivreItemId(
      link,
      token
    );


  async function get(t){
    return fetch(
      `https://api.mercadolibre.com/items/${encodeURIComponent(id)}`,
      {
        headers:{
          Authorization:
            `Bearer ${t}`,

          Accept:
            "application/json"
        }
      }
    )
  }


  let r=
    await get(token);


  if(
    r.status===401
  ){
    token=
      (
        await refreshML()
      ).access_token;

    r=
      await get(token)
  }


  let d={};

  try{
    d=
      await r.json()
  }catch{}


  if(!r.ok){
    throw new Error(
      d.message||
      d.error||
      `Não foi possível consultar o anúncio ${id}.`
    )
  }


  const pictures=
    Array.isArray(
      d.pictures
    )
      ?d.pictures
        .map(
          p=>
            p.secure_url||
            p.url
        )
        .filter(Boolean)
      :[];


  return{
    id:d.id,
    title:d.title||"",
    price:d.price??null,
    oldPrice:d.original_price??null,
    currency:d.currency_id||"BRL",
    image:pictures[0]||null,
    pictures,
    permalink:d.permalink||null
  }
}


// ======================================================
// OAUTH CALLBACK
// ======================================================

app.get(
  "/api/mercadolivre/callback",
  async(
    req,
    res
  )=>{
    try{
      const{
        code,
        state,
        error,
        error_description
      }=req.query;


      if(error){
        return res
          .status(400)
          .send(
            `Autorização cancelada: ${error_description||error}`
          )
      }


      if(!code){
        return res
          .status(400)
          .send(
            "Código de autorização não recebido."
          )
      }


      if(
        !mlOAuthState||
        state!==mlOAuthState
      ){
        return res
          .status(400)
          .send(
            "Estado OAuth inválido ou expirado."
          )
      }


      await exchangeMLCode(
        code
      );

      mlOAuthState=null;


      res.send(
        "<h2>OfertaZap conectado ao Mercado Livre ✅</h2><p>Você pode fechar esta página e voltar ao painel.</p>"
      )
    }catch(e){
      res
        .status(400)
        .send(
          `<h2>Erro ao conectar Mercado Livre</h2><p>${String(e.message).replace(/[<>]/g,"")}</p>`
        )
    }
  }
)


// ======================================================
// AUTENTICAÇÃO
// ======================================================

function auth(
  req,
  res,
  next
){
  if(!API_TOKEN){
    return res
      .status(503)
      .json({
        error:
          "API_TOKEN não configurado no servidor"
      })
  }


  const a=
    req.headers.authorization||
    "";

  const bearer=
    a.startsWith(
      "Bearer "
    )
      ?a.slice(7)
      :"";


  const t=
    bearer||
    req.headers[
      "x-api-token"
    ]||
    "";


  if(
    t!==API_TOKEN
  ){
    return res
      .status(401)
      .json({
        error:
          "Token inválido"
      })
  }


  next()
}


// ======================================================
// ROTAS PÚBLICAS
// ======================================================

app.get(
  "/",
  (_q,res)=>
    res.json({
      ok:true,
      service:"OfertaZap API",
      status:connectionState,
      health:"/api/health"
    })
);


app.get(
  "/api/health",
  (_q,res)=>
    res.json({
      ok:true,
      service:"OfertaZap API",
      time:new Date().toISOString()
    })
);


app.get(
  "/api/mercadolivre/auth",
  (req,res)=>{
    try{
      const authorizationUrl=
        buildMLAuthUrl();


      if(
        String(
          req.query.redirect||""
        )==="1"
      ){
        return res.redirect(
          authorizationUrl
        )
      }


      res.json({
        ok:true,
        authorizationUrl
      })
    }catch(e){
      res
        .status(503)
        .json({
          ok:false,
          error:e.message
        })
    }
  }
);


app.use(
  "/api",
  auth
);


// ======================================================
// MERCADO LIVRE STATUS
// ======================================================

app.get(
  "/api/mercadolivre/status",
  (_q,res)=>{
    const missing=[];

    if(!ML_CLIENT_ID)
      missing.push(
        "ML_CLIENT_ID"
      );

    if(!ML_CLIENT_SECRET)
      missing.push(
        "ML_CLIENT_SECRET"
      );

    if(!ML_REDIRECT_URI)
      missing.push(
        "ML_REDIRECT_URI"
      );


    res.json({
      ok:true,
      configured:
        missing.length===0,

      missing,

      connected:
        Boolean(
          mlTokens.access_token&&
          mlTokens.refresh_token
        ),

      userId:
        mlTokens.user_id||null,

      expiresAt:
        mlTokens.savedAt
          ?new Date(
              new Date(
                mlTokens.savedAt
              ).getTime()+
              Number(
                mlTokens.expires_in||21600
              )*1000
            ).toISOString()
          :null
    })
  }
);


// ======================================================
// PREVIEW PRODUTO
// ======================================================

app.post(
  "/api/products/preview",
  async(
    req,
    res
  )=>{
    try{
      const{
        link,
        url
      }=
        req.body||{};


      if(
        !link&&!url
      ){
        return res
          .status(400)
          .json({
            error:
              "Informe o link do Mercado Livre"
          })
      }


      const product=
        await getMLProduct(
          link||url
        );


      res.json({
        ok:true,
        product
      })
    }catch(e){
      res
        .status(400)
        .json({
          error:
            e.message
        })
    }
  }
);


// ======================================================
// STATUS
// ======================================================

app.get(
  "/api/status",
  (_q,res)=>
    res.json({
      ok:true,
      whatsapp:
        connectionState,
      qrAvailable:
        Boolean(qrDataUrl),
      groups:
        groups.length,
      jobs:
        jobs.length,
      lastError
    })
);


app.get(
  "/api/whatsapp/qr",
  (_q,res)=>{
    if(!qrDataUrl){
      return res
        .status(404)
        .json({
          error:
            "QR Code ainda não disponível"
        })
    }

    res.json({
      ok:true,
      qr:qrDataUrl
    })
  }
);


// ======================================================
// WHATSAPP
// ======================================================

async function startWhatsApp(){
  if(
    connectionState==="connecting"||
    connectionState==="connected"
  ){
    return
  }


  connectionState=
    "connecting";

  lastError=null;


  const{
    state,
    saveCreds
  }=
    await useMultiFileAuthState(
      AUTH_DIR
    );


  const{
    version
  }=
    await fetchLatestBaileysVersion();


  sock=
    makeWASocket({
      version,

      logger:
        pino({
          level:"silent"
        }),

      auth:{
        creds:
          state.creds,

        keys:
          makeCacheableSignalKeyStore(
            state.keys,
            pino({
              level:"silent"
            })
          )
      },

      printQRInTerminal:false,

      browser:[
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
    async({
      connection,
      lastDisconnect,
      qr
    })=>{
      if(qr){
        qrDataUrl=
          await QRCode.toDataURL(
            qr
          )
      }


      if(
        connection==="open"
      ){
        connectionState=
          "connected";

        qrDataUrl=null;
        lastError=null;

        console.log(
          "WhatsApp conectado."
        )
      }


      if(
        connection==="close"
      ){
        connectionState=
          "disconnected";


        const code=
          new Boom(
            lastDisconnect?.error
          )
            ?.output
            ?.statusCode;


        lastError=
          String(
            code||
            lastDisconnect?.error?.message||
            "Conexão encerrada"
          );


        if(
          code!==
          DisconnectReason.loggedOut
        ){
          setTimeout(
            ()=>{
              startWhatsApp()
                .catch(
                  e=>{
                    lastError=
                      e.message;

                    connectionState=
                      "disconnected"
                  }
                )
            },
            5000
          )
        }
      }
    }
  )
}


app.post(
  "/api/whatsapp/start",
  async(
    _q,
    res
  )=>{
    try{
      await startWhatsApp();

      res.json({
        ok:true,
        status:
          connectionState,
        qrAvailable:
          Boolean(qrDataUrl)
      })
    }catch(e){
      lastError=
        e.message;

      connectionState=
        "disconnected";

      res
        .status(500)
        .json({
          error:
            e.message
        })
    }
  }
);


// ======================================================
// GRUPOS
// ======================================================

function inviteCode(v){
  return(
    String(v||"")
      .match(
        /chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/i
      )?.[1]||
    null
  )
}


app.get(
  "/api/groups",
  (_q,res)=>
    res.json({
      ok:true,
      groups
    })
);


app.post(
  "/api/groups",
  async(
    req,
    res
  )=>{
    const{
      name,
      inviteLink,
      jid
    }=
      req.body||{};


    if(
      !name&&
      !inviteLink&&
      !jid
    ){
      return res
        .status(400)
        .json({
          error:
            "Informe name, inviteLink ou jid"
        })
    }


    let groupJid=
      jid||null;

    let groupName=
      name||
      "Grupo WhatsApp";


    try{
      if(!sock){
        return res
          .status(409)
          .json({
            error:
              "WhatsApp não está conectado"
          })
      }


      if(
        !groupJid&&
        inviteLink
      ){
        const code=
          inviteCode(
            inviteLink
          );


        if(!code){
          return res
            .status(400)
            .json({
              error:
                "Link de convite inválido"
            })
        }


        const info=
          await sock.groupGetInviteInfo(
            code
          );


        groupJid=
          info.id;

        groupName=
          name||
          info.subject||
          groupName;


        try{
          await sock.groupAcceptInvite(
            code
          )
        }catch{}
      }


      const item={
        id:
          randomUUID(),

        name:
          groupName,

        jid:
          groupJid,

        inviteLink:
          inviteLink||
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
        ok:true,
        group:item
      })
    }catch(e){
      res
        .status(400)
        .json({
          error:
            e.message
        })
    }
  }
);


app.delete(
  "/api/groups/:id",
  (req,res)=>{
    const n=
      groups.length;

    groups=
      groups.filter(
        g=>
          g.id!==
          req.params.id
      );


    saveJson(
      GROUPS_FILE,
      groups
    );


    res.json({
      ok:true,
      removed:
        n!==groups.length
    })
  }
);


app.post(
  "/api/groups/:id/join",
  async(
    req,
    res
  )=>{
    try{
      const g=
        groups.find(
          x=>
            x.id===
            req.params.id
        );


      if(!g){
        return res
          .status(404)
          .json({
            error:
              "Grupo não encontrado"
          })
      }


      if(
        !sock||
        connectionState!=="connected"
      ){
        return res
          .status(409)
          .json({
            error:
              "WhatsApp não está conectado"
          })
      }


      if(!g.inviteLink){
        return res
          .status(400)
          .json({
            error:
              "Este grupo não possui link de convite"
          })
      }


      const code=
        inviteCode(
          g.inviteLink
        );


      if(!code){
        return res
          .status(400)
          .json({
            error:
              "Link de convite inválido"
          })
      }


      const jid=
        await sock.groupAcceptInvite(
          code
        );


      if(jid){
        g.jid=
          jid
      }


      saveJson(
        GROUPS_FILE,
        groups
      );


      res.json({
        ok:true,
        message:
          "Grupo conectado.",
        group:g
      })
    }catch(e){
      res
        .status(400)
        .json({
          error:
            e.message
        })
    }
  }
);


// ======================================================
// AGENDAMENTOS
// ======================================================

app.get(
  "/api/jobs",
  (_q,res)=>
    res.json({
      ok:true,
      jobs
    })
);


app.post(
  "/api/jobs",
  (req,res)=>{
    const{
      groupId,
      message,
      scheduledAt,
      repeat="unica",
      imageUrl=null,
      product=null
    }=
      req.body||{};


    if(
      !groupId||
      !message||
      !scheduledAt
    ){
      return res
        .status(400)
        .json({
          error:
            "groupId, message e scheduledAt são obrigatórios"
        })
    }


    if(
      ![
        "unica",
        "diaria",
        "semanal"
      ].includes(
        repeat
      )
    ){
      return res
        .status(400)
        .json({
          error:
            "Repetição inválida. Use unica, diaria ou semanal."
        })
    }


    if(
      !groups.find(
        g=>
          g.id===
          groupId
      )
    ){
      return res
        .status(404)
        .json({
          error:
            "Grupo não encontrado"
        })
    }


    const job={
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
      ok:true,
      job
    })
  }
);


// ======================================================
// ENVIO
// ======================================================

async function sendJob(
  job
){
  const g=
    groups.find(
      x=>
        x.id===
        job.groupId
    );


  if(!g?.jid){
    throw new Error(
      "Grupo sem JID"
    )
  }


  if(
    !sock||
    connectionState!=="connected"
  ){
    throw new Error(
      "WhatsApp não conectado"
    )
  }


  if(job.imageUrl){
    await sock.sendMessage(
      g.jid,
      {
        image:{
          url:
            job.imageUrl
        },

        caption:
          job.message
      }
    )
  }else{
    await sock.sendMessage(
      g.jid,
      {
        text:
          job.message
      }
    )
  }


  job.sentAt=
    new Date().toISOString();


  if(
    job.repeat==="diaria"||
    job.repeat==="semanal"
  ){
    const d=
      new Date(
        job.scheduledAt
      );


    d.setDate(
      d.getDate()+
      (
        job.repeat==="diaria"
          ?1
          :7
      )
    );


    job.scheduledAt=
      d.toISOString();

    job.status=
      "pending";

    job.lastStatus=
      "sent"
  }else{
    job.status=
      "sent"
  }
}


app.post(
  "/api/jobs/:id/send",
  async(
    req,
    res
  )=>{
    const j=
      jobs.find(
        x=>
          x.id===
          req.params.id
      );


    if(!j){
      return res
        .status(404)
        .json({
          error:
            "Agendamento não encontrado"
        })
    }


    try{
      await sendJob(
        j
      );


      saveJson(
        JOBS_FILE,
        jobs
      );


      res.json({
        ok:true,
        job:j
      })
    }catch(e){
      j.status=
        "error";

      j.error=
        e.message;


      saveJson(
        JOBS_FILE,
        jobs
      );


      res
        .status(400)
        .json({
          error:
            e.message,
          job:j
        })
    }
  }
);


app.delete(
  "/api/jobs/:id",
  (req,res)=>{
    const n=
      jobs.length;


    jobs=
      jobs.filter(
        x=>
          x.id!==
          req.params.id
      );


    saveJson(
      JOBS_FILE,
      jobs
    );


    res.json({
      ok:true,
      removed:
        n!==jobs.length
    })
  }
);


// ======================================================
// CRON
// ======================================================

async function processJobs(){
  if(
    !sock||
    connectionState!=="connected"
  ){
    return
  }


  const now=
    Date.now();


  for(
    const j of
    jobs
  ){
    if(
      j.status!=="pending"
    ){
      continue
    }


    const t=
      new Date(
        j.scheduledAt
      ).getTime();


    if(
      !Number.isFinite(t)||
      t>now
    ){
      continue
    }


    try{
      await sendJob(
        j
      )
    }catch(e){
      j.status=
        "error";

      j.error=
        e.message
    }
  }


  saveJson(
    JOBS_FILE,
    jobs
  )
}


cron.schedule(
  "* * * * *",
  ()=>{
    processJobs()
      .catch(
        e=>
          console.error(
            "Scheduler:",
            e.message
          )
      )
  },
  {
    timezone:
      TZ
  }
);


// ======================================================
// SERVIDOR
// ======================================================

app.listen(
  PORT,
  "0.0.0.0",
  ()=>{
    console.log(
      `OfertaZap API rodando na porta ${PORT}`
    );

    console.log(
      `Timezone: ${TZ}`
    )
  }
);
