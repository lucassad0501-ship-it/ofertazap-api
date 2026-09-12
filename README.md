OfertaZap V26 — TUDO SINCRONIZADO
Estrutura
server.js: backend principal
package.json: dependências
OfertaZap_Painel_V26.html: painel
.env.example: referência das variáveis
Render correto
Serviço: ofertazap-api1 URL: https://ofertazap-api1.onrender.com Build Command: npm install Start Command: npm start Node: 20+
Persistent Disk
Monte um Persistent Disk em /data. Configure: RENDER_DISK_ROOT=/data DATA_DIR=/data/ofertazap BAILEYS_AUTH_DIR=/data/ofertazap/auth_info_baileys
O backend preserva no disco:
sessão do WhatsApp/Baileys
grupos
agendamentos
produtos
token OAuth/refresh do Mercado Livre
Mercado Livre
ML_REDIRECT_URI: https://ofertazap-api1.onrender.com/api/mercadolivre/callback
Não coloque API_TOKEN ou ML_CLIENT_SECRET no GitHub.
Painel
O painel V26 aponta por padrão para https://ofertazap-api1.onrender.com. O API_TOKEN é salvo localmente no aparelho/navegador e enviado ao backend por Bearer token.
Verificação
Depois do deploy, abra: GET /api/health
Com API_TOKEN, a rota /api/persistence mostra se o backend está usando /data, quantos arquivos de sessão WhatsApp existem e se o refresh token do Mercado Livre foi salvo.
Importante
Recarregar o HTML não encerra WhatsApp nem refaz OAuth. Reinício/deploy do Render só preserva as sessões se o Persistent Disk estiver montado e as variáveis acima estiverem configuradas.
