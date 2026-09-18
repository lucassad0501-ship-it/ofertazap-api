OfertaZap V34 — Produtos + Automação
Teste sem PostgreSQL.
Fluxo: salvar produto → sincronizar Mercado Livre → agenda → WhatsApp automático.
Variáveis Render: DATA_DIR=/data/ofertazap e BAILEYS_AUTH_ROOT=/data/ofertazap/clientes.
Novas rotas: POST /api/products/:id/sync; POST /api/products/sync-all; POST /api/products/:id/send-now; GET /api/automation/status; POST /api/jobs/:id/sync-and-send.
