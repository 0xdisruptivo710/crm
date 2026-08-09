# Plano A — Carry-over triado pela revisão final (2026-08-08)

Itens levantados nas revisões do Plano A e triados pela revisão final da branch. Cada plano seguinte DEVE consumir sua lista ao ser escrito.

## Plano B (pipeline Evolution) — obrigatórios

- **Pré-requisito de deploy:** listeners de `error` nas duas conexões IORedis (`apps/api/src/queue/connection.ts`) — sem eles, um blip do Redis derruba o processo.
- Pool Prisma único: `createTenantClient(prismaUnsafe)` em vez de dois `PrismaClient` (droplet compartilhado, conexões dobradas).
- CI: `prisma migrate diff --from-migrations --to-schema-datamodel --exit-code` — detecta schema editado sem migração (hoje só se valida que migrações aplicam).
- Crypto: validação de tamanho da chave (32 bytes) com erro claro + teste de chave malformada — decrypt vira hot path quando providers lerem credenciais.
- Timeout explícito no `createRemoteJWKSet` (jose) — indisponibilidade do Supabase não pode significar espera default.
- Zod: trocar `z.string().uuid()` deprecated por `z.uuid()` (contracts) e considerar `z.url()` em config.
- Fila: teste do caminho handler-lança → job `failed` (garantia estilo DLQ) + `removeOnComplete` com `count` cap; config de retry/backoff do worker de envio (spec §6).
- Testes negativos de contracts (`media.correlationKey`, `replyToProviderMessageId`, `isEdit`) via suíte de fixtures reais.
- Repositório de company pré-tenant sancionado em `packages/db` (webhook resolve company por token de instância; hoje `Company` não é isento nem legível pelo client tenantizado — falha fechado com erro confuso).
- `enterTenant` ficou sem callers de produção após o fix do hook — considerar remover do export público (é exatamente o footgun que causou o Critical da revisão final).
- Turbo cacheia `test` contra estado externo (DB/Redis remotos) — um PASS cacheado pode mentir; considerar `"cache": false` para packages de integração.
- Decidir build de produção da API para o EasyPanel (tsx em prod vs build step) — hoje tudo é `noEmit`.
- Comentário do teste happy-path superdeclara cobertura ("através dos awaits internos" — `/me` não tem awaits internos); cobrir handler-com-await-antes-de-getTenant quando existir um real.
- `.catch` terminal no hook de auth: throw dentro dele (ex.: serialização de log) vira unhandled rejection → exit. Efetivamente inalcançável hoje; endurecer quando o hook crescer.

## Plano C (inbox realtime)

- Teste ponta-a-ponta com JWT real do Supabase (caminho JWKS de assinatura — único gap de auth aceito).
- Verificar antes: projeto Supabase usa chaves assimétricas de assinatura JWT (se for HS256 legado, todo token real dá 401 — `verify.ts` assume JWKS).
- Pendências de credencial: `SUPABASE_DATABASE_URL` (senha do banco) para migrar o Supabase real; Vercel CLI/projeto.

## Plano D (docs/ADRs)

- ADR-0001: documentar juntos os limites compostos da tenancy — validação FK cross-tenant ausente, nested writes/`connect` não interceptados, `Company` não-exempt (ilegível pelo client tenantizado por design).
- Database.md: registrar exceção de convenção — types de enum Postgres em PascalCase (renomear exigiria migração sem ganho funcional).
- Polimentos de type deferidos: `Resolved<T>` no `runWithTenant`, `Omit` das operações proibidas no tipo do client, typing do `isThenable`.

## Regra de processo adotada (vale para todos os planos)

Toda costura entre tasks (auth→tenant, rota→fila, webhook→pipeline) ganha pelo menos **um teste happy-path mockado no mesmo plano** — o Critical do Plano A (contexto ALS não propagava; só branches de erro testados) ficou invisível a todas as revisões por task exatamente por falta disso.

## Segurança operacional (registro)

- Produção do usuário (projeto `aios` no EasyPanel: Evolution + n8n) roda no MESMO droplet da infra de dev — intocável; nunca buildar imagens no droplet (CI builda, EasyPanel puxa).
- Rotacionar credenciais da stack `dinastia` que circularam em conversa (Postgres, Redis, chave n8n, API key Evolution).
- Testes que fazem wipe têm `assertSafeToWipe` (recusa hosts supabase.co e db fora de aios-pocket/aios_pocket); wipe do tenancy.test destrói o seed do piloto a cada run — re-rodar `db:seed` quando necessário.
