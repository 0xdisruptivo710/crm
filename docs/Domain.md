# Domínio — Aios Pocket

## Núcleo de identidade (ADR-0007)

Estável; nunca muda de responsabilidade. Todo domínio novo REFERENCIA o núcleo — jamais o duplica.

- **Company** — o tenant. Toda tabela de negócio carrega `company_id` (ADR-0001). Hoje guarda `activeProvider` + credenciais cifradas + `connectionState` — **transição planejada**: na Fatia 4 esses atributos migram para `Channel` (ADR-0009), com backfill do canal Evolution default por Company.
- **Channel** (ADR-0009; entra na Fatia 4) — uma conexão de mensageria da Company: provider (evolution | uazapi | zernio), credenciais por canal, identificador de instância, estado de conexão. Company 1—N Channels; `Conversation.channelId` obrigatório. Regra sagrada: **1 conversa = 1 canal = 1 provider; nunca dois providers na mesma conversa; nunca fallback automático entre canais** (semânticas diferentes quebrariam a conversa no meio).
- **Customer** — a pessoa. Identidade canônica por telefone (abaixo). Único por `(companyId, phoneE164)`.
- **Conversation** — o fio de conversa com um Customer num provider. Única por `(companyId, provider, externalId)`; carrega `status` (open|closed) e `lastMessageAt`.
- **Message** — ver máquina de estados abaixo. Tabela ÚNICA (não existe inbox/outbox separados — ADR-0006).
- **TimelineEvent** (`customer_events`) — ver Timeline abaixo.

**Entidades de domínio** (referenciam o núcleo; nascem nas suas fatias): `Appointment` (Agenda), `Card` (Kanban — oportunidade: um cliente tem VÁRIAS ao longo do tempo; valor, etapa, ganho/perda vivem aqui), `FollowupFlow`/`FollowupExecution`, `Campaign`.

**PROIBIDO**: criar uma entidade `Task` genérica que engula agendamento, follow-up e lembrete — são entidades diferentes com semânticas diferentes. Visão unificada de pendências, se necessária um dia, é **projeção de leitura sobre a Timeline**, não entidade.

## Telefone: identidade canônica

- Formato canônico **E.164** (`phoneE164`); o original do provider é sempre preservado (`phoneOriginal`).
- Matching considera a **regra do 9º dígito brasileiro** — o mesmo cliente com e sem o 9 é UM Customer (`packages/db/src/phone.ts`).
- **Customer é resolvido/criado na chegada de qualquer mensagem** — vale desde a Fatia 1; corrida de criação concorrente tratada por P2002 + re-read.

## Máquina de estados da mensagem (ADR-0006)

`received | queued | sending | sent | delivered | read | failed`

- **Inbound**: nasce `received` (webhook).
- **Outbound pela plataforma**: `queued` (rota 202, com `clientMessageId` único por company — retry/duplo clique nunca duplica) → `sending` → `sent` (worker) → `delivered` → `read` (acks chegam como webhooks separados, `MessageStatusUpdate`).
- **Outbound pelo celular do humano** (`fromMe`): chega via webhook e entra como outbound — o histórico nunca mente e a IA (futura) nunca responde por cima do humano. Guarda de eco: o webhook do NOSSO próprio envio (mesmo `providerMessageId`) é reconhecido e não cria linha nova.
- **failed** nunca é silencioso: `failReason` gravado + evento na timeline + cicatriz visível na UI. Reentrada de job em `sending` lança `UnrecoverableError` (nunca reenvia); varredura de reconciliação marca `failed` o que ficar preso além da janela.
- Edição de mensagem: a versão editada (`editedText`) substitui a LEITURA, nunca a original.
- Transições relevantes registradas como TimelineEvents.

## Timeline = event log do cliente (ADR-0004)

`customer_events` **append-only**: `company_id, customer_id, type, payload (com schema_version desde o evento nº 1), correlation_id, occurred_at`.

- A Timeline (tela futura) é **apenas uma query** sobre essa tabela. Serve simultaneamente: histórico, auditoria, analytics e contexto para IA.
- É um **log, NÃO event sourcing**: o estado vive nas tabelas de domínio; eventos jamais são fonte de verdade nem base de reconstrução. Qualquer deslize nessa direção é violação de arquitetura.
- Tipos em produção hoje: `message_received`, `message_sent`, `message_sent_from_phone` (fromMe — nome escolhido para não mentir sobre a direção), `message_status_changed`, `message_send_failed`.
- Dedupe por índice único de idempotência — reprocessamento nunca duplica evento.

## Webhooks: união normalizada (ADR-0003)

Endpoints por provider convertem imediatamente para TRÊS tipos internos (schemas em `packages/contracts`):

1. **IncomingMessage** — provider, providerMessageId, phone, conversationExternalId, tipo, text, media, timestamp, metadata. Campos obrigatórios aprendidos em produção: `fromMe`; chave de correlação de mídia (áudio chega antes do texto; mídia depois); referência de reply/quote; evento de edição.
2. **MessageStatusUpdate** — acks de delivered/read; alimentam a máquina de estados.
3. **ConnectionStatusChange** — instância caiu/QR desconectou → atualiza `connectionState` e alerta (badge). Na Fatia 4 passa a referenciar o Channel.

Todo webhook é **idempotente** (dedupe por provider + providerMessageId + tipo de evento). Todo payload cru é arquivado (`raw_webhook_events`) e vira candidato a fixture.

## Estado de conexão — limitação documentada (intake 2026-08-28)

O badge/banner reflete `connectionState`, alimentado por webhooks `CONNECTION_UPDATE`. Ele cobre desconexões **reportadas** (logout do QR, close) — provado com falha real no E2E da Fatia 1. **Não cobre morte silenciosa do processo da Evolution** (processo morto não emite webhook; o estado congela em `connected`). Watchdog ativo (healthcheck da instância marcando `disconnected` na ausência de resposta) é trabalho futuro registrado no carry-over — exatamente porque "instância morta em silêncio é o pior modo de falha".
