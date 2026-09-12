OfertaZap SaaS V32
Versão de integração do painel SaaS com o backend multi-cliente.
Correção do erro "Failed to fetch"
O painel não usa mais uma URL relativa quando aberto como arquivo content://. Ele aponta por padrão para: https://ofertazap-api1.onrender.com
Para mudar a API durante testes, no console do navegador: localStorage.ofz_api_base="https://SEU-SERVIDOR.onrender.com" e recarregue.
Backend
O server.js precisa estar implantado no Render antes do cadastro/login funcionarem.
Cadastro
Nome completo, empresa, e-mail, celular/WhatsApp, senha e confirmação. O backend gera código de confirmação; SMTP pode ser configurado pelas variáveis SMTP.
