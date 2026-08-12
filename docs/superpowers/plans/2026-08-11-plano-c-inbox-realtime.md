# Aios Pocket — Plano C: Inbox Realtime (Fatia 1 completa, parte 3 de 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** O critério da Fatia 1 completo COM interface: mensagem real aparece no inbox **em tempo real**, resposta enviada pela UI chega no celular, Timeline registra — com o banco vivo migrado para o Supabase Postgres (arquitetura definitiva) e o `apps/web` deployado na Vercel.

**Architecture:** O banco vivo muda do droplet para o **Supabase Postgres** (spec §2 — é o que habilita o Realtime). `apps/web` (Next.js App Router + Tailwind + shadcn/ui) faz login via Supabase Auth, **lê dados pelos endpoints da API** (tenant-safe) e recebe **novidades via Supabase Realtime** com políticas RLS read-only APENAS em `messages`/`conversations` (exceção única do ADR-0001/0005). Envio continua exclusivamente pela API. Spec: `docs/superpowers/specs/2026-08-08-fatia-0-design.md` §7; carry-over: `docs/superpowers/2026-08-08-plano-a-carryover.md` (seção "Plano C intake").

**Tech Stack:** o do repo + Next.js (App Router, create-next-app mais recente), @supabase/supabase-js + @supabase/ssr, Vercel CLI.

**Fatos de ambiente:**
- Banco vivo ATUAL: `aios-pocket` no postgres-dev do droplet (143.198.98.6:5433). Pós-cutover: Supabase Postgres (`SUPABASE_DATABASE_URL` — **checkpoint: usuário fornece a senha**); o droplet mantém `aios-pocket-test` (testes) e `evolution` (Evolution dev) — os guards de teste continuam válidos sem mudança.
- Supabase projeto: `https://tnfjvsouraqjtbxxpusd.supabase.co` (keys no `.env`). JWT assimétrico JÁ validado com token real (E2E do Plano B) — baixa no carry-over.
- API viva: `https://aios-pocket-api.yspmhc.easypanel.host` (imagem GHCR com binaryTargets; deploy = clique Implantar; `:latest` pode exigir 2 cliques ou tag por SHA).
- Vercel CLI NÃO instalada; deploy do web é checkpoint com o usuário.

## Global Constraints

- Tudo dos Planos A/B permanece (TS strict, sem `any`, fronteiras de lint, comentários/commits PT, identificadores EN, segredos só no `.env`, testes antes de cada commit, guards de teste intocáveis).
- **PRODUÇÃO INTOCÁVEL** (projeto `aios` do EasyPanel, instância `murilo`, n8n). O cutover mexe só no serviço `api` e no banco do PILOTO.
- `service_role` key JAMAIS no frontend; browser só usa `NEXT_PUBLIC_SUPABASE_URL` + anon key. RLS read-only SOMENTE em `messages` e `conversations` (qualquer ampliação exige nota de ADR).
- Envio de mensagem SEMPRE pela API (nunca insert direto do browser).
- Operação em lote/destrutiva (o cutover!) = plano apresentado + aprovação explícita do usuário antes de executar (regra do CLAUDE.md §4).
- Env novo → `.env`, `.env.example` e `tasks.test.env` do turbo.json quando teste consumir.
- Branch `plano-c-inbox-realtime` a partir de `master`.

---

### Task 1: Hardening batch C (carry-over intake)

**Files:**
- Modify: `apps/api/src/queue/webhook-worker.ts`, `apps/api/src/queue/send-worker.ts`, `apps/api/src/queue/workers.ts`, `apps/api/src/pipeline/process-webhook.ts`
- Create: migração `*_customer_events_dedupe_idx`
- Test: casos novos em suites existentes

**Interfaces:** consome o código do Plano B; produz os mesmos exports.

