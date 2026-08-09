import { prismaUnsafe } from '../unsafe.js'

// PRÉ-TENANT sancionado (como resolveUserByAuthId): o webhook autentica a company
// pelo token da URL — não existe JWT/tenant antes dessa resolução (ADR-0003).
export const companiesRepo = {
  findByWebhookToken(webhookToken: string) {
    return prismaUnsafe.company.findUnique({ where: { webhookToken } })
  },
  findById(id: string) {
    return prismaUnsafe.company.findUnique({ where: { id } })
  },
}
