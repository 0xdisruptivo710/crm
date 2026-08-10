import { companiesRepo, prisma, runWithTenant } from '@aios-pocket/db'
import { providerForCompany } from '../provider-factory.js'
import { publishDomainEvent } from '../queue/events.js'
import { isUniqueConstraintError } from './prisma-errors.js'

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
export async function sendQueuedMessage(messageId: string, companyId: string): Promise<void> {
  await runWithTenant({ companyId }, async () => {
    const transitioned = await prisma.message.updateMany({
      where: { id: messageId, state: 'queued' },
      data: { state: 'sending' },
    })

    if (transitioned.count === 0) {
      // Reentrada: a linha já não está `queued`. NUNCA reenviamos a partir daqui —
      // removido o heurístico anterior baseado em `job.attemptsMade` (achado CRÍTICO da
      // re-review T11, verificado contra o Lua/JS do bullmq@5.81.3): a recuperação de um
      // job "stalled" pelo BullMQ NÃO incrementa attemptsMade, então um job recuperado
      // reprocessava aqui com state=`sending` e attemptsMade=0 — o heurístico antigo
      // classificava isso como "duplicado", devolvia sem lançar, e o BullMQ marcava o job
      // como COMPLETED com a Message presa em `sending` para sempre, em silêncio. Sem
      // como distinguir com certeza "retry legítimo" de "stalled" de "duplicata" só pelo
      // estado da linha, a única postura segura é: se já saiu de `queued`, nunca reenviar
      // (não há como saber se a chamada ao provider da tentativa anterior já foi ou não
      // disparada de verdade — reenviar arriscaria um envio real duplicado ao cliente).
      // Uma linha presa em `sending` fica visível e é resolvida pela varredura de
      // reconciliação da subida do worker (queue/send-worker.ts) depois de 10 minutos —
      // nunca silêncio, nunca reenvio automático.
      const exists = await prisma.message.findFirst({ where: { id: messageId }, select: { id: true } })
      if (!exists) throw new Error(`message não encontrada: ${messageId}`)
      return
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

    // Falha do provider PROPAGA (throw): o BullMQ tenta de novo só se o erro acontecer
    // ANTES da transição queued→sending ter sido persistida (ver comentário acima) —
    // depois dela, qualquer retry é um no-op por design. Falha NUNCA silenciosa: o
    // handler `worker.on('failed', ...)` de queue/send-worker.ts confirma via
    // `job.isFailed()` (não por attemptsMade — outro achado da re-review T11, ver
    // comentário lá) quando o job realmente terminou, e a varredura de reconciliação
    // cobre qualquer linha presa em `sending` que nenhum evento resolveu.
    const result = await provider.sendText(customer.phoneE164.replace('+', ''), message.text ?? '')

    try {
      await prisma.message.updateMany({
        where: { id: messageId, state: 'sending' },
        data: { state: 'sent', providerMessageId: result.providerMessageId },
      })
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err
      // Corrida do eco (achado IMPORTANT da re-review T11): o webhook de eco (guarda
      // fromMe de process-webhook.ts) processou o MESMO envio ANTES desta atualização —
      // naquele momento nossa linha ainda tinha providerMessageId NULL, então a guarda não
      // a reconheceu como eco e o pipeline inbound criou sua PRÓPRIA linha outbound já com
      // o providerMessageId real. Esta atualização colide com ela na unique
      // (companyId, provider, providerMessageId, direction). A linha do eco é a CANÔNICA
      // — ela já carrega o providerMessageId certo e a timeline do pipeline inbound —
      // então descartamos esta linha original (órfã: ainda `sending`, providerMessageId
      // NULL) em vez de propagar o erro. Sucesso de verdade: a mensagem chegou ao
      // cliente, só não é esta linha que registra isso.
      await prisma.message.deleteMany({ where: { id: messageId, state: 'sending', providerMessageId: null } })
      return
    }

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

// Chamado pelo handler `worker.on('failed', ...)` (queue/send-worker.ts) quando o job
// termina de verdade (confirmado via `job.isFailed()`, não por contagem de tentativas) —
// falha NUNCA silenciosa (regra do CLAUDE.md §4): o Message não pode ficar preso em
// `sending` para sempre sem ninguém saber o motivo. Também chamado pela varredura de
// reconciliação (queue/send-worker.ts) para linhas presas em `sending` há mais de 10min,
// com o motivo fixo `'estado incerto (crash durante envio)'`.
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
