import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { conversationSummarySchema, messageViewSchema } from '@aios-pocket/contracts'
import { prismaUnsafe } from '@aios-pocket/db/testing'
import { z } from 'zod'
import { buildApp } from '../src/app.js'

// Mock do módulo de verificação JWT (padrão de auth-me-happy-path.test.ts/send-flow.test.ts):
// simula um JWT válido cujo `sub` é o authUserId da fixture criada abaixo.
vi.mock('../src/auth/verify.js')

const app = buildApp()

// Fixtures da company A (dona do usuário autenticado nestes testes) e da company B (só
// para provar isolamento de tenant — 404 cross-tenant).
let companyId: string
let userId: string
let customerId: string

// Três conversas com lastMessageAt distintos — prova a ordenação `lastMessageAt desc`.
let conversationOldId: string
let conversationMidId: string
let conversationNewId: string

// Três mensagens na conversa "new" — prova a ordenação `createdAt asc`.
let messageOldestId: string
let messageMiddleId: string
let messageNewestId: string

let companyBId: string
let conversationBId: string

beforeAll(async () => {
  const company = await prismaUnsafe.company.create({
    data: { name: `Leitura Teste ${randomUUID().slice(0, 8)}`, activeProvider: 'evolution', providerCredentials: 'cifrado-fake' },
  })
  companyId = company.id

  const authUserId = randomUUID()
  const user = await prismaUnsafe.user.create({
    data: { companyId, authUserId, name: 'Usuário Leitura', email: `leitura-${authUserId}@example.com` },
  })
  userId = user.id

  const customer = await prismaUnsafe.customer.create({
    data: { companyId, phoneE164: '+5511999990010', phoneOriginal: '5511999990010', name: 'Cliente Teste' },
  })
  customerId = customer.id

  const now = Date.now()

  const conversationOld = await prismaUnsafe.conversation.create({
    data: {
      companyId,
      customerId,
      provider: 'evolution',
      externalId: 'conv-old@s.whatsapp.net',
      lastMessageAt: new Date(now - 3 * 60 * 60 * 1000),
    },
  })
  conversationOldId = conversationOld.id

  const conversationMid = await prismaUnsafe.conversation.create({
    data: {
      companyId,
      customerId,
      provider: 'evolution',
      externalId: 'conv-mid@s.whatsapp.net',
      lastMessageAt: new Date(now - 2 * 60 * 60 * 1000),
    },
  })
  conversationMidId = conversationMid.id

  const conversationNew = await prismaUnsafe.conversation.create({
    data: {
      companyId,
      customerId,
      provider: 'evolution',
      externalId: 'conv-new@s.whatsapp.net',
      lastMessageAt: new Date(now - 1 * 60 * 60 * 1000),
    },
  })
  conversationNewId = conversationNew.id

  const messageOldest = await prismaUnsafe.message.create({
    data: {
      companyId,
      conversationId: conversationNewId,
      direction: 'inbound',
      state: 'received',
      provider: 'evolution',
      type: 'text',
      text: 'mensagem mais antiga',
      fromMe: false,
      correlationId: randomUUID(),
      createdAt: new Date(now - 30 * 60 * 1000),
    },
  })
  messageOldestId = messageOldest.id

  const messageMiddle = await prismaUnsafe.message.create({
    data: {
      companyId,
      conversationId: conversationNewId,
      direction: 'outbound',
      state: 'sent',
      provider: 'evolution',
      type: 'text',
      text: 'mensagem do meio',
      fromMe: false,
      correlationId: randomUUID(),
      createdAt: new Date(now - 20 * 60 * 1000),
    },
  })
  messageMiddleId = messageMiddle.id

  const messageNewest = await prismaUnsafe.message.create({
    data: {
      companyId,
      conversationId: conversationNewId,
      direction: 'inbound',
      state: 'received',
      provider: 'evolution',
      type: 'text',
      text: 'mensagem mais recente',
      fromMe: false,
      correlationId: randomUUID(),
      createdAt: new Date(now - 10 * 60 * 1000),
    },
  })
  messageNewestId = messageNewest.id

  // Company B: só para provar isolamento de tenant (conversa de outra company → 404/ausente).
  const companyB = await prismaUnsafe.company.create({
    data: { name: `Leitura Teste B ${randomUUID().slice(0, 8)}`, activeProvider: 'evolution', providerCredentials: 'cifrado-fake' },
  })
  companyBId = companyB.id
  const customerB = await prismaUnsafe.customer.create({
    data: { companyId: companyBId, phoneE164: '+5511999990011', phoneOriginal: '5511999990011' },
  })
  const conversationB = await prismaUnsafe.conversation.create({
    data: { companyId: companyBId, customerId: customerB.id, provider: 'evolution', externalId: 'conv-b@s.whatsapp.net' },
  })
  conversationBId = conversationB.id

  const verify = await import('../src/auth/verify.js')
  vi.mocked(verify.verifySupabaseJwt).mockResolvedValue({ sub: authUserId })
})

