# ADR-0004 — Timeline como event log (e eventos entre domínios)

**Data:** 2026-08-07 (semente) · **Status:** aceita — implementada na Fatia 1 (1136+ eventos em produção)

## Problema

Seis domínios precisam do histórico do cliente para fins diferentes (tela de histórico, auditoria, analytics, contexto para IA) sem se acoplarem uns aos outros — e já vivemos o inferno de workflow disparando workflow sem trilha de rastreio.

## Decisão

1. **Tabela `customer_events` append-only**: `company_id, customer_id, type, payload, schema_version, correlation_id, occurred_at`. Todo payload carrega `schema_version` **desde o evento nº 1**.
2. A Timeline (tela) é **apenas uma query** sobre essa tabela. Ela serve simultaneamente: histórico, auditoria, analytics e contexto para IA.
3. **É um log, NÃO event sourcing.** O estado vive nas tabelas de domínio; eventos nunca são fonte de verdade nem base para reconstrução de estado. Qualquer deslize nessa direção é violação de arquitetura.
4. **Comunicação entre módulos**: dentro do mesmo domínio, chamada direta (Conversation criar Message não precisa de evento). Entre domínios, evento (ex. futuro: AppointmentCreated → Follow-up reage, Timeline registra, Analytics contabiliza, IA recebe contexto). Eventos publicados **depois do commit**; consumers **idempotentes**; **`correlation_id` em tudo** — rastreabilidade é inegociável.

## Consequências

- Rastreabilidade ponta-a-ponta provada em produção: o MESMO `correlation_id` liga webhook → Message → TimelineEvent (E2E de 2026-08-23 e 2026-08-28).
- Dedupe por índice de idempotência: reprocessamento nunca duplica evento.
- Nomes de evento não mentem: o outbound digitado no celular do humano é `message_sent_from_phone` (renomeado do ambíguo "MessageReceived" — carry-over do Plano B); demais em produção: `message_received`, `message_sent`, `message_status_changed`, `message_send_failed`.
- Visões agregadas futuras (pendências, atividades) nascem como projeções de leitura sobre a Timeline — nunca como entidade genérica (ADR-0007).
