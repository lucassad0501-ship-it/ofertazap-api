# OfertaZap API — Baileys

Backend do OfertaZap para conectar uma conta do WhatsApp, cadastrar grupos e enviar mensagens agendadas.

## Arquivos na raiz
- package.json
- server.js
- .env.example

## Render
Build Command:
npm install

Start Command:
npm start

Node:
20+

## Teste
GET /api/health

Os demais endpoints usam:
Authorization: Bearer SEU_TOKEN

## Importante
Baileys é uma integração não oficial com o WhatsApp Web. Use somente em contas e grupos que você administra ou para os quais tenha autorização. Evite spam e automação abusiva.

Para produção, a pasta de autenticação precisa de armazenamento persistente; sem isso, um reinício pode exigir novo pareamento.