- [ ] **Step 1: `worker.on('error')` nos 3 workers** — webhook, send e domain-events: `worker.on('error', (err) => console.error('[<nome>] erro do worker bullmq', err.message))` (comentário: evento 'error' ≠ 'failed'; sem handler, um erro de infra derruba o processo único).
- [ ] **Step 2: `excludeInFlight` bounded** — trocar `getJobs(['active','waiting','delayed'])` por `getJobState(id)` por linha candidata (≤ 500 chamadas por batch; comentário citando a review do Plano B).
- [ ] **Step 3: TOCTOU do timeline condicional** — migração com índice único parcial em `customer_events`: `CREATE UNIQUE INDEX customer_events_dedupe_idx ON customer_events (company_id, customer_id, type, correlation_id) WHERE type IN ('message_received','message_sent','message_sent_from_phone')` + no `process-webhook.ts`/`send-message.ts`, tratar P2002 desse insert como no-op (padrão prisma-errors). Nota: transições de status ficam FORA do índice (mesmo correlationId legitimamente repete com types/estados distintos — validar no teste).
- [ ] **Step 4: Evento `fromMe` ganha nome próprio** — em `process-webhook.ts`, mensagens `fromMe` publicam `MessageSentFromPhone` (payload igual); `MessageReceived` volta a significar só cliente→empresa. Comentário + atualização dos testes que asseguravam o nome antigo.
- [ ] **Step 5: Gate** — `pnpm --filter @aios-pocket/api test`, typechecks, lint, test:arch (infra de teste isolada — segura). Commit: `chore: hardening batch C — worker errors, exclusao bounded, dedupe unico de timeline e evento fromMe nomeado`.

---

### Task 2: Supabase pronto para ser o banco vivo (CHECKPOINT: senha do banco)

**Files:**
- Modify: `.env`, `.env.example` (SUPABASE_DATABASE_URL)
- Create: migração `*_rls_realtime` (SQL das políticas)

**Interfaces:** produz o Supabase com schema aplicado, RLS read-only em `messages`/`conversations`, e as duas tabelas na publication do Realtime.

- [ ] **Step 1 (usuário): senha do banco** — painel Supabase → Settings → Database → connection string (pooler para runtime; direta para migrações). Gravar `SUPABASE_DATABASE_URL` (direta, porta 5432) no `.env`.
- [ ] **Step 2: schema no Supabase** — `DATABASE_URL=<supabase-direta> pnpm --filter @aios-pocket/db exec prisma migrate deploy` (aplica TODAS as migrações num banco vazio). Verificar com `prisma migrate status`.
- [ ] **Step 3: migração RLS + Realtime** (nova migração SQL, aplicada em TODOS os ambientes — no droplet-test é inofensiva):
```sql
-- Exceção única do ADR-0001/0005: RLS read-only nas tabelas assinadas pelo Realtime.
ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "conversations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "realtime_read_messages" ON "messages" FOR SELECT TO authenticated
  USING (company_id IN (SELECT company_id FROM users WHERE auth_user_id = auth.uid()));
CREATE POLICY "realtime_read_conversations" ON "conversations" FOR SELECT TO authenticated
  USING (company_id IN (SELECT company_id FROM users WHERE auth_user_id = auth.uid()));
```
Nota: a API usa o usuário `postgres` (bypassa RLS — dono da tabela); o browser autenticado só LÊ. `auth.uid()` não existe no Postgres do droplet → guardar a migração com `DO $$ ... IF EXISTS (schema auth) ...` para não quebrar test/CI (documentar). Publication: `ALTER PUBLICATION supabase_realtime ADD TABLE messages, conversations;` (mesma guarda).
- [ ] **Step 4: prova do Realtime** — script curto com anon key + login do piloto: subscribe `postgres_changes` em `messages`; inserir uma linha de teste via API… (banco ainda vazio — inserir via SQL direto e apagar); evento deve chegar. Registrar evidência no report.
- [ ] **Step 5: Commit** — `feat(db): RLS read-only e publication do realtime para messages/conversations (ADR-0005)`.

---

### Task 3: CUTOVER do banco vivo para o Supabase (CHECKPOINT: aprovação explícita + cliques)

**Files:**
- Create: `scripts/copy-live-db.ts` (cópia tabela a tabela, duas conexões)

**Interfaces:** pós-task, o banco vivo É o Supabase; droplet fica só com test/evolution.

