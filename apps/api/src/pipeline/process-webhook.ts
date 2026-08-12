import { randomUUID } from 'node:crypto'
import type { ConnectionStatusChange, IncomingMessage, MessageStatusUpdate } from '@aios-pocket/contracts'
import { canonicalizePhone, companiesRepo, getTenant, prisma, runWithTenant } from '@aios-pocket/db'
import { parseProviderWebhook } from '@aios-pocket/providers'
import { publishDomainEvent } from '../queue/events.js'
import { isBlockedFailureAck, nextState } from './apply-status.js'
import { isUniqueConstraintError } from './prisma-errors.js'
import { resolveCustomer } from './resolve-customer.js'

// RawWebhookEvent é tenant-exempt (packages/db/src/unsafe.ts) — funciona com ou sem
// TenantContext ativo, então pode ser chamado tanto antes de entrar no runWithTenant
// (carregar o companyId) quanto de dentro dele (marcar processado).
function markProcessed(rawId: string, error?: string) {
  return prisma.rawWebhookEvent.update({ where: { id: rawId }, data: { processed: true, error: error ?? null } })
}

type IncomingOutcome =
  | { outcome: 'applied' }
  | { outcome: 'invalid_phone'; reason: string }
  | { outcome: 'echo' }

async function handleIncomingMessage(companyId: string, msg: IncomingMessage): Promise<IncomingOutcome> {
  // Guarda do eco fromMe (OBRIGAÇÃO da re-review T10 / binding design da Task 11): quando
  // o PRÓPRIO envio (rota POST /messages + worker `message-send`, apps/api/src/pipeline/
  // send-message.ts) sai pela Evolution, a instância devolve esse mesmo envio de volta
  // como um webhook messages.upsert com fromMe=true e o MESMO providerMessageId que a
  // Evolution atribuiu na resposta do sendText. Sem esta guarda, o dedupe por P2002
  // (mais abaixo) encontraria a Message OUTBOUND já criada pelo worker de envio e, mesmo
  // sem duplicar a LINHA, ainda publicaria timeline/MessageReceived — duplicados, pois o
  // envio já foi registrado (timeline `message_sent` + evento `MessageSent`) por
  // send-message.ts. Checado ANTES de qualquer I/O de customer/conversation — um eco
  // reconhecido não deve gerar nenhuma escrita nova.
  if (msg.fromMe) {
    const ownSend = await prisma.message.findFirst({
      where: { provider: msg.provider, providerMessageId: msg.providerMessageId, direction: 'outbound' },
    })
    if (ownSend) return { outcome: 'echo' }
  }

  // JIDs "veneno" (status@broadcast, @newsletter, ids curtos etc.) passam pelo parser —
  // que só filtra grupo/lid (packages/providers) — mas não são telefone válido;
  // canonicalizePhone lança. Sem este catch, o job re-tentava 3x e morria exausto para
  // sempre (achado IMPORTANT da revisão T10).
  //
  // O catch cobre SÓ esta chamada pura (sem I/O) — achado IMPORTANT da revisão T10 round
  // 2: um catch mais largo (em volta de resolveCustomer, que faz I/O) transformava
  // QUALQUER erro de banco (pool esgotado, corrida real, TenantContext ausente) em
  // "telefone inválido", descartando uma mensagem REAL em silêncio permanente, em vez de
  // deixar o job falhar e o BullMQ tentar de novo.
  let canonical
  try {
    canonical = canonicalizePhone(msg.phone)
  } catch (err) {
    return { outcome: 'invalid_phone', reason: err instanceof Error ? err.message : String(err) }
  }

  // Erros de resolveCustomer (I/O) PROPAGAM daqui pra cima — nenhum catch os intercepta.
  const customer = await resolveCustomer(canonical)

  let conversation = await prisma.conversation.findFirst({
    where: { provider: msg.provider, externalId: msg.conversationExternalId },
  })
  if (!conversation) {
    conversation = await prisma.conversation.create({
      data: {
        // companyId exigido pelo tipo do Prisma (cinto de segurança); a extension de
        // tenancy sobrescreve com o valor do contexto de qualquer forma (unsafe.ts).
        companyId,
        customerId: customer.id,
        provider: msg.provider,
        externalId: msg.conversationExternalId,
        lastMessageAt: msg.timestamp,
      },
    })
  } else {
    // upsert é proibido no client tenantizado (packages/db/src/unsafe.ts) — updateMany
    // guardado pelo id é o padrão aprovado para "atualizar se já existe".
    await prisma.conversation.updateMany({ where: { id: conversation.id }, data: { lastMessageAt: msg.timestamp } })
  }

  const direction = msg.fromMe ? 'outbound' : 'inbound'
  const state = msg.fromMe ? 'sent' : 'received'

  let message
  let correlationId: string = randomUUID()
  try {
    message = await prisma.message.create({
      data: {
        companyId,
        conversationId: conversation.id,
        direction,
        state,
        provider: msg.provider,
        providerMessageId: msg.providerMessageId,
        fromMe: msg.fromMe,
        type: msg.type,
        text: msg.text,
        mediaUrl: msg.media?.url ?? null,
        mediaMimeType: msg.media?.mimeType ?? null,
        mediaCorrelationKey: msg.media?.correlationKey ?? null,
        replyToProviderMessageId: msg.replyToProviderMessageId,
        correlationId,
      },
    })
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err
    // Dedupe pela unique (companyId, provider, providerMessageId, direction): a mesma
    // mensagem chegando de novo (reentrega do provider, reprocessamento, retry após uma
    // falha parcial no PRÓPRIO passo anterior — ex.: publishDomainEvent caiu depois do
    // create) bate aqui. CRÍTICO (achado da revisão T10): NÃO retorna cedo — em vez
    // disso lê a Message já existente e CONTINUA o passo com o correlationId DELA, para
    // que timeline/evento de domínio ainda pendentes de uma tentativa anterior não se
    // percam para sempre atrás de um "raw processado com sucesso".
    const existing = await prisma.message.findFirst({
      where: { provider: msg.provider, providerMessageId: msg.providerMessageId, direction },
    })
    if (!existing) throw err // não deveria acontecer: é exatamente essa unique que disparou o P2002
    message = existing
    correlationId = existing.correlationId
  }

  // Timeline condicional (idempotente por correlationId): um retry que já tinha
  // conseguido gravar a timeline numa tentativa anterior não duplica. Hardening batch C,
  // Step 3 (TOCTOU, achado da review do Plano B): o findFirst-depois-create abaixo tem uma
  // janela entre a leitura e a escrita — o índice único parcial `customer_events_dedupe_idx`
  // (migração 20260812015258_customer_events_dedupe_idx) fecha essa janela no BANCO; o
  // catch de P2002 trata a colisão como no-op, mesmo padrão já usado para o dedupe de
  // Message logo acima.
  const timelineType = msg.fromMe ? 'message_sent_from_phone' : 'message_received'
  const existingTimeline = await prisma.customerEvent.findFirst({
    where: { customerId: customer.id, type: timelineType, correlationId },
  })
  if (!existingTimeline) {
    try {
      await prisma.customerEvent.create({
        data: {
          companyId,
          customerId: customer.id,
          type: timelineType,
          payload: {
            messageId: message.id,
            conversationId: conversation.id,
            provider: msg.provider,
            providerMessageId: msg.providerMessageId,
          },
          schemaVersion: 1,
          correlationId,
          occurredAt: msg.timestamp,
        },
      })
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err
      // Outra execução concorrente (mesmo correlationId/type) venceu a corrida entre o
      // findFirst acima e este create — o índice único parcial garante que só uma linha
      // existe; no-op aqui, a linha dela já é a timeline de verdade.
    }
  }

  // Publicado depois dos writes de domínio (ADR-0004). correlationId agora é ESTÁVEL
  // entre tentativas (o da Message, nunca um novo por chamada) — o jobId de
  // publishDomainEvent (`${name}-${correlationId}`) fica estável também, então um
  // retry aqui é um no-op de verdade para o BullMQ, não uma republicação despistada.
  //
  // Hardening batch C, Step 4 (carry-over do Plano A/B — naming de MessageReceived
  // documentado em docs/superpowers/2026-08-08-plano-a-carryover.md): `MessageReceived`
  // sugere "recebido do cliente", mas até aqui também era publicado quando o humano
  // responde pelo PRÓPRIO celular (fromMe=true, ver guarda de eco acima — isto só roda
  // para o registro CANÔNICO de um envio pelo celular, não para o eco do envio pela API).
  // `MessageSentFromPhone` ganha nome próprio para esse caso; `MessageReceived` volta a
  // significar só cliente→empresa. Nenhum consumer registrado ainda (getHandlers vazio
  // para os dois nomes) — rename seguro, sem migração de consumer.
  await publishDomainEvent({
    name: msg.fromMe ? 'MessageSentFromPhone' : 'MessageReceived',
    companyId,
    correlationId,
    schemaVersion: 1,
    occurredAt: msg.timestamp,
    payload: { messageId: message.id, customerId: customer.id, conversationId: conversation.id, fromMe: msg.fromMe },
  })

  return { outcome: 'applied' }
}

