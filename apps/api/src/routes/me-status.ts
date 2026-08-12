import type { FastifyInstance } from 'fastify'
import { companiesRepo, getTenant } from '@aios-pocket/db'

// Rota autenticada — badge de conexão da instância (Task 5, Plano C): consumer visível
// do estado de conexão (poll de 30s na UI v1; o evento ConnectionChanged segue publicado
// para uso futuro — ADR-0003, "instância morta em silêncio é o pior modo de falha").
//
// companiesRepo.findById é PRÉ-TENANT (packages/db/src/repositories/companies.ts — Company
// é a raiz do tenant, sem coluna company_id para o client tenantizado filtrar). Seguro aqui
// porque o `id` usado vem do TenantContext (getTenant().companyId), NUNCA de input do
// cliente — mesmo padrão já sancionado em outros pontos do pipeline.
export function registerMeStatusRoutes(app: FastifyInstance): void {
  app.get('/me/status', async (_req, reply) => {
    const { companyId } = getTenant()
    const company = await companiesRepo.findById(companyId)
    if (!company) return reply.code(404).send({ error: 'company não encontrada' })
    return { companyId, connectionState: company.connectionState }
  })
}
