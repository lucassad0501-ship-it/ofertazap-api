OfertaZap V38 — PostgreSQL persistente
A V38 mantém a estrutura atual do SaaS e grava um snapshot dos dados no PostgreSQL quando DATABASE_URL está configurada.
Dados persistidos: contas, produtos, agenda, grupos, templates, assinaturas e logs.
Render:
Crie um Render Postgres.
No serviço ofertazap-api1, adicione DATABASE_URL com a Internal Database URL do Postgres (mesma região).
Adicione DATABASE_SSL=true.
Faça deploy.
Nos logs deve aparecer POSTGRES=connected e, na primeira execução, PostgreSQL inicializado ou PostgreSQL carregado.
Não coloque senhas ou URLs do banco no GitHub.
