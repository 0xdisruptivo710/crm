import { companiesRepo, prisma, runWithTenant } from '@aios-pocket/db'
import { providerForCompany } from '../provider-factory.js'
import { publishDomainEvent } from '../queue/events.js'

// Teto do fail_reason gravado no banco — mensagens de erro de provider podem vir enormes
// (stack de HTTP client, corpo de resposta etc.); truncar evita uma coluna monstruosa.
const FAIL_REASON_MAX_LENGTH = 500

function truncate(reason: string): string {
  return reason.length > FAIL_REASON_MAX_LENGTH ? `${reason.slice(0, FAIL_REASON_MAX_LENGTH)}…` : reason
}

// Use case central do envio (ADR-0006): processa um Message `queued` criado pela rota
// POST /messages. Chamado pelo worker de `message-send` (queue/send-worker.ts) com o
// companyId que veio no payload do job — o worker roda fora de qualquer request HTTP
// (sem TenantContext ainda), então abre o runWithTenant aqui, para TODO o resto da função.
//
// `attemptsMade` (job.attemptsMade do BullMQ) resolve uma ambiguidade da transição
// atômica abaixo: na 1ª execução a linha está `queued` e o updateMany avança para
// `sending` (count 1). Numa RETENTATIVA de verdade (BullMQ chamando de novo depois do
// provider ter lançado na tentativa anterior) a linha já está `sending` — o updateMany
// filtrado por `queued` dá count 0, mas isso NÃO é um job duplicado, é o fluxo normal de
// retry, e precisa prosseguir e tentar enviar de novo. Só quando a linha já está
// `sending` E esta é a PRIMEIRA tentativa (attemptsMade === 0) é que se trata de uma
// execução concorrente/duplicada de verdade (ou a linha já está `sent`/`failed`) — nesses
// casos, no-op idempotente.
export async function sendQueuedMessage(messageId: string, companyId: string, attemptsMade: number): Promise<void> {
  await runWithTenant({ companyId }, async () => {
    const transitioned = await prisma.message.updateMany({
      where: { id: messageId, state: 'queued' },
      data: { state: 'sending' },
    })

    if (transitioned.count === 0) {
      const current = await prisma.message.findFirst({ where: { id: messageId } })
      if (!current) throw new Error(`message não encontrada: ${messageId}`)
      const isRetryInFlight = current.state === 'sending' && attemptsMade > 0
      if (!isRetryInFlight) return // já sent/failed, ou execução concorrente/duplicada — no-op
    }

    const message = await prisma.message.findFirst({
      where: { id: messageId },
      include: { conversation: { include: { customer: true } } },
    })
    if (!message) throw new Error(`message não encontrada após transição: ${messageId}`)

    const { conversation } = message
    const { customer } = conversation

    // companiesRepo.findById é pré-tenant (packages/db/src/repositories/companies.ts) —
    // Company é a raiz do tenant, sem coluna company_id; o worker já sabe o companyId
    // pelo payload do job, sem depender do TenantContext para achar a própria Company.
    const company = await companiesRepo.findById(companyId)
    if (!company) throw new Error(`company não encontrada: ${companyId}`)

    const provider = providerForCompany(company)

    // Falha do provider PROPAGA (throw): o BullMQ tenta de novo (attempts: 3, backoff
    // exponencial — configurados no enqueue da rota, apps/api/src/routes/messages.ts).
    // Falha NUNCA silenciosa: o handler `worker.on('failed', ...)` de queue/send-worker.ts
    // marca o estado terminal quando as tentativas se esgotam (ver markSendFailed abaixo).
    const result = await provider.sendText(customer.phoneE164.replace('+', ''), message.text ?? '')

    await prisma.message.updateMany({
      where: { id: messageId, state: 'sending' },
      data: { state: 'sent', providerMessageId: result.providerMessageId },
    })

    // Timeline condicional (idempotente por correlationId, padrão T10): um retry que já
    // tinha conseguido gravar a timeline numa tentativa anterior não duplica.
    const existingTimeline = await prisma.customerEvent.findFirst({
      where: { customerId: customer.id, type: 'message_sent', correlationId: message.correlationId },
    })
    if (!existingTimeline) {
      await prisma.customerEvent.create({
        data: {
          companyId,
          customerId: customer.id,
          type: 'message_sent',
          payload: {
            messageId: message.id,
            conversationId: conversation.id,
            provider: company.activeProvider,
            providerMessageId: result.providerMessageId,
          },
          schemaVersion: 1,
          correlationId: message.correlationId,
          occurredAt: new Date(),
        },
      })
    }

    // Publicado depois dos writes de domínio (ADR-0004), com o correlationId ESTÁVEL da
    // Message — o jobId de publishDomainEvent (`${name}-${correlationId}`) fica estável
    // entre retries, então uma republicação aqui é um no-op de verdade para o BullMQ.
    await publishDomainEvent({
      name: 'MessageSent',
      companyId,
      correlationId: message.correlationId,
      schemaVersion: 1,
      occurredAt: new Date(),
      payload: { messageId: message.id, customerId: customer.id, conversationId: conversation.id },
    })
  })
}

// Chamado pelo handler `worker.on('failed', ...)` (queue/send-worker.ts) quando as
// tentativas do BullMQ se esgotam — falha NUNCA silenciosa (regra do CLAUDE.md §4): o
// Message não pode ficar preso em `sending` para sempre sem ninguém saber o motivo.
export async function markSendFailed(messageId: string, companyId: string, reason: string): Promise<void> {
  const failReason = truncate(reason)
  await runWithTenant({ companyId }, async () => {
    // Guarda pelo estado atual: se outra chamada concorrente já terminou a Message
    // (sent, ou failed por uma chamada duplicada do próprio handler) count vem 0 — no-op.
    const result = await prisma.message.updateMany({
      where: { id: messageId, state: 'sending' },
      data: { state: 'failed', failReason },
    })
    if (result.count === 0) return

    const message = await prisma.message.findFirst({ where: { id: messageId }, include: { conversation: true } })
    if (!message) return

    const existingTimeline = await prisma.customerEvent.findFirst({
      where: {
        customerId: message.conversation.customerId,
        type: 'message_send_failed',
        correlationId: message.correlationId,
      },
    })
    if (!existingTimeline) {
      await prisma.customerEvent.create({
        data: {
          companyId,
          customerId: message.conversation.customerId,
          type: 'message_send_failed',
          payload: { messageId: message.id, conversationId: message.conversationId, failReason },
          schemaVersion: 1,
          correlationId: message.correlationId,
          occurredAt: new Date(),
        },
      })
    }
  })
}
