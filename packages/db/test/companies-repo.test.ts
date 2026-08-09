import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prismaUnsafe } from '../src/unsafe.js'
import { companiesRepo } from '../src/repositories/companies.js'

let token = ''
let companyId = ''

beforeAll(async () => {
  const company = await prismaUnsafe.company.create({
    data: { name: `Webhook Teste ${Date.now()}`, activeProvider: 'evolution', providerCredentials: 'cifrado' },
  })
  token = company.webhookToken
  companyId = company.id
})

afterAll(async () => {
  // Guard por id (Plano A): nunca um deleteMany desacompanhado de filtro.
  if (companyId) {
    await prismaUnsafe.company.deleteMany({ where: { id: companyId } })
  }
})

describe('companiesRepo (pré-tenant: webhooks autenticam por token)', () => {
  it('resolve company por webhook token', async () => {
    const found = await companiesRepo.findByWebhookToken(token)
    expect(found?.id).toBe(companyId)
  })
  it('token desconhecido retorna null', async () => {
    expect(await companiesRepo.findByWebhookToken('11111111-1111-1111-1111-111111111111')).toBeNull()
  })
})
