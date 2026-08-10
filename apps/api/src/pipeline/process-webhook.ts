import { randomUUID } from 'node:crypto'
import type { ConnectionStatusChange, IncomingMessage, MessageStatusUpdate } from '@aios-pocket/contracts'
import { companiesRepo, getTenant, prisma, runWithTenant } from '@aios-pocket/db'
import { parseProviderWebhook } from '@aios-pocket/providers'
import { publishDomainEvent } from '../queue/events.js'
import { nextState } from './apply-status.js'
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

async function handleIncomingMessage(companyId: string, msg: IncomingMessage): Promise<void> {
  const customer = await resolveCustomer(msg.phone)

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
  const correlationId = randomUUID()

  let message
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
    // Dedupe pela unique (companyId, provider, providerMessageId, direction): a mesma
    // mensagem chegando de novo (reentrega do provider, reprocessamento) não é erro —
    // é o mecanismo de idempotência (ADR-0003).
    if (isUniqueConstraintError(err)) return
    throw err
  }

  await prisma.customerEvent.create({
    data: {
      companyId,
      customerId: customer.id,
      type: msg.fromMe ? 'message_sent_from_phone' : 'message_received',
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

  // Publicado depois dos writes de domínio (ADR-0004) — consumers (Follow-up, Analytics,
  // IA) reagem sem acoplar ao pipeline de ingestão.
  await publishDomainEvent({
    name: 'MessageReceived',
    companyId,
    correlationId,
    schemaVersion: 1,
    occurredAt: msg.timestamp,
    payload: { messageId: message.id, customerId: customer.id, conversationId: conversation.id, fromMe: msg.fromMe },
  })
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
  if (next === null) return 'ignored' // regressão ou repetição — sem TimelineEvent

  // updateMany guardado pelo estado lido: se outra transição venceu a corrida entre o
  // findFirst e aqui, count vem 0 e não registramos uma TimelineEvent para algo que
  // não aconteceu de fato sob esse estado-base.
  const result = await prisma.message.updateMany({
    where: { id: message.id, state: message.state },
    data: { state: next },
  })
  if (result.count === 0) return 'ignored'

  const conversation = await prisma.conversation.findFirst({ where: { id: message.conversationId } })
  if (!conversation) return 'applied' // defensivo; não deveria acontecer (FK garante a linha)

  await prisma.customerEvent.create({
    data: {
      companyId: getTenant().companyId,
      customerId: conversation.customerId,
      type: 'message_status_changed',
      payload: {
        messageId: message.id,
        previousState: message.state,
        newState: next,
        provider: msg.provider,
        providerMessageId: msg.providerMessageId,
      },
      schemaVersion: 1,
      correlationId: message.correlationId,
      occurredAt: msg.timestamp,
    },
  })
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
// novo (retry configurado na fila, ver queue/queues.ts).
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
      await handleIncomingMessage(companyId, event)
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
