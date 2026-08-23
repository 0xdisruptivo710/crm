import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Job } from 'bullmq'
import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest'
import { prismaUnsafe } from '@aios-pocket/db/testing'
import type { MessagingProvider } from '@aios-pocket/providers'
import { buildApp } from '../src/app.js'
import { domainEventsQueue, messageSendQueue } from '../src/queue/queues.js'
import { processRawWebhook } from '../src/pipeline/process-webhook.js'
import { markSendFailed, sendQueuedMessage } from '../src/pipeline/send-message.js'
import { handleSendFailed, reconcileStuckMessages, startSendWorker } from '../src/queue/send-worker.js'
import { assertTestRedis } from './redis-guard.js'

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

// Poll robusto contra a latência variável do Postgres remoto de dev (achado da re-review
// T11 round 2: um sleep fixo se mostrou frágil esperando o handler `failed`, fire-and-
// forget, terminar sua cadeia de escritas NÃO transacional — updateMany de estado, depois
// findFirst/findFirst/create da timeline, cada um um round-trip separado). Usado só no
// teste de integração real Queue+Worker, onde não há como `await` diretamente o handler
// interno do worker. Genérico: espera qualquer condição, não só o estado da Message —
// usado tanto para o estado quanto (separadamente, depois) para a timeline, porque as
// duas escritas não são atômicas entre si.
async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 8000): Promise<T | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const result = await fn()
    if (result !== null || Date.now() > deadline) return result
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

function createMessage(overrides: { state?: 'queued' | 'sending'; text?: string } = {}) {
  return prismaUnsafe.message.create({
    data: {
      companyId,
      conversationId,
      direction: 'outbound',
      state: overrides.state ?? 'queued',
      provider: 'evolution',
      type: 'text',
      text: overrides.text ?? 'mensagem de teste',
      correlationId: randomUUID(),
    },
  })
}

const app = buildApp()

let companyId: string
let userId: string
let customerId: string
let conversationId: string

let companyBId: string
let conversationBId: string

