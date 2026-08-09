import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prismaUnsafe } from '@aios-pocket/db/testing'
import { buildApp } from '../src/app.js'

const app = buildApp()
let webhookToken: string | undefined
let companyId: string | undefined

beforeAll(async () => {
  const company = await prismaUnsafe.company.create({
    data: { name: `Webhook Arquivo ${Date.now()}`, activeProvider: 'evolution', providerCredentials: 'cifrado' },
  })
  webhookToken = company.webhookToken
  companyId = company.id
})

afterAll(async () => {
  if (companyId) {
    await prismaUnsafe.rawWebhookEvent.deleteMany({ where: { companyId } })
    await prismaUnsafe.company.deleteMany({ where: { id: companyId } })
  }
  await app.close()
})

describe('arquivamento de webhook (ADR-0003: payload cru nunca se perde)', () => {
  it('POST /webhooks/evolution/:token arquiva o payload cru e responde 200 rápido', async () => {
    if (!webhookToken || !companyId) throw new Error('fixture não criada')
    const payload = { event: 'messages.upsert', instance: 'aios-pocket', data: { qualquer: 'coisa' } }
    const res = await app.inject({
      method: 'POST',
      url: `/webhooks/evolution/${webhookToken}`,
      payload,
    })
    expect(res.statusCode).toBe(200)
    const archived = await prismaUnsafe.rawWebhookEvent.findFirst({ where: { companyId } })
    expect(archived?.provider).toBe('evolution')
    expect(archived?.processed).toBe(false)
    expect((archived?.payload as { event: string }).event).toBe('messages.upsert')
  })

  it('token inválido responde 404 sem arquivar', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/evolution/11111111-1111-1111-1111-111111111111',
      payload: { x: 1 },
    })
    expect(res.statusCode).toBe(404)
  })
})