- [ ] **Step 1: APRESENTAR O PLANO DE CUTOVER AO USUÁRIO E AGUARDAR OK** (operação em lote — regra §4): sequência, janela de indisponibilidade (~2-5 min), rollback (reapontar DATABASE_URL de volta).
- [ ] **Step 2: script de cópia** — `scripts/copy-live-db.ts`: duas instâncias PrismaClient (origem = LIVE_DATABASE_URL atual/droplet; destino = SUPABASE_DATABASE_URL), copia em ordem FK (companies → users → customers → conversations → messages → customer_events → raw_webhook_events) com `createMany` em lotes de 500 e contagens origem/destino ao final. Idempotente via `skipDuplicates`.
- [ ] **Step 3: executar o cutover** — (a) desabilitar webhook da instância dev (`/webhook/set` enabled=false — congela entrada; Evolution segue conectada); (b) rodar a cópia; conferir contagens; (c) USUÁRIO troca `DATABASE_URL` do serviço `api` no EasyPanel para a connection do Supabase (POOLER, porta 6543, `?pgbouncer=true` — runtime) e Implantar; (d) probe 404 + `/health`; (e) reabilitar webhook; (f) mensagem real de teste ponta-a-ponta.
- [ ] **Step 4: pós-cutover** — `.env`: `LIVE_DATABASE_URL` → Supabase (direta); `DATABASE_URL` continua no test do droplet. Seed roda contra o novo vivo (validar). Commit do script + nota em `docs/superpowers/notes/`.

---

### Task 4: Contracts de leitura + idempotência de envio

**Files:**
- Modify: `packages/contracts/src/api.ts`, `packages/contracts/src/index.ts`, `packages/db/prisma/schema.prisma` (+migração), `apps/api/src/routes/messages.ts`
- Test: `packages/contracts/test/api.test.ts` (casos novos), `apps/api/test/send-flow.test.ts` (idempotência)

**Interfaces (consumidos por T5-T8):**
- `sendMessageRequestSchema` ganha `clientMessageId: z.uuid()` (OBRIGATÓRIO — a UI sempre gera; é a chave de idempotência do envio e o rastreio estável 202↔linha, fechando o "202 dangling" da review do Plano B).
- `conversationSummarySchema` = { id, provider, status, lastMessageAt, customer: { id, phoneE164, name } }; `messageViewSchema` = { id, direction, state, type, text, mediaUrl, mediaMimeType, fromMe, providerMessageId, createdAt } — respostas de GET tipadas e compartilhadas.
- Message ganha coluna `client_message_id String? @map("client_message_id")` + `@@unique([companyId, clientMessageId])` (migração aditiva).
- POST /messages: request duplicado (mesmo clientMessageId) NÃO cria segunda linha — retorna 202 com o messageId original (P2002 → readback, padrão prisma-errors).

- [ ] **Steps:** TDD — testes de schema/idempotência primeiro → migração → implementação → gate → commit `feat: idempotencia de envio por clientMessageId e contracts de leitura do inbox`.

---

### Task 5: Endpoints de leitura da API

