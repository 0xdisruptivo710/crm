import { prismaUnsafe } from '../unsafe.js'

// Pré-tenant: a autenticação resolve o tenant a partir do usuário.
// Este é o ÚNICO lookup global permitido fora de seed/testes.
export function resolveUserByAuthId(authUserId: string) {
  return prismaUnsafe.user.findUnique({ where: { authUserId }, include: { company: true } })
}
