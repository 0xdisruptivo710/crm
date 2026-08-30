# Banco de dados — Aios Pocket

Schema Prisma em `packages/db/prisma/schema.prisma`; migrations em `prisma/migrations/` (aditivas — **nunca editar migration já aplicada**).

## Tabelas (Fatia 1)

| Tabela | Papel | Uniques/índices com regra de negócio |
|---|---|---|
| `companies` | tenant; hoje carrega `active_provider`, `provider_credentials` (cifradas), `webhook_token` (unique — autoriza o webhook), `connection_state` | — |
| `users` | membro da company; ponte com Supabase Auth via `auth_user_id` (unique) | — |
| `customers` | identidade canônica da pessoa | `(company_id, phone_e164)` — um cliente por telefone por tenant |
| `conversations` | fio por provider | `(company_id, provider, external_id)` |
| `messages` | tabela única com máquina de estados | `(company_id, provider, provider_message_id, direction)` — dedupe de webhook/eco; `(company_id, client_message_id)` — idempotência de envio (NULLs não colidem: inbound nunca preenche); índice `(conversation_id, created_at)` — leitura da conversa |
| `customer_events` | timeline append-only | índice único de dedupe de idempotência; índice `(company_id, customer_id, occurred_at)` — query da timeline |
| `raw_webhook_events` | arquivo de payload cru (fonte de fixtures); `company_id` NULLABLE (arquiva mesmo sem tenant identificado) | `(provider, processed)` e `(processed, received_at)` — reconciliação de raws-veneno sem full scan |

Enums Postgres: `Provider` (evolution, zapi — **migra para `uazapi` na Fatia 4**, ADR-0008; nenhuma linha usa `zapi`), `ConnectionState`, `ConversationStatus`, `MessageDirection`, `MessageState`, `MessageType`.

## Tenancy (ADR-0001) — enforcement e limites

- Toda tabela de negócio tem `company_id`. Exceção documentada: `raw_webhook_events.company_id` nullable (arquivo).
- **Enforcement na aplicação**: Prisma client extension injeta `company_id` obrigatório via `TenantContext` (AsyncLocalStorage; `runWithTenant`); todo acesso a dados passa por repositories (`packages/db/src/repositories/`). Testes de arquitetura no CI falham se um model nascer sem `company_id` (whitelist explícita) ou se um repository ignorar o TenantContext.
- **Limites compostos ACEITOS e documentados** (carry-over Plano A): (a) sem validação de FK cross-tenant — uma FK apontando para linha de outro tenant não é interceptada; (b) nested writes/`connect` do Prisma não passam pela extension; (c) `Company` é ilegível pelo client tenantizado **por design** (é a raiz do tenant, sem `company_id`) — acesso pré-tenant só pelo repositório sancionado `companiesRepo` (`findByWebhookToken`/`findById`), sempre com id vindo do TenantContext ou do token de webhook, nunca de input do cliente.
- Acesso fora da tenancy é RESTRITO a `packages/db/src/unsafe.ts` (`prismaUnsafe` — seed/testes/resolução de auth; `createUnsafeClient(url)` — scripts operacionais com datasource explícito). ESLint proíbe `@prisma/client` fora de `packages/db`.
- Credenciais de provider cifradas na aplicação (`crypto.ts`, AES-256-GCM com `APP_ENCRYPTION_KEY` de 32 bytes) — a `service_role` do Supabase e chaves de provider **jamais** chegam ao frontend.

## RLS — exceção única (ADR-0005)

RLS **não** é o mecanismo de tenancy (a API conecta como dona das tabelas e o ignora). Existe apenas para o Supabase Realtime filtrar o que o browser autenticado recebe:

- Policies **read-only** `realtime_read_messages`/`realtime_read_conversations` (role `authenticated`), via função **SECURITY DEFINER** `company_ids_of_current_user` — dependência estável, imune a mudanças futuras de grants em `users`.
- Publication `supabase_realtime` contém **só** `messages` e `conversations`.
- Data API/PostgREST **fechada**: REVOKE de anon/authenticated em todas as tabelas + default privileges para tabelas futuras; único grant devolvido é SELECT em messages/conversations (necessário para o recheck do Realtime; anon recebe SELECT sem policy — nega por 0 linhas em silêncio, achado empírico da T2).
- Migrations guardadas por existência de `auth`/`authenticated`/publication — no-op no Postgres do droplet/CI, efetivas só no Supabase (mesmo arquivo para os dois ambientes). Ver `20260816204632_rls_realtime` e `20260816211839_lock_data_api_and_security_definer` (o segundo corrige um Critical real: privilégios default do Supabase deixavam 5 tabelas expostas via PostgREST com a anon key).

## Convenções e exceções registradas

- Types de enum Postgres em **PascalCase** — exceção de convenção registrada (renomear exigiria migração sem ganho funcional).
- Colunas snake_case via `@map`; models/campos Prisma em camelCase.
- Mudança de schema pós-merge: `prisma migrate deploy` manual no banco vivo ANTES do redeploy da imagem (Architecture.md §runbook).
- CI valida drift: `prisma migrate diff --from-migrations --to-schema-datamodel --exit-code`.

## Bancos e ambientes

| Banco | Papel |
|---|---|
| Supabase Postgres | **VIVO** (produção) desde o cutover de 2026-08-16/17 (`superpowers/notes/2026-08-23-cutover-supabase-e2e.md`) |
| droplet `postgres-dev` db `aios-pocket-test` | testes locais + CI |
| droplet `postgres-dev` db `evolution` | banco interno da Evolution dev |

Guards de segurança nos testes: `assertSafeToWipe` recusa hosts `supabase.co` e qualquer db fora de `aios-pocket/aios_pocket`; o wipe do tenancy.test destrói o seed — re-rodar `db:seed` quando necessário. Redis: db 0 = vivo, db 1 = testes (isolamento de filas).
