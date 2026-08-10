import { prisma } from '../client.js'
import { getTenant } from '../tenant-context.js'

// Repository padrão: types do Prisma exigem companyId explícito no create;
// a extension revalida/injeta em runtime como cinto de segurança.
export const customersRepo = {
  findByPhone(phoneE164: string) {
    return prisma.customer.findFirst({ where: { phoneE164 } })
  },
  // Recebe as candidatas de `phoneMatchCandidates` (regra do 9º dígito BR, Domain.md):
  // qualquer uma batendo é o mesmo cliente.
  findByPhoneCandidates(candidates: string[]) {
    return prisma.customer.findFirst({ where: { phoneE164: { in: candidates } } })
  },
  create(data: { phoneE164: string; phoneOriginal: string; name?: string }) {
    return prisma.customer.create({ data: { ...data, companyId: getTenant().companyId } })
  },
  list() {
    return prisma.customer.findMany({ orderBy: { createdAt: 'desc' } })
  },
}
