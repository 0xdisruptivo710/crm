import type { ConnectionState } from '@prisma/client'
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
  // PRÉ-TENANT sancionado por outro motivo: Company é a RAIZ do tenant, não tem coluna
  // company_id — a extension de tenancy (createTenantClient) não tem o que filtrar aqui
  // (ela injeta `where: { companyId }`, inexistente neste model). Usa prismaUnsafe e
  // filtra pelo próprio id, como as leituras acima. Chamado de dentro do pipeline (Task 10)
  // já dentro de um runWithTenant — o companyId do contexto é usado como `id`, não como filtro.
  updateConnectionState(id: string, state: ConnectionState) {
    return prismaUnsafe.company.update({ where: { id }, data: { connectionState: state } })
  },
}
