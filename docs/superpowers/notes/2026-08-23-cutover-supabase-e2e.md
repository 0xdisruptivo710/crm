# Cutover do banco vivo para o Supabase — evidências do E2E (T3 do Plano C)

Fecha a Task 3 do Plano C (`docs/superpowers/plans/2026-08-11-plano-c-inbox-realtime.md`). O cutover em si foi executado em 2026-08-16/17; o E2E final (step 3f) ficou pendente porque a instância Evolution dev estava deslogada (401 de 2026-08-11) — resolvido hoje.

## Cronologia

- **2026-08-16/17 — cópia e troca**: `scripts/copy-live-db.ts` copiou droplet → Supabase com contagens idênticas nas duas pontas (3 companies / 1 user / 29 customers / 25 conversations / 470 messages / 967 customer_events / 1917 raw_webhook_events). Usuário trocou `DATABASE_URL` do serviço `api` no EasyPanel para o pooler Supabase (6543, `pgbouncer=true`) e reimplantou. Provado em 2026-08-17 que a API viva lê do Supabase (GET /me autenticado → atividade no `pg_stat_activity` via Supavisor).
- **2026-08-23 — reconexão da instância**: QR novo gerado via `/instance/connect`, escaneado pelo piloto; `connectionState` foi `close → connecting → open` às 17:49:39 (BRT). Os `CONNECTION_UPDATE` da reconexão entraram pelo pipeline e viraram raws no Supabase (1917 → 1923) — primeira prova de ESCRITA da API viva no banco novo.
- **2026-08-23 ~18:53 (BRT) — E2E step 3f**: mensagem real de WhatsApp de outro número para o número do piloto.

## Evidência do E2E (leitura direta do Supabase vivo, probe read-only)

Delta pós-mensagem (baseline → depois): messages 470 → **471**; customer_events 967 → **968**; raw_webhook_events 1923 → **1924**; customers/conversations inalterados (29/25 — cliente existente resolvido, sem duplicata).

Cadeia completa da mensagem:

- **Message** `3633206a-171a-41ed-a73e-8af105e1e1e0`: `direction=inbound`, `state=received`, `fromMe=false`, `provider=evolution`, `providerMessageId=3A5CB5111C47B936CD46`, `createdAt=2026-08-23T21:53:22.945Z` (UTC).
- **Customer resolvido** (não criado): `1dc0d91c-d809-4b2c-9050-a36a44c15dc5`, telefone canônico E.164.
- **Conversation resolvida**: `7a59d1da-d8f5-4f20-9b72-b13b8e82b337`, `lastMessageAt` atualizado para o instante da mensagem.
- **TimelineEvent** `message_received` com o MESMO `correlationId` da Message (`3104b52a-b8ee-469e-9639-b95228da3324`) e `schema_version=1` — rastreabilidade webhook → pipeline → timeline ponta a ponta.

## Estado resultante

- **Banco vivo = Supabase.** Droplet (projeto `aios-pocket`) segue só com `aios-pocket-test` (testes) e `evolution` (banco da Evolution dev). Produção da operação (projeto `aios`) intocada.
- `.env`: `LIVE_DATABASE_URL` → Supabase (conexão direta, usada por scripts/probes); `DATABASE_URL` → `aios-pocket-test` do droplet (testes).
- Webhook da instância dev ativo com os 4 eventos (`MESSAGES_UPSERT`, `MESSAGES_UPDATE`, `SEND_MESSAGE`, `CONNECTION_UPDATE`).
- Atenção (já conhecida): a API implantada é o build do `master` (Plano B) — os endpoints de leitura do inbox (T5) e a idempotência por `clientMessageId` (T4) só existem na branch `plano-c-inbox-realtime`; entram no ar no deploy do fim do Plano C.

## Probes utilizados

Scripts read-only descartáveis (fora do repo, scratchpad da sessão), via `createUnsafeClient` de `packages/db/src/unsafe.ts` com `LIVE_DATABASE_URL` — só `count`/`findMany`/`findUnique`, com guard exigindo host supabase e watchdog de 30s. Nenhuma escrita no banco vivo.