type StatusOutcome = 'applied' | 'ignored' | 'unknown'

async function handleStatusUpdate(msg: MessageStatusUpdate): Promise<StatusOutcome> {
  // MessageStatusUpdate não carrega `direction` (contrato normalizado) — casa só por
  // (provider, providerMessageId). Em teoria duas mensagens (inbound/outbound) poderiam
  // colidir no id; a mais recente é a interpretação razoável na ausência de mais sinal.
  const message = await prisma.message.findFirst({
    where: { provider: msg.provider, providerMessageId: msg.providerMessageId },
    orderBy: { createdAt: 'desc' },
  })
  if (!message) return 'unknown' // ack de mensagem pré-pipeline: não é erro (brief)

  const next = nextState(message.state, msg.status)

  if (next === null && isBlockedFailureAck(message.state, msg.status)) {
    // read/delivered são fatos mais fortes que um ack de falha tardio — o estado NÃO
    // regride, mas o motivo ainda é informação nova: grava só failReason (achado FOLDED
    // da revisão T10), sem tocar em state nem timeline. updateMany é idempotente por
    // natureza aqui (setar o mesmo valor de novo num retry é inofensivo).
    await prisma.message.updateMany({
      where: { id: message.id },
      data: { failReason: `ack de falha ignorado (mensagem já ${message.state})` },
    })
    return 'ignored'
  }

  let currentState = message.state
  if (next !== null) {
    // updateMany guardado pelo estado lido (CAS): se outra transição venceu a corrida
    // entre o findFirst e aqui, count vem 0.
    const result = await prisma.message.updateMany({
      where: { id: message.id, state: message.state },
      data: { state: next },
    })
    if (result.count > 0) {
      currentState = next
    } else {
      // Relê para saber se quem venceu a corrida aplicou EXATAMENTE este mesmo ack
      // (backfill da timeline ainda vale) ou uma transição diferente.
      const reread = await prisma.message.findFirst({ where: { id: message.id } })
      currentState = reread?.state ?? message.state
    }
  }

  // O estado atual da Message já é o alvo do ack: seja porque acabamos de aplicar agora
  // (transição nova), seja porque um RETRY leu um estado já avançado por uma tentativa
  // anterior que morreu antes de gravar a timeline (CRÍTICO — achado da revisão T10:
  // antes disso, nextState devolvia null aqui e o evento se perdia para sempre), seja
  // porque outra chamada concorrente aplicou este mesmo ack primeiro. Nos 3 casos a
  // timeline deveria existir. Se o estado não bateu (regressão de verdade ou corrida
  // vencida por outra transição), não há nada a registrar aqui.
  if (currentState !== msg.status) return 'ignored'

  const conversation = await prisma.conversation.findFirst({ where: { id: message.conversationId } })
  if (!conversation) return 'applied' // defensivo; não deveria acontecer (FK garante a linha)

  // "previousState" só é conhecível quando FOI ESTA CHAMADA (ou uma corrida concorrente
  // que partiu do MESMO estado lido por nós) que efetuou a transição — nesse caso
  // `message.state` (lido antes de qualquer mutação) ainda reflete o valor real anterior.
  // Quando currentState já chega igual a message.state (nada mudou sob nossa observação:
  // a transição real aconteceu numa tentativa anterior, já sumida), é um BACKFILL puro —
  // o valor anterior verdadeiro é incognoscível a partir daqui; mentir com o valor atual
  // (achado FOLDED da revisão T10 round 2) é pior que admitir null.
  const isBackfill = message.state === currentState

  // Dedupe da timeline SEM occurredAt na chave (achado FOLDED da revisão T10 round 2):
  // uma reentrega do provider para o MESMO ack (mesma transição, `date_time`/occurredAt
  // NOVO) não pode virar uma segunda linha "no-op". A chave real de uma transição é
  // (Message, estado-alvo) — correlationId já identifica a Message; o filtro por JSON
  // path em `payload.newState` identifica QUAL transição (sent→delivered e
  // delivered→read da MESMA mensagem são eventos diferentes, mesmo correlationId).
  const existingTimeline = await prisma.customerEvent.findFirst({
    where: {
      customerId: conversation.customerId,
      type: 'message_status_changed',
      correlationId: message.correlationId,
      payload: { path: ['newState'], equals: currentState },
    },
  })
  if (!existingTimeline) {
    await prisma.customerEvent.create({
      data: {
        companyId: getTenant().companyId,
        customerId: conversation.customerId,
        type: 'message_status_changed',
        payload: {
          messageId: message.id,
          backfill: isBackfill,
          previousState: isBackfill ? null : message.state,
          newState: currentState,
          provider: msg.provider,
          providerMessageId: msg.providerMessageId,
        },
        schemaVersion: 1,
        correlationId: message.correlationId,
        occurredAt: msg.timestamp,
      },
    })
  }
  return 'applied'
}

