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
  findStuckQueued(olderThan: Date) {
    return prismaUnsafe.message.findMany({
      where: { state: 'queued', createdAt: { lt: olderThan } },
      select: { id: true, companyId: true },
      take: STUCK_ROW_LIMIT,
    })
  },
  findStuckSending(olderThan: Date) {
    return prismaUnsafe.message.findMany({
      where: { state: 'sending', createdAt: { lt: olderThan } },
      select: { id: true, companyId: true },
      take: STUCK_ROW_LIMIT,
    })
  },
}
