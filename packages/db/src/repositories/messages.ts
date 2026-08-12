import { prisma } from '../client.js'
import { prismaUnsafe } from '../unsafe.js'

// PRÉ-TENANT sancionado (como companiesRepo, packages/db/src/repositories/companies.ts):
// a varredura de reconciliação do worker de envio (apps/api/src/queue/send-worker.ts,
// achado CRÍTICO da re-review T11) roda na subida do processo, fora de qualquer
// request/job — sem TenantContext — e precisa achar Messages presas ATRAVÉS de todas as
// companies. Cada linha devolvida aqui é só um PONTEIRO (id + companyId); toda mutação de
// verdade acontece depois, de dentro de um runWithTenant (apps/api/src/pipeline/send-message.ts).
//
// Filtra por `createdAt` (não existe coluna de "última transição de estado" no schema
// hoje) — aproximação aceita: a transição queued→sending acontece segundos depois da
// criação, então "criada há mais de N minutos" é um proxy razoável de "presa há mais de N
// minutos" sem exigir migração de schema para esta rodada de fix.
const STUCK_ROW_LIMIT = 500

export const messagesRepo = {
  // `companyId` opcional (fold da re-review T11 round 2): a chamada de PRODUÇÃO (subida
  // do worker, varredura periódica) nunca passa filtro — precisa varrer TODAS as
  // companies. Testes passam `companyId` para escopar a varredura à própria fixture,
  // protegendo o banco de dev compartilhado de efeitos colaterais entre suítes.
  findStuckQueued(olderThan: Date, companyId?: string) {
    return prismaUnsafe.message.findMany({
      where: { state: 'queued', createdAt: { lt: olderThan }, ...(companyId ? { companyId } : {}) },
      select: { id: true, companyId: true },
      take: STUCK_ROW_LIMIT,
    })
  },
  findStuckSending(olderThan: Date, companyId?: string) {
    return prismaUnsafe.message.findMany({
      where: { state: 'sending', createdAt: { lt: olderThan }, ...(companyId ? { companyId } : {}) },
      select: { id: true, companyId: true },
      take: STUCK_ROW_LIMIT,
    })
  },
  // Tenant-safe (client `prisma`, não `prismaUnsafe`): usado por GET /conversations/:id/messages
  // (Task 5, Plano C). A rota já validou que a Conversation pertence ao tenant atual
  // (mesmo padrão de POST /messages em apps/api/src/routes/messages.ts) — aqui só lista.
  listByConversation(conversationId: string, limit: number) {
    return prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
      take: limit,
    })
  },
}
