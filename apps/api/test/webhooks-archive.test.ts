import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { prismaUnsafe } from '@aios-pocket/db/testing'
import { buildApp } from '../src/app.js'
import { webhookProcessingQueue } from '../src/queue/queues.js'

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

afterEach(() => {
  vi.restoreAllMocks()
})

afterAll(async () => {
  if (companyId) {
    await prismaUnsafe.rawWebhookEvent.deleteMany({ where: { companyId } })
    await prismaUnsafe.company.deleteMany({ where: { id: companyId } })
  }
  await app.close()
})

// Busca a linha arquivada mais recente para a company — os testes deste arquivo rodam
// sequencialmente (padrão do Vitest, sem `concurrent`), então "a mais recente" identifica
// sem ambiguidade a linha criada pela requisição que acabou de rodar.
function findLastArchived() {
  return prismaUnsafe.rawWebhookEvent.findFirst({
    where: { companyId },
    orderBy: { receivedAt: 'desc' },
  })
}

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

  it('body JSON malformado arquiva o texto cru e responde 200 (nunca 4xx do parser)', async () => {
    if (!webhookToken) throw new Error('fixture não criada')
    const res = await app.inject({
      method: 'POST',
      url: `/webhooks/evolution/${webhookToken}`,
      payload: '{ isto não é json válido',
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(200)
    const archived = await findLastArchived()
    expect(archived).not.toBeNull()
    const stored = archived?.payload as { raw_text: string; parse_error: boolean }
    expect(stored.parse_error).toBe(true)
    expect(stored.raw_text).toContain('isto não é json válido')
  })

  it('body vazio arquiva e responde 200 (nunca 4xx do parser)', async () => {
    if (!webhookToken) throw new Error('fixture não criada')
    const res = await app.inject({
      method: 'POST',
      url: `/webhooks/evolution/${webhookToken}`,
      payload: '',
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(200)
    const archived = await findLastArchived()
    expect(archived).not.toBeNull()
    expect((archived?.payload as { empty_body: boolean }).empty_body).toBe(true)
  })

  it('body sem content-type (bytes crus) arquiva e responde 200', async () => {
    if (!webhookToken) throw new Error('fixture não criada')
    const res = await app.inject({
      method: 'POST',
      url: `/webhooks/evolution/${webhookToken}`,
      payload: Buffer.from('bytes crus sem content-type'),
    })
    expect(res.statusCode).toBe(200)
    const archived = await findLastArchived()
    expect(archived).not.toBeNull()
  })

  it('falha ao enfileirar não derruba a resposta: arquiva e ainda responde 200', async () => {
    if (!webhookToken) throw new Error('fixture não criada')
    vi.spyOn(webhookProcessingQueue, 'add').mockRejectedValueOnce(new Error('redis fora do ar'))
    const payload = { event: 'messages.upsert', instance: 'aios-pocket', data: { falha: 'fila' } }
    const res = await app.inject({
      method: 'POST',
      url: `/webhooks/evolution/${webhookToken}`,
      payload,
    })
    expect(res.statusCode).toBe(200)
    const archived = await findLastArchived()
    expect(archived).not.toBeNull()
    expect((archived?.payload as { data: { falha: string } }).data.falha).toBe('fila')
  })
})
