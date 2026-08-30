# Arquitetura — Aios Pocket

## Stack — INEGOCIÁVEL

| Camada | Tecnologia | Deploy |
|---|---|---|
| Frontend | Next.js (App Router) + TypeScript + Tailwind + shadcn/ui | Vercel (projeto `aios-pocket`, root `apps/web`) |
| Backend | Fastify + BullMQ + Prisma — **um único deployable** (API + workers no mesmo processo) | EasyPanel (imagem GHCR `crm-api`) |
| Banco | Supabase Postgres (+ Auth, Realtime) | Supabase |
| Fila | BullMQ + Redis | EasyPanel (`redis-dev`) |
| Monorepo | pnpm workspaces + Turborepo | — |

**Proibido**: microsserviços, NestJS, servidor WebSocket próprio (v1 — ADR-0005), segundo deployable de backend. Provider novo, entidade nova ou dependência estrutural nova exigem ADR antes do código.

## Estrutura do monorepo

```
apps/web            → Next.js (inbox; login Supabase; realtime client)
apps/api            → Fastify (rotas + hook de auth/tenant) + workers BullMQ (1 processo)
  src/routes/       → webhooks, messages, conversations, me-status (validação Zod; SEM regra de negócio)
  src/pipeline/     → process-webhook, apply-status, resolve-customer, send-message (use cases)
  src/queue/        → conexões Redis, filas, workers (webhook-processing, message-send, domain-events)
packages/contracts  → schemas Zod compartilhados (tipos de API, eventos, webhooks normalizados)
packages/db         → schema Prisma + client extension de tenancy + repositories + E.164/crypto
packages/providers  → EvolutionProvider (hoje), UazapiProvider (Fatia 4), ZernioProvider (Fatia 9) + normalização
docs/               → este diretório; docs/adr/ = uma decisão por arquivo
tests/providers/fixtures/{evolution,uazapi}/ → payloads reais de webhook sanitizados
```

## Fluxo inbound (mensagem chegando)

1. **Webhook** por provider (`/webhooks/evolution/...`, autorizado por token de instância da Company) recebe o payload cru.
2. O raw é **arquivado** (`raw_webhook_events`) e vira candidato a fixture; a rota responde rápido e enfileira (`webhook-processing`).
3. O worker converte para os **tipos internos normalizados** (ADR-0003): `IncomingMessage` | `MessageStatusUpdate` | `ConnectionStatusChange`.
4. O **pipeline idempotente** resolve/cria `Customer` (E.164 + 9º dígito), resolve/cria `Conversation`, insere `Message` (com guarda de eco para `fromMe`), aplica acks na máquina de estados (ADR-0006) e registra `TimelineEvent` (ADR-0004) — tudo com o mesmo `correlation_id`.
5. O Supabase **Realtime** propaga INSERT/UPDATE de `messages`/`conversations` ao browser (ADR-0005).

Idempotência de webhook: dedupe por `provider + providerMessageId + tipo de evento`; reprocessar um raw nunca duplica nada.

## Fluxo outbound (resposta pela UI)

1. `POST /messages` (JWT Supabase verificado via JWKS; TenantContext do usuário) valida com Zod, cria a `Message` em `queued` com `clientMessageId` (idempotência de envio — retry/duplo clique nunca duplica) e responde **202 imediatamente** — rota HTTP nunca espera provider.
2. O worker `message-send` percorre a máquina de estados (`queued → sending → sent`), chama o provider e é **stall-safe**: reentrada em `sending` lança `UnrecoverableError` (nunca reenvia); varredura de reconciliação marca `failed` com motivo visível o que ficar preso; falha nunca é silenciosa (`failReason` + timeline).
3. Acks do provider (`delivered`/`read`) voltam como webhooks e alimentam a mesma máquina de estados; a UI atualiza os ✓ via realtime.

## Comunicação entre módulos (ADR-0004)

- **Dentro do domínio**: chamada direta (método/use case).
- **Entre domínios**: evento — publicado **depois do commit**, consumers idempotentes, `correlation_id` em tudo.
- Filas com retry/backoff/DLQ explícitos (`attempts: 3`, exponencial); workers com handlers de `error` e `failed`.

## Realtime (ADR-0005)

Browser assina `postgres_changes` de `messages`/`conversations`; RLS read-only + publication **só nessas tabelas** filtram por company no Postgres (o Realtime não conhece TenantContext). No cliente, o evento é **sinal, não fonte de dados**: dispara refetch debounced dos DTOs validados da API; todo `SUBSCRIBED` faz refetch de segurança. Fast-path (mapear INSERT direto na conversa aberta) é evolução registrada no carry-over.

## Deploy e CI

- **CI (GitHub Actions)**: typecheck + lint + testes + validação/drift de migrations em todo push/PR. Não passa, não mergeia.
- **API**: push na `master` builda a imagem `ghcr.io/0xdisruptivo710/crm-api` (`latest` + sha); o EasyPanel **só puxa** — **NUNCA buildar no droplet**.
- **Web**: `vercel deploy --prod` (projeto linkado com `rootDirectory=apps/web`, `framework=nextjs` — setados via API; o CLI 58 rejeita rootDirectory no vercel.json).
- **Runbook de schema**: mudança de schema mergeada → rodar manualmente `DATABASE_URL=<vivo> prisma migrate deploy` ANTES do redeploy (a imagem não migra sozinha).

## Mapa de infra (2026-08)

- **Vercel**: `aios-pocket.vercel.app` (web).
- **Supabase**: banco VIVO (Postgres + Auth + Realtime). Conexão da API via pooler (6543, pgbouncer).
- **Droplet 143.198.98.6 (EasyPanel)** — projeto `aios-pocket`: serviço `api`, `evolution-dev` (instância `aios-pocket` do piloto), `redis-dev` (:6380; db 0 = vivo, 1 = testes), `postgres-dev` (:5433; dbs `aios-pocket-test` = testes/CI, `evolution`).
- ⚠️ **REGRA DURA**: o projeto `aios` no MESMO droplet é a produção da operação (Evolution + n8n + postgres + redis) — **intocável**. Nunca sugerir restart de host/"Update Docker"; operações perto dessa infra pedem modo cuidadoso e checkpoint com o usuário.
