# ADR-0005 — Realtime via Supabase na v1

**Data:** 2026-08-07 (semente) · **Status:** aceita — implementada nas Tasks 2/8 do Plano C, provada em produção

## Problema

O inbox precisa de tempo real (mensagem nova, acks, conversa nova) sem que a gente opere um servidor WebSocket próprio — infraestrutura cara de manter e proibida na v1 pela seção de stack.

## Decisão

1. O frontend assina `postgres_changes` (INSERT/UPDATE) de **`messages` e `conversations`** via **Supabase Realtime**.
2. Para o Realtime filtrar por tenant (ele não conhece o TenantContext), existe a **exceção única** à ADR-0001: políticas RLS **read-only** nessas duas tabelas (role `authenticated`), com predicado via função **SECURITY DEFINER** (dependência estável, imune a grants futuros em `users`); publication contém só essas tabelas; Data API/PostgREST fechada para anon/authenticated (detalhes e o Critical corrigido em Database.md §RLS).
3. No cliente, **o evento é sinal, não fonte de dados**: dispara refetch debounced dos DTOs validados pela API (mapear linha crua no front duplicaria a tradução da API — Conventions.md). Todo `SUBSCRIBED` (inclusive resubscribe pós-queda) dispara refetch de segurança.
4. **WebSocket próprio apenas se surgir motivo técnico real — e exige nova ADR.**

## Consequências

- Zero infraestrutura própria de realtime; RLS fica com escopo mínimo e auditável (2 tabelas, read-only).
- Provado no E2E da Fatia 1: mensagem real na tela sem refresh, lista reordenando, acks ✓✓ ao vivo.
- Latência medida em produção (2026-08-28): insert→tela ~1,5–2,2s (debounce 300ms + refetch). Aceita para v1; **fast-path** (mapear o payload do INSERT direto na conversa aberta, refetch como reconciliação) registrado no carry-over como evolução — não muda esta decisão.
- O estado local da UI deduplica por id (append otimista usa o `messageId` real do 202).