**Files:**
- Create: `apps/api/src/routes/conversations.ts`, `apps/api/src/routes/me-status.ts`
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/test/read-endpoints.test.ts`

**Interfaces (consumidos pela UI em T6-T8):**
- `GET /conversations?limit=50` (auth) → lista por `lastMessageAt desc` com customer embutido (validada por `conversationSummarySchema`).
- `GET /conversations/:id/messages?limit=100` (auth) → mensagens `createdAt asc` (tenant-filtered; 404 de outro tenant).
- `GET /me/status` (auth) → `{ companyId, connectionState }` (badge da instância — consumer visível do estado de conexão; poll de 30s na UI v1; nota: evento `ConnectionChanged` segue publicado para uso futuro).
- Repositories novos em `packages/db` (conversationsRepo.listWithCustomer, messagesRepo.listByConversation — tenant client, findMany permitido).

- [ ] **Steps:** TDD (fixtures próprias via testing, cleanup guardado) → implementação → gate → commit `feat(api): endpoints de leitura do inbox (conversas, mensagens, status)`.

---

### Task 6: `apps/web` — scaffold + login Supabase

**Files:**
- Create: `apps/web/*` (create-next-app: App Router, TS, Tailwind; shadcn/ui init; @supabase/supabase-js + @supabase/ssr)
- Modify: `turbo.json` (build/typecheck/lint do web), `.github/workflows/ci.yml` (web no gate), `.env.example`

**Interfaces:** produz o app com login (email/senha do piloto) e sessão Supabase disponível client-side (o `access_token` da sessão é o Bearer para a API); env `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_API_URL`.

- [ ] **Steps:** scaffold (create-next-app@latest, sem src-dir? seguir default atual; PT nos textos) → página de login (shadcn Card/Input/Button; signInWithPassword; redirect /inbox; erro visível) → guarda de rota (middleware @supabase/ssr; sem sessão → /login) → `pnpm --filter web typecheck/lint/build` verdes + CI atualizado → commit `feat(web): scaffold next.js com login supabase (piloto)`.
- Nota: nenhum secret além das public keys; `service_role`/`SUPABASE_SECRET` PROIBIDOS aqui (lint do repo não cobre — revisar manualmente no review da task).

---

### Task 7: Inbox UI (conversas + conversa + envio + badge)

**Files:**
- Create: `apps/web/app/(app)/inbox/*` (page, componentes ConversationList, ConversationView, Composer, InstanceBadge), `apps/web/lib/api.ts` (client tipado com os schemas de contracts)

**Interfaces:** consome T5 (+T4 clientMessageId com `crypto.randomUUID()` por envio). UI mínima do spec §7: lista (nome/telefone, última msg, hora), conversa (bolhas com estado ✓/✓✓/lido, indicador `fromMe` "você — celular" vs "você — Aios Pocket", mídia como anexo simples com tipo+link), composer (envia, limpa, estado otimista `queued`), badge do `/me/status` (poll 30s; `disconnected` = banner vermelho "instância desconectada" — alerta visível do pior modo de falha).

- [ ] **Steps:** componentes com dados dos endpoints → estados de carregamento/erro honestos → `pnpm --filter web typecheck/lint/build` + revisão visual manual guiada (dev server local logado como piloto, dados reais) → commit `feat(web): inbox — conversas, conversa, envio e badge de conexao`.

---

### Task 8: Realtime de verdade

**Files:**
- Create: `apps/web/lib/realtime.ts`; Modify: componentes do inbox

**Interfaces:** browser assina `postgres_changes` (INSERT/UPDATE em `messages` e `conversations`, RLS filtra por company) → mensagens novas aparecem SEM refresh; acks atualizam os ✓; conversa nova entra na lista. Reconexão do channel tratada (resubscribe + refetch de segurança).

- [ ] **Steps:** client realtime → integração nos componentes (dedupe por id contra o estado local; refetch on resubscribe) → prova manual: mensagem real no WhatsApp → aparece na tela em <2s (registrar evidência) → commit `feat(web): inbox em tempo real via supabase realtime (ADR-0005)`.

---

### Task 9: Deploy do web na Vercel (CHECKPOINT: fluxo Vercel com o usuário)

- [ ] **Step 1:** instalar Vercel CLI (`npm i -g vercel`); `vercel login` é INTERATIVO → usuário roda `! vercel login` (ou navegador).
- [ ] **Step 2:** `vercel link` no monorepo (root apps/web; framework Next; buildCommand herdando turbo) + envs de produção (`vercel env add`: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, NEXT_PUBLIC_API_URL).
- [ ] **Step 3:** CORS na API: `@fastify/cors` com origin = domínio do Vercel + localhost:3000 (nova env `WEB_ORIGIN`; EasyPanel env update + Implantar — checkpoint).
- [ ] **Step 4:** `vercel deploy --prod`; login do piloto no domínio público; inbox carregando dados reais. Commit de configs + nota.

---

### Task 10: E2E do critério da Fatia 1 — COMPLETO, com UI (CHECKPOINT final)

- [ ] Roteiro com o usuário no domínio público: (1) mensagem real → aparece no inbox EM TEMPO REAL; (2) resposta pela UI → chega no celular do cliente; acks atualizam ✓ na tela; (3) resposta do celular do piloto → aparece como "você — celular"; (4) Timeline conferida no banco; (5) badge: derrubar/religar a instância dev → banner aparece/some. Evidência em `docs/superpowers/notes/2026-XX-XX-e2e-fatia-1.md` (data real).
- [ ] Baixas no carry-over (intake C resolvido; JWKS já baixado; itens novos → Plano D) + notas de ADR (implementação do ADR-0005; nome `MessageSentFromPhone`; Supabase como banco vivo). Commit final.

---

## Critério de pronto do Plano C

1. **Fatia 1 completa e demonstrada**: mensagem real do piloto aparece no inbox realtime; resposta enviada pela UI chega no celular dele (critério literal do CLAUDE.md §6).
2. Banco vivo no Supabase Postgres com RLS read-only só em messages/conversations; droplet só test/evolution; produção `murilo`/n8n intocada.
3. `apps/web` deployado na Vercel, autenticado, sem nenhum secret não-público.
4. Envio idempotente por `clientMessageId`; badge de conexão visível; hardening batch C aplicado.
5. Gate completo + CI verde (incluindo web) na branch e no merge.

