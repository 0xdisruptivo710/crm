# ADR-0006 — Mensagens: uma tabela, uma máquina de estados

**Data:** 2026-08-07 (semente) · **Status:** aceita — implementada nas Fatias 0/1, endurecida nos Planos B/C

## Problema

Rastrear o ciclo de vida de mensagens (recebida, enfileirada, enviada, entregue, lida, falhada) nos dois sentidos sem duplicar modelo. Inbox/outbox separados duplicariam consulta, timeline e realtime — e esconderiam o caso `fromMe` (humano respondendo pelo próprio celular).

## Decisão

1. **Existe UMA tabela `messages`.** Não existe inbox/outbox separados. Direção é coluna (`direction`), origem humana pelo celular é flag (`from_me`).
2. **Estados**: `received | queued | sending | sent | delivered | read | failed`. Inbound nasce `received`; outbound pela plataforma nasce `queued` na rota (202 imediato) e progride no worker; acks (webhooks separados) movem `sent → delivered → read`.
3. **Transições registradas como TimelineEvents** (ADR-0004).
4. **Idempotência dupla**: dedupe de webhook/eco por `(company, provider, providerMessageId, direction)`; idempotência de envio por `(company, clientMessageId)` — a UI gera `crypto.randomUUID()` por envio; retry de rede/duplo clique nunca cria segunda Message (fecha o "202 dangling" do Plano B).
5. **Falha nunca é silenciosa**: `failReason` gravado + evento na timeline. Endurecimentos provados: reentrada de job em `sending` lança `UnrecoverableError` (nunca reenvia, mesmo com retries configurados); varredura de reconciliação marca `failed` com motivo fixo o que passar da janela — cicatriz visível, nunca reenvio automático; corrida do eco no CAS final resolvida (a linha do eco vence, a órfã é removida).

## Consequências

- UI, timeline, realtime e analytics consomem UM modelo; o indicador "você — celular" vs "você — Aios Pocket" é leitura direta de `from_me`.
- A máquina de estados foi provada ponta-a-ponta em produção (acks reais até `read` no E2E da Fatia 1).
- Custo aceito: a tabela concentra colunas de mídia/reply/edição nullable — preço de um modelo único, pago conscientemente.
