import { prisma } from '../client.js'

// Repository tenant-safe (client de packages/db/src/client.ts injeta company_id —
// ADR-0001). Só findMany aqui (leitura) — usado por GET /conversations (Task 5, Plano C).
export const conversationsRepo = {
  // customer embutido (select mínimo) para a UI não precisar de round-trip extra por
  // conversa (contrato: conversationSummarySchema em packages/contracts/src/api.ts).
  listWithCustomer(limit: number) {
    return prisma.conversation.findMany({
      take: limit,
      orderBy: { lastMessageAt: 'desc' },
      include: { customer: { select: { id: true, phoneE164: true, name: true } } },
    })
  },
}
