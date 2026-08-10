import { randomUUID } from 'node:crypto'
import type { ConnectionStatusChange, IncomingMessage, MessageStatusUpdate } from '@aios-pocket/contracts'
import { companiesRepo, getTenant, prisma, runWithTenant } from '@aios-pocket/db'
import { parseProviderWebhook } from '@aios-pocket/providers'
import { publishDomainEvent } from '../queue/events.js'
import { isBlockedFailureAck, nextState } from './apply-status.js'
import { resolveCustomer } from './resolve-customer.js'

// Erro de unicidade do Postgres via Prisma (P2002) — checado por duck-typing para não
// importar @prisma/client fora de packages/db (ESLint proíbe, ADR-0001).
function isUniqueConstraintError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002'
}

// RawWebhookEvent é tenant-exempt (packages/db/src/unsafe.ts) — funciona com ou sem
// TenantContext ativo, então pode ser chamado tanto antes de entrar no runWithTenant
// (carregar o companyId) quanto de dentro dele (marcar processado).
function markProcessed(rawId: string, error?: string) {
  return prisma.rawWebhookEvent.update({ where: { id: rawId }, data: { processed: true, error: error ?? null } })
}

type IncomingOutcome = { outcome: 'applied' } | { outcome: 'invalid_phone'; reason: string }

async function handleIncomingMessage(companyId: string, msg: IncomingMessage): Promise<IncomingOutcome> {
  // JIDs "veneno" (status@broadcast, @newsletter, ids curtos etc.) passam pelo parser —
  // que só filtra grupo/lid — mas não são telefone válido; canonicalizePhone lança. Sem
  // este catch, o job re-tentava 3x e morria exausto para sempre (achado IMPORTANT da
  // revisão T10). Tratado como "ignorado com motivo", nunca propagado.
  let customer
  try {
    customer = await resolveCustomer(msg.phone)
  } catch (err) {
    return { outcome: 'invalid_phone', reason: err instanceof Error ? err.message : String(err) }
  }

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
  // conseguido gravar a timeline numa tentativa anterior não duplica.
  const timelineType = msg.fromMe ? 'message_sent_from_phone' : 'message_received'
  const existingTimeline = await prisma.customerEvent.findFirst({
    where: { customerId: customer.id, type: timelineType, correlationId },
  })
  if (!existingTimeline) {
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
  }

  // Publicado depois dos writes de domínio (ADR-0004). correlationId agora é ESTÁVEL
  // entre tentativas (o da Message, nunca um novo por chamada) — o jobId de
  // publishDomainEvent (`${name}-${correlationId}`) fica estável também, então um
  // retry aqui é um no-op de verdade para o BullMQ, não uma republicação despistada.
  await publishDomainEvent({
    name: 'MessageReceived',
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
  // timeline deveria existir — backfill idempotente por (customerId, type,
  // correlationId, occurredAt). Se o estado não bateu (regressão de verdade ou corrida
  // vencida por outra transição), não há nada a registrar aqui.
  if (currentState !== msg.status) return 'ignored'

  const conversation = await prisma.conversation.findFirst({ where: { id: message.conversationId } })
  if (!conversation) return 'applied' // defensivo; não deveria acontecer (FK garante a linha)

  const existingTimeline = await prisma.customerEvent.findFirst({
    where: {
      customerId: conversation.customerId,
      type: 'message_status_changed',
      correlationId: message.correlationId,
      occurredAt: msg.timestamp,
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
          previousState: message.state,
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
