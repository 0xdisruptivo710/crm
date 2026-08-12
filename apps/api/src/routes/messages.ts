import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { sendMessageRequestSchema } from '@aios-pocket/contracts'
import { getTenant, prisma } from '@aios-pocket/db'
import { MESSAGE_SEND_JOB_RETRY_OPTIONS, messageSendQueue } from '../queue/queues.js'
import { isUniqueConstraintError } from '../pipeline/prisma-errors.js'

// Rota autenticada (o hook global de apps/api/src/app.ts cuida do JWT/tenant — nenhuma
// checagem de auth aqui). Cria o Message `queued` e enfileira o envio: a rota NUNCA
// espera o provider (regra do CLAUDE.md §4) — responde 202 assim que o job entra na fila.
export function registerMessageRoutes(app: FastifyInstance): void {
  app.post('/messages', async (req, reply) => {
    const parsed = sendMessageRequestSchema.safeParse(req.body)
    if (!parsed.success) {
      // Issues resumidas (path + mensagem) — nunca o objeto de erro do zod inteiro.
      const issues = parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
      return reply.code(400).send({ error: 'payload inválido', issues })
    }

    const { conversationId, clientMessageId, text } = parsed.data
    const { companyId } = getTenant()

    // Client tenantizado (packages/db/src/client.ts) injeta `companyId` no where — uma
    // Conversation de outra company nunca é encontrada aqui, respondendo 404 como se não
    // existisse (nenhum vazamento de "existe, mas não é sua").
    const conversation = await prisma.conversation.findFirst({ where: { id: conversationId } })
    if (!conversation) return reply.code(404).send({ error: 'conversa não encontrada' })

    let message
    try {
      message = await prisma.message.create({
        data: {
          companyId,
          conversationId: conversation.id,
          direction: 'outbound',
          state: 'queued',
          // provider = o mesmo da Conversation (CUIDADO da Task 11: o client tenantizado não
          // lê Company — a Conversation já carrega o provider certo, sem query extra).
          provider: conversation.provider,
          type: 'text',
          text,
          clientMessageId,
          correlationId: randomUUID(),
        },
      })
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err
      // Dedupe por clientMessageId (unique [companyId, clientMessageId], Task 4): request
      // duplicado — retry de rede, duplo clique do usuário — bate na unique em vez de criar
      // uma segunda linha. Relê e devolve o messageId ORIGINAL sem reenfileirar de novo (o
      // envio original já está — ou já esteve — na fila); mesmo padrão de readback por
      // P2002 usado em process-webhook.ts/resolve-customer.ts (prisma-errors.ts), fecha o
      // "202 dangling" apontado na review do Plano B.
      const existing = await prisma.message.findFirst({ where: { clientMessageId } })
      if (!existing) throw err // não deveria acontecer: é exatamente essa unique que disparou o P2002
      return reply.code(202).send({ messageId: existing.id })
    }

    try {
      await messageSendQueue.add(
        'send',
        { messageId: message.id, companyId },
        { jobId: message.id, ...MESSAGE_SEND_JOB_RETRY_OPTIONS },
      )
    } catch (err) {
      // Diferente do webhook (que sempre responde 200 — o payload cru já está arquivado,
      // ADR-0003): aqui o usuário PRECISA saber que o envio não foi confirmado agora — 500,
      // não 202 (achado IMPORTANT da re-review T11). A Message já existe `queued`, porém:
      // a varredura de reconciliação da subida do worker (queue/send-worker.ts) reenfileira
      // sozinha qualquer `queued` órfã mais velha que 5min — o pior caso é atraso, nunca
      // perda silenciosa.
      req.log.error({ err, messageId: message.id }, 'falha ao enfileirar message-send — reconciliação cobre em até 5min')
      return reply.code(500).send({ error: 'falha ao enfileirar envio' })
    }

    return reply.code(202).send({ messageId: message.id })
  })
}
