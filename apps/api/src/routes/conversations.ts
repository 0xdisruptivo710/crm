import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { conversationsRepo, messagesRepo, prisma } from '@aios-pocket/db'

const DEFAULT_CONVERSATIONS_LIMIT = 50
const DEFAULT_MESSAGES_LIMIT = 100
// Teto de segurança contra query maliciosa/errada — nenhuma leitura sem LIMIT.
const MAX_LIMIT = 500

// Query só de leitura (limit), usada nestas DUAS rotas locais — não compartilhada com o
// web (a UI sempre pede os defaults do spec, T6-T8), então não faz sentido colocar em
// packages/contracts por enquanto (regra do CLAUDE.md §4: "nunca adicionar abstração sem
// necessidade comprovada por pelo menos dois usos reais" fora deste arquivo).
const limitQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(MAX_LIMIT).optional(),
})

// Rotas autenticadas (o hook global de apps/api/src/app.ts cuida do JWT/tenant — nenhuma
// checagem de auth aqui). Só leitura: nenhuma regra de negócio, mapeamento direto das
// tabelas de domínio para os contratos de resposta (conversationSummarySchema/messageViewSchema).
export function registerConversationRoutes(app: FastifyInstance): void {
  app.get('/conversations', async (req, reply) => {
    const parsed = limitQuerySchema.safeParse(req.query)
    if (!parsed.success) return reply.code(400).send({ error: 'query inválida' })
    const limit = parsed.data.limit ?? DEFAULT_CONVERSATIONS_LIMIT

    const conversations = await conversationsRepo.listWithCustomer(limit)
    return conversations.map((conversation) => ({
      id: conversation.id,
      provider: conversation.provider,
      status: conversation.status,
      lastMessageAt: conversation.lastMessageAt,
      customer: {
        id: conversation.customer.id,
        phoneE164: conversation.customer.phoneE164,
        name: conversation.customer.name,
      },
    }))
  })

  app.get<{ Params: { id: string } }>('/conversations/:id/messages', async (req, reply) => {
    // Valida o formato do :id ANTES de bater no banco — um id malformado (não-uuid) faria
    // o Postgres rejeitar a query com erro de tipo (500), não um 404 limpo.
    const idCheck = z.uuid().safeParse(req.params.id)
    if (!idCheck.success) return reply.code(400).send({ error: 'id inválido' })

    const parsed = limitQuerySchema.safeParse(req.query)
    if (!parsed.success) return reply.code(400).send({ error: 'query inválida' })
    const limit = parsed.data.limit ?? DEFAULT_MESSAGES_LIMIT

    // Client tenantizado (packages/db/src/client.ts) injeta `companyId` no where — uma
    // Conversation de outra company nunca é encontrada aqui, respondendo 404 como se não
    // existisse (mesmo padrão de POST /messages em apps/api/src/routes/messages.ts).
    const conversation = await prisma.conversation.findFirst({ where: { id: idCheck.data } })
    if (!conversation) return reply.code(404).send({ error: 'conversa não encontrada' })

    const messages = await messagesRepo.listByConversation(conversation.id, limit)
    return messages.map((message) => ({
      id: message.id,
      direction: message.direction,
      state: message.state,
      type: message.type,
      text: message.text,
      mediaUrl: message.mediaUrl,
      mediaMimeType: message.mediaMimeType,
      fromMe: message.fromMe,
      providerMessageId: message.providerMessageId,
      failReason: message.failReason,
      createdAt: message.createdAt,
    }))
  })
}