async function handleConnectionStatusChange(companyId: string, msg: ConnectionStatusChange): Promise<void> {
  // Company é a raiz do tenant (sem coluna company_id) — companiesRepo.updateConnectionState
  // usa prismaUnsafe por dentro (ver packages/db/src/repositories/companies.ts).
  await companiesRepo.updateConnectionState(companyId, msg.status)

  // Sem customer_events aqui: o schema exige customerId e conexão é COMPANY-scoped, não
  // customer-scoped — desvio documentado do texto do brief (ver task-10-report.md).
  await publishDomainEvent({
    name: 'ConnectionChanged',
    companyId,
    correlationId: randomUUID(),
    schemaVersion: 1,
    occurredAt: msg.timestamp,
    payload: { state: msg.status, reason: msg.reason },
  })
}

// Use case central do pipeline inbound (ADR-0003/0004/0006): webhook cru vira
// Customer + Conversation + Message + TimelineEvent (+ evento de domínio).
// Erros de processamento NÃO marcam processed=true — o job falha e o BullMQ tenta de
// novo (retry configurado na fila, ver queue/queues.ts). Todo passo interno é
// idempotente (achado CRÍTICO da revisão T10) — um retry depois de QUALQUER falha
// parcial (crash entre dois writes, blip do Redis no publish) é seguro de re-rodar.
export async function processRawWebhook(rawEventId: string): Promise<void> {
  // Leitura tenant-exempt: precisa do companyId ANTES de poder abrir o TenantContext.
  const raw = await prisma.rawWebhookEvent.findUnique({ where: { id: rawEventId } })
  if (!raw) throw new Error(`raw webhook event não encontrado: ${rawEventId}`)
  if (raw.processed) return // reentrada idempotente (reconciliação, retry manual, etc.)

  const companyId = raw.companyId
  if (!companyId) throw new Error(`raw webhook event sem companyId, não pode ser processado: ${rawEventId}`)

  await runWithTenant({ companyId }, async () => {
    const event = parseProviderWebhook(raw.provider, raw.payload)
    if (!event) {
      await markProcessed(raw.id, 'ignorado')
      return
    }

    if (event.kind === 'incoming_message') {
      const result = await handleIncomingMessage(companyId, event)
      if (result.outcome === 'invalid_phone') {
        await markProcessed(raw.id, `telefone inválido: ${result.reason}`)
        return
      }
      if (result.outcome === 'echo') {
        // Eco do próprio envio (ver comentário da guarda em handleIncomingMessage) —
        // marcado processado com motivo, sem timeline/evento (já registrados no envio).
        await markProcessed(raw.id, 'echo do próprio envio')
        return
      }
    } else if (event.kind === 'message_status_update') {
      const outcome = await handleStatusUpdate(event)
      if (outcome === 'unknown') {
        await markProcessed(raw.id, 'mensagem desconhecida')
        return
      }
    } else if (event.kind === 'connection_status_change') {
      await handleConnectionStatusChange(companyId, event)
    }

    await markProcessed(raw.id)
  })
}
