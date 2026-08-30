# ADR-0001 — Multi-tenant por Application Tenancy

**Data:** 2026-08-07 (semente) · **Status:** aceita — implementada na Fatia 0, em produção

## Problema

CRM multi-tenant num único Postgres: todo dado de negócio pertence a uma Company e vazamento entre tenants é falha catastrófica. Onde mora o isolamento — no banco (RLS) ou na aplicação?

## Decisão

1. **Toda tabela de negócio tem `company_id`. Sem exceção não documentada** (única: `raw_webhook_events.company_id` nullable — arquivo de payload pré-identificação).
2. **Enforcement na aplicação**: Prisma client extension injeta `company_id` obrigatório via `TenantContext` (AsyncLocalStorage, `runWithTenant`); todo acesso a dados passa por repositories (`packages/db`).
3. **RLS NÃO é o mecanismo principal.** Exceção única: políticas read-only nas tabelas assinadas pelo Supabase Realtime (ADR-0005).
4. A `service_role` key do Supabase **jamais** chega ao frontend; credenciais de provider cifradas na aplicação (AES-256-GCM).
5. Acesso fora da tenancy restrito a `packages/db/src/unsafe.ts` (seed/testes/auth pré-tenant/scripts operacionais) — ESLint proíbe `@prisma/client` fora do package.

## Consequências

- Isolamento **testável na aplicação**: testes de arquitetura no CI falham se um model nascer sem `company_id` ou um repository ignorar o TenantContext — enforcement vira regressão automatizada, não disciplina de prompt.
- Limites compostos ACEITOS e documentados (Database.md §tenancy): FK cross-tenant não validada; nested writes/`connect` não interceptados; `Company` ilegível pelo client tenantizado por design (repositório pré-tenant sancionado `companiesRepo`, id nunca vindo de input do cliente).
- Lição paga na Fatia 0 (Critical do Plano A): hook async do Fastify não propaga AsyncLocalStorage após `await` — o hook de auth é callback-style com `runWithTenant(ctx, () => done())` (comentário canônico em `apps/api/src/app.ts`). Não reescrever.
