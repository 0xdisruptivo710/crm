import type { PrismaClient } from '@prisma/client'
import { getTenant } from './tenant-context.js'
import { prismaUnsafe } from './unsafe.js'

// Whitelist de modelos sem tenant — manter mínima e justificada.
const TENANT_EXEMPT_MODELS = new Set(['RawWebhookEvent'])
// Operações cujo `where` unique não aceita composição com company_id de forma segura.
const FORBIDDEN_OPERATIONS = new Set(['findUnique', 'findUniqueOrThrow', 'update', 'delete', 'upsert'])

// Espelho DE TIPO do que a extension bloqueia em RUNTIME (polimento do carry-over):
// chamada proibida vira erro de compilação, não só throw. NUNCA bloquear aqui algo que o
// runtime permite — os dois conjuntos abaixo replicam exatamente os guards do handler.
type RawOperationKeys = '$queryRaw' | '$queryRawUnsafe' | '$executeRaw' | '$executeRawUnsafe'
type ForbiddenOperationKeys = 'findUnique' | 'findUniqueOrThrow' | 'update' | 'delete' | 'upsert'
// Delegates dos modelos isentos (espelha TENANT_EXEMPT_MODELS acima — MANTER EM SINCRONIA):
// no runtime a isenção retorna ANTES do check de operações proibidas, então nesses modelos
// findUnique/update etc. são permitidos — o tipo precisa permitir também.
type TenantExemptDelegates = 'rawWebhookEvent'
// Propriedades $-prefixadas restantes ($transaction, $connect...) passam intactas —
// Omit sobre um tipo-função destruiria a call signature.
type TenantSafe<C> = {
  [K in Exclude<keyof C, RawOperationKeys>]: K extends `$${string}` | TenantExemptDelegates
    ? C[K]
    : Omit<C[K], ForbiddenOperationKeys>
}

export function createTenantClient(base: PrismaClient) {
  const extended = base.$extends({
    query: {
      // Handler no nível do client (não dentro de $allModels): esse nível intercepta
      // TAMBÉM as operações "raw" ($queryRaw/$queryRawUnsafe/$executeRaw/$executeRawUnsafe),
      // que não pertencem a nenhum model — nelas `model` vem `undefined`. Se ficássemos só
      // em $allModels.$allOperations (como na primeira versão), essas operações passavam
      // direto pela extension sem qualquer filtro de tenant, silenciosamente.
      async $allOperations({ model, operation, args, query }) {
        if (model === undefined) {
          throw new Error(
            'Operações raw são proibidas no client tenantizado — use repositories (ADR-0001)',
          )
        }
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
  })
  return extended as TenantSafe<typeof extended>
}

export const prisma = createTenantClient(prismaUnsafe)
