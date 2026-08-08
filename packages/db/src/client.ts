import { PrismaClient } from '@prisma/client'
import { getTenant } from './tenant-context.js'

// Whitelist de modelos sem tenant — manter mínima e justificada.
const TENANT_EXEMPT_MODELS = new Set(['RawWebhookEvent'])
// Operações cujo `where` unique não aceita composição com company_id de forma segura.
const FORBIDDEN_OPERATIONS = new Set(['findUnique', 'findUniqueOrThrow', 'update', 'delete', 'upsert'])

export function createTenantClient(base: PrismaClient) {
  return base.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (TENANT_EXEMPT_MODELS.has(model)) return query(args)
          if (FORBIDDEN_OPERATIONS.has(operation)) {
            throw new Error(
              `Operação ${operation} proibida em ${model}: use findFirst/updateMany/deleteMany com filtro de tenant`,
            )
          }
          const { companyId } = getTenant()
          const a = args as { where?: object; data?: object | object[] }
          let next: object
          if (operation === 'create') {
            next = { ...a, data: { ...(a.data as object), companyId } }
          } else if (operation === 'createMany' || operation === 'createManyAndReturn') {
            const rows = Array.isArray(a.data) ? a.data : [a.data as object]
            next = { ...a, data: rows.map((d) => ({ ...d, companyId })) }
          } else {
            next = { ...a, where: { AND: [{ companyId }, a.where ?? {}] } }
          }
          return query(next as Parameters<typeof query>[0])
        },
      },
    },
  })
}

export const prisma = createTenantClient(new PrismaClient())
