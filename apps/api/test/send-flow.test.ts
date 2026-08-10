import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest'
import { prismaUnsafe } from '@aios-pocket/db/testing'
import type { MessagingProvider } from '@aios-pocket/providers'
import { buildApp } from '../src/app.js'
import { domainEventsQueue, messageSendQueue } from '../src/queue/queues.js'
import { processRawWebhook } from '../src/pipeline/process-webhook.js'
import { markSendFailed, sendQueuedMessage } from '../src/pipeline/send-message.js'

// Mock do módulo de verificação JWT (padrão de auth-me-happy-path.test.ts): simula um JWT
// válido cujo `sub` é o authUserId da fixture criada abaixo.
vi.mock('../src/auth/verify.js')

// Provider mockado no nível do provider-factory (binding design da Task 11): nenhum teste
// aqui fala com a Evolution de verdade — providerForCompany devolve sempre este fake, que
// registra as chamadas de sendText em `sendTextCalls` para asserção.
vi.mock('../src/provider-factory.js', () => ({ providerForCompany: vi.fn() }))

const FIXTURES_DIR = join(import.meta.dirname, '..', '..', '..', 'tests', 'providers', 'fixtures', 'evolution')

const sendTextCalls: Array<{ to: string; text: string }> = []
// Substituível por teste (sucesso vs. falha do provider).
let sendTextImpl: (to: string, text: string) => Promise<{ providerMessageId: string }> = async (to, text) => {
  sendTextCalls.push({ to, text })
  return { providerMessageId: 'FAKE123' }
}

function fakeProvider(): MessagingProvider {
  return {
    sendText: (to, text) => sendTextImpl(to, text),
    sendMedia: () => {
      throw new Error('sendMedia não usado neste teste')
    },
    parseWebhook: () => null,
    getConnectionStatus: async () => 'connected',
  }
}

const app = buildApp()

let companyId: string
let userId: string
let customerId: string
let conversationId: string

let companyBId: string
let conversationBId: string

beforeAll(async () => {
  const company = await prismaUnsafe.company.create({
    data: { name: `Envio Teste ${randomUUID().slice(0, 8)}`, activeProvider: 'evolution', providerCredentials: 'cifrado-fake' },
  })
  companyId = company.id

  const authUserId = randomUUID()
  const user = await prismaUnsafe.user.create({
    data: { companyId, authUserId, name: 'Usuário Envio', email: `envio-${authUserId}@example.com` },
  })
  userId = user.id

  const customer = await prismaUnsafe.customer.create({
    data: { companyId, phoneE164: '+5511999990000', phoneOriginal: '5511999990000' },
  })
  customerId = customer.id

  const conversation = await prismaUnsafe.conversation.create({
    data: { companyId, customerId, provider: 'evolution', externalId: '5511999990000@s.whatsapp.net' },
  })
  conversationId = conversation.id

  // Company B: só para provar isolamento de tenant (conversation de outra company → 404).
  const companyB = await prismaUnsafe.company.create({
    data: { name: `Envio Teste B ${randomUUID().slice(0, 8)}`, activeProvider: 'evolution', providerCredentials: 'cifrado-fake' },
  })
  companyBId = companyB.id
  const customerB = await prismaUnsafe.customer.create({
    data: { companyId: companyBId, phoneE164: '+5511999990001', phoneOriginal: '5511999990001' },
  })
  const conversationB = await prismaUnsafe.conversation.create({
    data: { companyId: companyBId, customerId: customerB.id, provider: 'evolution', externalId: '5511999990001@s.whatsapp.net' },
  })
  conversationBId = conversationB.id

  const verify = await import('../src/auth/verify.js')
  vi.mocked(verify.verifySupabaseJwt).mockResolvedValue({ sub: authUserId })

  const factory = await import('../src/provider-factory.js')
  vi.mocked(factory.providerForCompany).mockImplementation(() => fakeProvider())
})

afterAll(async () => {
  await app.close()
  // Cleanup escopado por id (nunca deleteMany amplo) — guarda `if` porque o beforeAll
  // pode ter lançado antes de atribuir todos os ids (lição do Plano A — tenancy.test.ts).
  for (const id of [companyId, companyBId]) {
    if (!id) continue
    await prismaUnsafe.customerEvent.deleteMany({ where: { companyId: id } })
    await prismaUnsafe.message.deleteMany({ where: { companyId: id } })
    await prismaUnsafe.conversation.deleteMany({ where: { companyId: id } })
    await prismaUnsafe.customer.deleteMany({ where: { companyId: id } })
  }
  if (userId) await prismaUnsafe.user.deleteMany({ where: { id: userId } })
  if (companyId) await prismaUnsafe.company.deleteMany({ where: { id: companyId } })
  if (companyBId) await prismaUnsafe.company.deleteMany({ where: { id: companyBId } })
})