beforeAll(async () => {
  // Antes de qualquer uso da fila real (startSendWorker, messageSendQueue.add): recusa
  // rodar contra o Redis vivo do piloto (mesmo env que as filas de produção consomem).
  assertTestRedis(process.env.REDIS_URL ?? 'redis://localhost:6379')

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
      payload: { conversationId: conversationBId, clientMessageId: randomUUID(), text: 'não deveria funcionar' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('valida, cria Message queued (outbound) e enfileira `message-send` — responde 202 sem esperar o provider', async () => {
    sendTextImpl = async (to, text) => {
      sendTextCalls.push({ to, text })
      return { providerMessageId: 'FAKE123' }
    }
    const addSpy = vi.spyOn(messageSendQueue, 'add')
    const clientMessageId = randomUUID()

    const res = await app.inject({
      method: 'POST',
      url: '/messages',
      headers: { authorization: 'Bearer qualquer-token' },
      payload: { conversationId, clientMessageId, text: 'resposta de teste do Aios Pocket' },
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
    expect(message?.clientMessageId).toBe(clientMessageId)

    expect(addSpy).toHaveBeenCalledWith(
      'send',
      { messageId: body.messageId, companyId },
      expect.objectContaining({ jobId: body.messageId, attempts: 3 }),
    )
    // sendText NUNCA é chamado síncronamente pela rota — só o worker chama, depois.
    expect(sendTextCalls).toHaveLength(0)

    addSpy.mockRestore()
    // Não deixa a linha 'queued' para trás no banco compartilhado (nunca processada por
    // um worker de verdade neste teste) — ela poderia ser capturada pela varredura de
    // reconciliação de outro teste deste arquivo.
    await prismaUnsafe.message.deleteMany({ where: { id: body.messageId } })
  })

  it('POST duplicado com o MESMO clientMessageId não cria segunda linha — devolve o messageId ORIGINAL (idempotência do envio, fecha o "202 dangling" da review do Plano B)', async () => {
    const clientMessageId = randomUUID()
    const payload = { conversationId, clientMessageId, text: 'mensagem idempotente' }
    const addSpy = vi.spyOn(messageSendQueue, 'add')

    const first = await app.inject({
      method: 'POST',
      url: '/messages',
      headers: { authorization: 'Bearer qualquer-token' },
      payload,
    })
    expect(first.statusCode).toBe(202)
    const firstBody = first.json() as { messageId: string }

    const second = await app.inject({
      method: 'POST',
      url: '/messages',
      headers: { authorization: 'Bearer qualquer-token' },
      payload,
    })
    expect(second.statusCode).toBe(202)
    const secondBody = second.json() as { messageId: string }

    expect(secondBody.messageId).toBe(firstBody.messageId) // MESMO messageId — retry não gera novo id

    const rows = await prismaUnsafe.message.findMany({ where: { companyId, clientMessageId } })
    expect(rows).toHaveLength(1) // uma única linha, apesar dos dois POSTs

    // Enfileira só na 1ª tentativa — a 2ª é reconhecida como duplicata antes de chegar lá.
    expect(addSpy).toHaveBeenCalledTimes(1)

    addSpy.mockRestore()
    await prismaUnsafe.message.deleteMany({ where: { id: firstBody.messageId } })
  })

  it('falha ao enfileirar: responde 500 (usuário precisa saber, diferente do webhook) — Message fica queued para a varredura de reconciliação cobrir (achado IMPORTANT da re-review T11, item 5)', async () => {
    const addSpy = vi.spyOn(messageSendQueue, 'add').mockRejectedValueOnce(new Error('redis fora do ar (simulado)'))

    const res = await app.inject({
      method: 'POST',
      url: '/messages',
      headers: { authorization: 'Bearer qualquer-token' },
      payload: { conversationId, clientMessageId: randomUUID(), text: 'vai falhar ao enfileirar' },
    })
    expect(res.statusCode).toBe(500)
    addSpy.mockRestore()

    const message = await prismaUnsafe.message.findFirst({
      where: { companyId, text: 'vai falhar ao enfileirar' },
      orderBy: { createdAt: 'desc' },
    })
    expect(message?.state).toBe('queued') // criada mesmo com o enqueue tendo falhado

    // Simula a janela de 5min já passada (mesmo padrão de RECONCILE_MIN_AGE_MS em
    // pipeline-inbound.test.ts) e roda a varredura diretamente.
    await prismaUnsafe.message.update({
      where: { id: message!.id },
      data: { createdAt: new Date(Date.now() - 6 * 60 * 1000) },
    })

    const reenqueueSpy = vi.spyOn(messageSendQueue, 'add')
    // `{ companyId }` escopa a varredura à fixture deste arquivo — protege o banco de dev
    // compartilhado de efeitos colaterais entre suítes (fold da re-review T11 round 2).
    await reconcileStuckMessages({ companyId })
    const reenqueued = reenqueueSpy.mock.calls.some(
      (call) => (call[1] as { messageId?: string } | undefined)?.messageId === message!.id,
    )
    expect(reenqueued).toBe(true)
    reenqueueSpy.mockRestore()

    await prismaUnsafe.message.deleteMany({ where: { id: message!.id } })
  })
})

describe('sendQueuedMessage (worker `message-send` — máquina de estados, ADR-0006)', () => {
  let sentMessageId: string

  beforeAll(async () => {
    const message = await createMessage({ text: 'resposta de teste do Aios Pocket' })
    sentMessageId = message.id
  })

  it('processa o job: Message vai a sent com providerMessageId do provider, grava timeline e publica MessageSent', async () => {
    sendTextImpl = async (to, text) => {
      sendTextCalls.push({ to, text })
      return { providerMessageId: 'FAKE123' }
    }
    const callsBefore = sendTextCalls.length
    const addSpy = vi.spyOn(domainEventsQueue, 'add')

    await sendQueuedMessage(sentMessageId, companyId)

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

    await sendQueuedMessage(sentMessageId, companyId) // reexecução do MESMO job (já sent)

    expect(sendTextCalls.length).toBe(callsBefore)
    const timelineCountAfter = await prismaUnsafe.customerEvent.count({
      where: { customerId, type: 'message_sent' },
    })
    expect(timelineCountAfter).toBe(timelineCountBefore)
    expect(addSpy).not.toHaveBeenCalled()

    addSpy.mockRestore()
  })

  it('reentrada com state ainda `sending` (simula recuperação de job "stalled" do BullMQ ou retry pós-falha): lança UnrecoverableError — nunca reenvia, e o job termina JÁ em vez de "completar" em silêncio (achado CRÍTICO da re-review T11 round 2)', async () => {
    const message = await createMessage({ state: 'sending', text: 'travada em sending' })
    const callsBefore = sendTextCalls.length

    // Antes do fix: isto retornava void, o que faria o BullMQ real considerar o job
    // COMPLETO com sucesso (nenhum throw) — o evento `failed` nunca dispararia e
    // markSendFailed ficaria inalcançável com `attempts: 3` (config de produção). Agora
    // lança, forçando o job a terminar imediatamente como falho.
    await expect(sendQueuedMessage(message.id, companyId)).rejects.toThrow(
      'estado incerto: reentrada em sending (stall ou retry pos-falha) — sem reenvio automatico',
    )

    expect(sendTextCalls.length).toBe(callsBefore) // NUNCA chama o provider de novo
    const after = await prismaUnsafe.message.findFirst({ where: { id: message.id } })
    expect(after?.state).toBe('sending') // o lançamento não muda o estado por si só — quem termina é o handler `failed`
  })

  it('integração real: reentrada em sending com `attempts: 3` (config de PRODUÇÃO) ainda termina no 1º evento "failed" — UnrecoverableError ignora as tentativas restantes (achado CRÍTICO da re-review T11 round 2)', async () => {
    const message = await createMessage({ state: 'sending', text: 'presa desde uma tentativa anterior' })

    const worker = startSendWorker()
    try {
      const failedEvent = new Promise<void>((resolve, reject) => {
        worker.on('failed', (job) => {
          if (job?.data?.messageId === message.id) resolve()
        })
        worker.on('error', reject)
      })

      // attempts:3 — a MESMA config da rota real (routes/messages.ts). Sem o fix, o job
      // "completaria" silenciosamente já na 1ª tentativa (CAS acha count=0, retornava sem
      // lançar) e a Message ficaria presa em `sending` sem NENHUM evento disparar —
      // inalcançável até a próxima varredura periódica, minutos depois.
      await messageSendQueue.add('send', { messageId: message.id, companyId }, { jobId: message.id, attempts: 3 })

      await failedEvent

      const after = await waitFor(async () => {
        const m = await prismaUnsafe.message.findFirst({ where: { id: message.id } })
        return m?.state === 'failed' ? m : null
      })
      expect(after?.state).toBe('failed')
      expect(after?.failReason).toContain('estado incerto: reentrada em sending')
    } finally {
      await worker.close()
      const job = await messageSendQueue.getJob(message.id)
      await job?.remove()
    }
  }, 20000)

  it('corrida do eco no CAS final: eco processado ANTES da atualização sending→sent (mesmo providerMessageId) não lança — a linha do eco vence, a linha original órfã é removida (achado IMPORTANT da re-review T11)', async () => {
    const message = await createMessage({ text: 'vai colidir com o eco' })

    sendTextImpl = async (to, text) => {
      sendTextCalls.push({ to, text })
      // Simula o webhook de eco tendo sido processado ENQUANTO o sendText estava em voo:
      // cria a linha "canônica" que o pipeline inbound criaria (a guarda fromMe de
      // process-webhook.ts não a reconhece como eco porque, neste instante, a NOSSA
      // linha ainda tem providerMessageId nulo).
      await prismaUnsafe.message.create({
        data: {
          companyId,
          conversationId,
          direction: 'outbound',
          state: 'sent',
          provider: 'evolution',
          providerMessageId: 'FAKE-RACE-1',
          fromMe: true,
          type: 'text',
          text,
          correlationId: randomUUID(),
        },
      })
      return { providerMessageId: 'FAKE-RACE-1' }
    }

    await expect(sendQueuedMessage(message.id, companyId)).resolves.toBeUndefined() // nunca lança

    const original = await prismaUnsafe.message.findUnique({ where: { id: message.id } })
    expect(original).toBeNull() // linha original órfã (sending, sem providerMessageId) removida

    const outboundRows = await prismaUnsafe.message.findMany({
      where: { companyId, provider: 'evolution', providerMessageId: 'FAKE-RACE-1', direction: 'outbound' },
    })
    expect(outboundRows).toHaveLength(1) // exatamente uma linha sobrevive: a do eco
    // Timeout explícito (mesmo valor dos vizinhos): o caminho faz ~8 roundtrips ao DB
    // remoto do droplet — o default de 5s do vitest flakeia por latência de rede pura
    // (visto em 2026-08-23, falhando idêntico com e sem as mudanças da T8).
  }, 20000)
})

describe('falha do provider — nunca silenciosa (carry-over T7 / DLQ do send)', () => {
  it('provider lança: sendQueuedMessage propaga (BullMQ decide retry); markSendFailed grava failed + failReason + timeline quando chamado', async () => {
    sendTextImpl = async () => {
      throw new Error('evolution indisponível (simulado)')
    }

    const message = await createMessage({ text: 'vai falhar' })

    // 1ª tentativa: propaga o erro do provider — nunca falha silenciosa.
    await expect(sendQueuedMessage(message.id, companyId)).rejects.toThrow('evolution indisponível (simulado)')

    const stillSending = await prismaUnsafe.message.findFirst({ where: { id: message.id } })
    expect(stillSending?.state).toBe('sending') // em tentativa; não terminal por conta própria

    // Simula o handler `worker.on('failed', ...)` já tendo confirmado o job como terminal
    // (job.isFailed() === true) — chamado diretamente (carry-over T7).
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

describe('DLQ do send: handler `failed` do worker — nunca silencioso, verificado contra job.isFailed() (achado CRÍTICO/IMPORTANT da re-review T11)', () => {
  it('unit: job.isFailed()=true (terminal de verdade) → markSendFailed grava failed + failReason + timeline', async () => {
    const message = await createMessage({ state: 'sending', text: 'preso em sending' })
    const fakeJob = {
      isFailed: vi.fn().mockResolvedValue(true),
      data: { messageId: message.id, companyId },
    }

    await handleSendFailed(fakeJob as unknown as Job, new Error('esgotado (simulado)'))

    const after = await prismaUnsafe.message.findFirst({ where: { id: message.id } })
    expect(after?.state).toBe('failed')
    expect(after?.failReason).toBe('esgotado (simulado)')

    const timeline = await prismaUnsafe.customerEvent.findFirst({
      where: { customerId, type: 'message_send_failed', correlationId: after?.correlationId },
    })
    expect(timeline).not.toBeNull()
  })

  it('unit: job.isFailed()=false (BullMQ ainda vai reagendar) → NÃO marca failed — silêncio correto aqui, o retry está a caminho', async () => {
    const message = await createMessage({ state: 'sending', text: 'ainda vai tentar de novo' })
    const fakeJob = {
      isFailed: vi.fn().mockResolvedValue(false),
      data: { messageId: message.id, companyId },
    }

    await handleSendFailed(fakeJob as unknown as Job, new Error('falha transitória (simulada)'))

    const after = await prismaUnsafe.message.findFirst({ where: { id: message.id } })
    expect(after?.state).toBe('sending') // não terminal — não mexe
  })

  it(
    'integração real: Queue+Worker de verdade, attempts:1, provider lança → evento "failed" → Message failed + timeline',
    async () => {
      const message = await createMessage({ text: 'vai falhar de verdade' })
      sendTextImpl = async () => {
        throw new Error('provider indisponível (integração real)')
      }

      const worker = startSendWorker()
      try {
        const failedEvent = new Promise<void>((resolve, reject) => {
          worker.on('failed', (job) => {
            if (job?.data?.messageId === message.id) resolve()
          })
          worker.on('error', reject)
        })

        await messageSendQueue.add('send', { messageId: message.id, companyId }, { jobId: message.id, attempts: 1 })

        await failedEvent
        // O handler 'failed' interno roda fire-and-forget (handleSendFailed faz
        // job.isFailed() + vários round-trips do Prisma contra o Postgres remoto de dev,
        // NÃO transacionais entre si — dezenas a centenas de ms cada, como os outros
        // testes deste arquivo já mostram). Um sleep fixo é frágil contra essa variância;
        // poll até cada condição aparecer é o jeito robusto de esperar — estado e timeline
        // são esperados SEPARADAMENTE porque são escritas distintas, não atômicas.
        const after = await waitFor(async () => {
          const m = await prismaUnsafe.message.findFirst({ where: { id: message.id } })
          return m?.state === 'failed' ? m : null
        })
        expect(after?.state).toBe('failed')
        expect(after?.failReason).toBe('provider indisponível (integração real)')

        const timeline = await waitFor(() =>
          prismaUnsafe.customerEvent.findFirst({
            where: { customerId, type: 'message_send_failed', correlationId: after?.correlationId },
          }),
        )
        expect(timeline).not.toBeNull()
      } finally {
        await worker.close()
        const job = await messageSendQueue.getJob(message.id)
        await job?.remove()
      }
    },
    20000,
  )
})

describe('varredura de reconciliação: Message presa em `sending` (achado CRÍTICO da re-review T11, item 1)', () => {
  it('sending há mais de 10min é marcada failed com motivo fixo — cicatriz visível, nunca reenvio automático', async () => {
    const message = await createMessage({ state: 'sending', text: 'presa de verdade há muito tempo' })
    await prismaUnsafe.message.update({
      where: { id: message.id },
      data: { createdAt: new Date(Date.now() - 11 * 60 * 1000) },
    })

    await reconcileStuckMessages({ companyId })

    const after = await prismaUnsafe.message.findFirst({ where: { id: message.id } })
    expect(after?.state).toBe('failed')
    expect(after?.failReason).toBe('estado incerto (crash durante envio)')

    const timeline = await prismaUnsafe.customerEvent.findFirst({
      where: { customerId, type: 'message_send_failed', correlationId: after?.correlationId },
    })
    expect(timeline).not.toBeNull()
  })

  it('NÃO marca failed uma Message `sending` cujo job ainda está ativo/pendente na fila — mesmo com createdAt aparentando velho (corrida da varredura consigo mesma, achado CRÍTICO da re-review T11 round 2, item 2b)', async () => {
    const message = await createMessage({ state: 'sending', text: 'sending mas com job ainda vivo na fila' })
    // createdAt "velho" simula uma linha que ficou MUITO tempo `queued` antes de
    // finalmente ser pega por um worker — sem a exclusão, pareceria uma `sending` órfã.
    await prismaUnsafe.message.update({
      where: { id: message.id },
      data: { createdAt: new Date(Date.now() - 11 * 60 * 1000) },
    })

    // Job ainda "vivo" na fila (delayed) para o MESMO jobId=messageId — simula um envio
    // GENUINAMENTE em andamento (ou prestes a rodar), não órfão.
    await messageSendQueue.add('send', { messageId: message.id, companyId }, { jobId: message.id, delay: 60_000 })

    try {
      await reconcileStuckMessages({ companyId })

      const after = await prismaUnsafe.message.findFirst({ where: { id: message.id } })
      expect(after?.state).toBe('sending') // NÃO marcada failed — o job ainda está na fila
    } finally {
      const job = await messageSendQueue.getJob(message.id)
      await job?.remove()
    }
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