afterAll(async () => {
  await app.close()
  // Cleanup escopado por id (nunca deleteMany amplo) — guarda `if` (lição do Plano A).
  for (const id of [companyId, companyBId]) {
    if (!id) continue
    await prismaUnsafe.message.deleteMany({ where: { companyId: id } })
    await prismaUnsafe.conversation.deleteMany({ where: { companyId: id } })
    await prismaUnsafe.customer.deleteMany({ where: { companyId: id } })
  }
  if (userId) await prismaUnsafe.user.deleteMany({ where: { id: userId } })
  if (companyId) await prismaUnsafe.company.deleteMany({ where: { id: companyId } })
  if (companyBId) await prismaUnsafe.company.deleteMany({ where: { id: companyBId } })
})

describe('GET /conversations (rota autenticada)', () => {
  it('sem token responde 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/conversations' })
    expect(res.statusCode).toBe(401)
  })

  it('200: lista por lastMessageAt desc, customer embutido, cada item passa em conversationSummarySchema', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/conversations',
      headers: { authorization: 'Bearer qualquer-token' },
    })
    expect(res.statusCode).toBe(200)

    const body = z.array(conversationSummarySchema).parse(res.json())

    // Só as 3 conversas da company A — nada da company B (isolamento de tenant).
    const ids = body.map((c) => c.id)
    expect(ids).not.toContain(conversationBId)

    // Ordenação lastMessageAt desc: new, mid, old.
    expect(ids.slice(0, 3)).toEqual([conversationNewId, conversationMidId, conversationOldId])

    const first = body.find((c) => c.id === conversationNewId)
    expect(first?.provider).toBe('evolution')
    expect(first?.status).toBe('open')
    expect(first?.customer).toEqual({ id: customerId, phoneE164: '+5511999990010', name: 'Cliente Teste' })
  })

  it('limite: ?limit=2 devolve só as 2 conversas mais recentes', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/conversations?limit=2',
      headers: { authorization: 'Bearer qualquer-token' },
    })
    expect(res.statusCode).toBe(200)
    const body = z.array(conversationSummarySchema).parse(res.json())
    expect(body).toHaveLength(2)
    expect(body.map((c) => c.id)).toEqual([conversationNewId, conversationMidId])
  })
})

describe('GET /conversations/:id/messages (rota autenticada)', () => {
  it('sem token responde 401', async () => {
    const res = await app.inject({ method: 'GET', url: `/conversations/${conversationNewId}/messages` })
    expect(res.statusCode).toBe(401)
  })

  it('200: mensagens createdAt asc, cada item passa em messageViewSchema', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/conversations/${conversationNewId}/messages`,
      headers: { authorization: 'Bearer qualquer-token' },
    })
    expect(res.statusCode).toBe(200)

    const body = z.array(messageViewSchema).parse(res.json())
    expect(body.map((m) => m.id)).toEqual([messageOldestId, messageMiddleId, messageNewestId])

    const middle = body.find((m) => m.id === messageMiddleId)
    expect(middle?.direction).toBe('outbound')
    expect(middle?.state).toBe('sent')
    expect(middle?.type).toBe('text')
    expect(middle?.text).toBe('mensagem do meio')
    expect(middle?.fromMe).toBe(false)
    // failReason atravessa a rota (Plano D, T11 — carry-over): null quando não há falha.
    // A forma com motivo preenchido é coberta pelos casos do messageViewSchema em
    // packages/contracts/test/api.test.ts.
    expect(middle?.failReason).toBeNull()
  })

  it('limite: ?limit=2 devolve as 2 mensagens mais antigas (createdAt asc)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/conversations/${conversationNewId}/messages?limit=2`,
      headers: { authorization: 'Bearer qualquer-token' },
    })
    expect(res.statusCode).toBe(200)
    const body = z.array(messageViewSchema).parse(res.json())
    expect(body.map((m) => m.id)).toEqual([messageOldestId, messageMiddleId])
  })

  it('conversa de outra company responde 404 (isolamento de tenant)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/conversations/${conversationBId}/messages`,
      headers: { authorization: 'Bearer qualquer-token' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('conversa inexistente (uuid válido, nunca criado) responde 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/conversations/${randomUUID()}/messages`,
      headers: { authorization: 'Bearer qualquer-token' },
    })
    expect(res.statusCode).toBe(404)
  })

  it(':id malformado (não-uuid) responde 400, nunca 500', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/conversations/não-é-um-uuid/messages',
      headers: { authorization: 'Bearer qualquer-token' },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('GET /me/status (rota autenticada)', () => {
  it('sem token responde 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/me/status' })
    expect(res.statusCode).toBe(401)
  })

  it('200: { companyId, connectionState } — default disconnected (companiesRepo.findById)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/me/status',
      headers: { authorization: 'Bearer qualquer-token' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ companyId, connectionState: 'disconnected' })
  })

  it('reflete o connectionState atual da company (badge — pior modo de falha visível)', async () => {
    await prismaUnsafe.company.update({ where: { id: companyId }, data: { connectionState: 'connected' } })
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/me/status',
        headers: { authorization: 'Bearer qualquer-token' },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ companyId, connectionState: 'connected' })
    } finally {
      await prismaUnsafe.company.update({ where: { id: companyId }, data: { connectionState: 'disconnected' } })
    }
  })
})