describe('POST /messages (rota autenticada — ADR-0006)', () => {
  it('payload inválido responde 400 com issues resumidas', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/messages',
      headers: { authorization: 'Bearer qualquer-token' },
      payload: { conversationId: 'não-é-uuid', text: '' },
    })
    expect(res.statusCode).toBe(400)
    const body = res.json() as { issues: Array<{ path: string; message: string }> }
    expect(body.issues.length).toBeGreaterThan(0)
  })

  it('conversation de outra company responde 404 (isolamento de tenant)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/messages',
      headers: { authorization: 'Bearer qualquer-token' },
      payload: { conversationId: conversationBId, text: 'não deveria funcionar' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('valida, cria Message queued (outbound) e enfileira `message-send` — responde 202 sem esperar o provider', async () => {
    sendTextImpl = async (to, text) => {
      sendTextCalls.push({ to, text })
      return { providerMessageId: 'FAKE123' }
    }
    const addSpy = vi.spyOn(messageSendQueue, 'add')

    const res = await app.inject({
      method: 'POST',
      url: '/messages',
      headers: { authorization: 'Bearer qualquer-token' },
      payload: { conversationId, text: 'resposta de teste do Aios Pocket' },
    })

    expect(res.statusCode).toBe(202)
    const body = res.json() as { messageId: string }
    expect(body.messageId).toBeTruthy()

    const message = await prismaUnsafe.message.findFirst({ where: { id: body.messageId } })
    expect(message?.state).toBe('queued')
    expect(message?.direction).toBe('outbound')
    expect(message?.provider).toBe('evolution')
    expect(message?.type).toBe('text')
    expect(message?.text).toBe('resposta de teste do Aios Pocket')
    expect(message?.companyId).toBe(companyId)

    expect(addSpy).toHaveBeenCalledWith(
      'send',
      { messageId: body.messageId, companyId },
      expect.objectContaining({ jobId: body.messageId, attempts: 3 }),
    )
    // sendText NUNCA é chamado síncronamente pela rota — só o worker chama, depois.
    expect(sendTextCalls).toHaveLength(0)

    addSpy.mockRestore()
  })
})

describe('sendQueuedMessage (worker `message-send` — máquina de estados, ADR-0006)', () => {
  let sentMessageId: string

  beforeAll(async () => {
    const message = await prismaUnsafe.message.create({
      data: {
        companyId,
        conversationId,
        direction: 'outbound',
        state: 'queued',
        provider: 'evolution',
        type: 'text',
        text: 'resposta de teste do Aios Pocket',
        correlationId: randomUUID(),
      },
    })
    sentMessageId = message.id
  })

  it('processa o job: Message vai a sent com providerMessageId do provider, grava timeline e publica MessageSent', async () => {
    sendTextImpl = async (to, text) => {
      sendTextCalls.push({ to, text })
      return { providerMessageId: 'FAKE123' }
    }
    const callsBefore = sendTextCalls.length
    const addSpy = vi.spyOn(domainEventsQueue, 'add')

    await sendQueuedMessage(sentMessageId, companyId, 0)

    const message = await prismaUnsafe.message.findFirst({ where: { id: sentMessageId } })
    expect(message?.state).toBe('sent')
    expect(message?.providerMessageId).toBe('FAKE123')
    expect(sendTextCalls.length).toBe(callsBefore + 1)
    expect(sendTextCalls.at(-1)).toEqual({ to: '5511999990000', text: 'resposta de teste do Aios Pocket' })

    const timeline = await prismaUnsafe.customerEvent.findFirst({
      where: { customerId, type: 'message_sent', correlationId: message?.correlationId },
    })
    expect(timeline).not.toBeNull()

    const published = addSpy.mock.calls.some((call) => {
      const data = call[1] as { name?: string; correlationId?: string } | undefined
      return data?.name === 'MessageSent' && data.correlationId === message?.correlationId
    })
    expect(published).toBe(true)

    addSpy.mockRestore()
  })

  it('job duplicado (reexecução do mesmo job, já sent): no-op — sem novo sendText, sem duplicar timeline/evento', async () => {
    const callsBefore = sendTextCalls.length
    const timelineCountBefore = await prismaUnsafe.customerEvent.count({
      where: { customerId, type: 'message_sent' },
    })
    const addSpy = vi.spyOn(domainEventsQueue, 'add')

    await sendQueuedMessage(sentMessageId, companyId, 0) // attemptsMade=0 simula reexecução do MESMO job

    expect(sendTextCalls.length).toBe(callsBefore)
    const timelineCountAfter = await prismaUnsafe.customerEvent.count({
      where: { customerId, type: 'message_sent' },
    })
    expect(timelineCountAfter).toBe(timelineCountBefore)
    expect(addSpy).not.toHaveBeenCalled()

    addSpy.mockRestore()
  })
})

