import { beforeAll, describe, expect, it } from 'vitest'
import { prismaUnsafe } from '../src/unsafe.js'
import { prisma } from '../src/client.js'
import { runWithTenant } from '../src/tenant-context.js'
import { customersRepo } from '../src/repositories/customers.js'

let companyA = ''
let companyB = ''

beforeAll(async () => {
  await prismaUnsafe.message.deleteMany()
  await prismaUnsafe.customerEvent.deleteMany()
  await prismaUnsafe.conversation.deleteMany()
  await prismaUnsafe.customer.deleteMany()
  await prismaUnsafe.user.deleteMany()
  await prismaUnsafe.company.deleteMany()
  const a = await prismaUnsafe.company.create({
    data: { name: 'Empresa A', activeProvider: 'evolution', providerCredentials: 'cifrado' },
  })
  const b = await prismaUnsafe.company.create({
    data: { name: 'Empresa B', activeProvider: 'zapi', providerCredentials: 'cifrado' },
  })
  companyA = a.id
  companyB = b.id
  await prismaUnsafe.customer.create({
    data: { companyId: companyA, phoneE164: '+5511999990000', phoneOriginal: '5511999990000' },
  })
  await prismaUnsafe.customer.create({
    data: { companyId: companyB, phoneE164: '+5511999990000', phoneOriginal: '5511999990000' },
  })
})

describe('tenancy por aplicação (ADR-0001)', () => {
  it('leituras enxergam apenas o tenant do contexto', async () => {
    const rows = await runWithTenant({ companyId: companyA }, () => customersRepo.list())
    expect(rows).toHaveLength(1)
    expect(rows[0]?.companyId).toBe(companyA)
  })

  it('criação injeta o company_id do contexto', async () => {
    const created = await runWithTenant({ companyId: companyA }, () =>
      customersRepo.create({ phoneE164: '+5511888880000', phoneOriginal: '5511888880000' }),
    )
    expect(created.companyId).toBe(companyA)
  })

  it('lança erro sem TenantContext', async () => {
    await expect(customersRepo.list()).rejects.toThrow('TenantContext')
  })

  it('proíbe operações que não aceitam filtro de tenant', async () => {
    await expect(
      runWithTenant({ companyId: companyA }, () =>
        prisma.customer.findUnique({ where: { id: companyA } }),
      ),
    ).rejects.toThrow('proibida')
  })
})