describe('falha do provider — nunca silenciosa (carry-over T7 / DLQ do send)', () => {
  it('provider lança em todas as tentativas: sendQueuedMessage propaga (BullMQ re-tentaria); após esgotamento, markSendFailed grava failed + failReason + timeline', async () => {
    sendTextImpl = async () => {
      throw new Error('evolution indisponível (simulado)')
    }

    const message = await prismaUnsafe.message.create({
      data: {
        companyId,
        conversationId,
        direction: 'outbound',
        state: 'queued',
        provider: 'evolution',
        type: 'text',
        text: 'vai falhar',
        correlationId: randomUUID(),
      },
    })

    // 1ª tentativa: propaga o erro do provider — nunca falha silenciosa, o BullMQ real
    // tentaria de novo (attempts: 3, ver queue/queues.ts do enqueue na rota).
    await expect(sendQueuedMessage(message.id, companyId, 0)).rejects.toThrow('evolution indisponível (simulado)')

    const stillSending = await prismaUnsafe.message.findFirst({ where: { id: message.id } })
    expect(stillSending?.state).toBe('sending') // em tentativa; não terminal por conta própria

    // Simula o handler `worker.on('failed', ...)` (queue/send-worker.ts) depois de
    // esgotadas as 3 tentativas — chamado diretamente (carry-over T7: "simular chamando o
    // failed-handler diretamente OU worker real com attempts baixos").
    await markSendFailed(message.id, companyId, 'evolution indisponível (simulado)')

    const failed = await prismaUnsafe.message.findFirst({ where: { id: message.id } })
    expect(failed?.state).toBe('failed')
    expect(failed?.failReason).toBe('evolution indisponível (simulado)')

    const timeline = await prismaUnsafe.customerEvent.findFirst({
      where: { customerId, type: 'message_send_failed', correlationId: failed?.correlationId },
    })
    expect(timeline).not.toBeNull()
  })
})

describe('guarda do eco fromMe (OBRIGAÇÃO da re-review T10 / Task 11)', () => {
  it('eco fromMe do PRÓPRIO envio (mesmo providerMessageId, direction outbound) é reconhecido e ignorado — zero novas rows/publicações', async () => {
    await prismaUnsafe.message.create({
      data: {
        companyId,
        conversationId,
        direction: 'outbound',
        state: 'sent',
        provider: 'evolution',
        providerMessageId: '3AA97459A5FEC29DF448', // mesmo id da fixture incoming_from_me-1
        fromMe: true,
        type: 'text',
        text: 'já enviado por nós',
        correlationId: randomUUID(),
      },
    })

    const messagesBefore = await prismaUnsafe.message.count({ where: { companyId } })
    const timelineBefore = await prismaUnsafe.customerEvent.count({ where: { companyId } })
    const addSpy = vi.spyOn(domainEventsQueue, 'add')

    const fixture = JSON.parse(readFileSync(join(FIXTURES_DIR, 'incoming_from_me-1.json'), 'utf8')) as object
    const raw = await prismaUnsafe.rawWebhookEvent.create({
      data: { provider: 'evolution', companyId, payload: fixture },
    })

    await processRawWebhook(raw.id)

    const after = await prismaUnsafe.rawWebhookEvent.findUnique({ where: { id: raw.id } })
    expect(after?.processed).toBe(true)
    expect(after?.error).toBe('echo do próprio envio')

    const messagesAfter = await prismaUnsafe.message.count({ where: { companyId } })
    expect(messagesAfter).toBe(messagesBefore) // nenhuma nova Message

    const timelineAfter = await prismaUnsafe.customerEvent.count({ where: { companyId } })
    expect(timelineAfter).toBe(timelineBefore) // nenhuma nova timeline

    expect(addSpy).not.toHaveBeenCalled() // nenhum MessageReceived publicado

    addSpy.mockRestore()
  })
})
