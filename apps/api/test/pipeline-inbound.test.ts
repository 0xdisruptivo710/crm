import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { prismaUnsafe } from '@aios-pocket/db/testing'
import { processRawWebhook } from '../src/pipeline/process-webhook.js'
import { reconcileUnprocessedWebhooks } from '../src/queue/webhook-worker.js'
import { domainEventsQueue, webhookProcessingQueue } from '../src/queue/queues.js'

// Suíte de integração real: banco e Redis são remotos (droplet de dev) — o custo de
// conexão a frio da fila BullMQ (primeiro publishDomainEvent do processo) já estourou
// o default de 5s do Vitest em execução isolada. 20s dá folga sem mascarar um hang real.
vi.setConfig({ testTimeout: 20000 })

// Fixtures reais (Conventions.md §3.10) — mesmo diretório usado pela suíte de contrato
// de packages/providers.
const FIXTURES_DIR = join(import.meta.dirname, '..', '..', '..', 'tests', 'providers', 'fixtures', 'evolution')

function loadFixture(name: string): object {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, `${name}.json`), 'utf8')) as object
}

let companyId = ''

// Insere um raw_webhook_events com o payload da fixture e roda o use case diretamente
// (determinístico — sem esperar o worker/BullMQ, conforme o brief da Task 10).
async function ingest(fixtureName: string) {
  const raw = await prismaUnsafe.rawWebhookEvent.create({
    data: { provider: 'evolution', companyId, payload: loadFixture(fixtureName) },
  })
  await processRawWebhook(raw.id)
  return prismaUnsafe.rawWebhookEvent.findUnique({ where: { id: raw.id } })
}

beforeAll(async () => {
  const company = await prismaUnsafe.company.create({
    data: {
      name: `Pipeline Inbound ${Date.now()}`,
      activeProvider: 'evolution',
      providerCredentials: 'cifrado',
    },
  })
  companyId = company.id
})

afterEach(() => {
  vi.restoreAllMocks()
})

afterAll(async () => {
  // Cleanup escopado por companyId, com guarda `if` (lição do Plano A — tenancy.test.ts).
  if (companyId) {
    await prismaUnsafe.customerEvent.deleteMany({ where: { companyId } })
    await prismaUnsafe.message.deleteMany({ where: { companyId } })
    await prismaUnsafe.conversation.deleteMany({ where: { companyId } })
    await prismaUnsafe.customer.deleteMany({ where: { companyId } })
    await prismaUnsafe.rawWebhookEvent.deleteMany({ where: { companyId } })
    await prismaUnsafe.company.deleteMany({ where: { id: companyId } })
  }
})

describe('pipeline inbound: webhook vira Customer/Conversation/Message/Timeline (ADR-0004/0006)', () => {
  it('incoming_text-1: cria Customer (E.164 sintético), Conversation e Message inbound/received', async () => {
    const raw = await ingest('incoming_text-1')
    expect(raw?.processed).toBe(true)
    expect(raw?.error).toBeNull()

    const customer = await prismaUnsafe.customer.findFirst({ where: { companyId, phoneE164: '+5511999990006' } })
    expect(customer).not.toBeNull()
    expect(customer?.phoneOriginal).toBe('5511999990006')

    const conversation = await prismaUnsafe.conversation.findFirst({
      where: { companyId, provider: 'evolution', externalId: '5511999990006@s.whatsapp.net' },
    })
    expect(conversation).not.toBeNull()
    expect(conversation?.customerId).toBe(customer?.id)

    const message = await prismaUnsafe.message.findFirst({
      where: { companyId, provider: 'evolution', providerMessageId: '3AEBDB6659701F736BFF' },
    })
    expect(message?.direction).toBe('inbound')
    expect(message?.state).toBe('received')
    expect(message?.fromMe).toBe(false)
    expect(message?.type).toBe('text')

    const timeline = await prismaUnsafe.customerEvent.findFirst({
      where: { companyId, customerId: customer?.id, type: 'message_received' },
    })
    expect(timeline).not.toBeNull()
    expect(timeline?.correlationId).toBe(message?.correlationId)
  })

  it('reingerir a MESMA fixture (novo raw) não duplica Customer nem Message — dedupe por P2002', async () => {
    const customersBefore = await prismaUnsafe.customer.count({ where: { companyId, phoneE164: '+5511999990006' } })
    const messagesBefore = await prismaUnsafe.message.count({
      where: { companyId, provider: 'evolution', providerMessageId: '3AEBDB6659701F736BFF' },
    })

    const raw = await ingest('incoming_text-1')
    expect(raw?.processed).toBe(true) // idempotência: marcado processado, sem erro, sem duplicar

    const customersAfter = await prismaUnsafe.customer.count({ where: { companyId, phoneE164: '+5511999990006' } })
    const messagesAfter = await prismaUnsafe.message.count({
      where: { companyId, provider: 'evolution', providerMessageId: '3AEBDB6659701F736BFF' },
    })
    expect(customersAfter).toBe(customersBefore)
    expect(messagesAfter).toBe(messagesBefore)
  })

  it('incoming_from_me-1: mesma conversa, mensagem vira outbound/sent', async () => {
    await ingest('incoming_from_me-1')
    // id exato da fixture (ver tests/providers/fixtures/evolution/incoming_from_me-1.json)
    const message = await prismaUnsafe.message.findFirst({
      where: { companyId, provider: 'evolution', providerMessageId: '3AA97459A5FEC29DF448' },
    })
    expect(message?.direction).toBe('outbound')
    expect(message?.state).toBe('sent')
    expect(message?.fromMe).toBe(true)

    const customer = await prismaUnsafe.customer.findFirst({ where: { companyId, phoneE164: '+5511999990006' } })
    const timeline = await prismaUnsafe.customerEvent.findFirst({
      where: { companyId, customerId: customer?.id, type: 'message_sent_from_phone' },
    })
    expect(timeline).not.toBeNull()
  })

  it('incoming_audio-1: campos de mídia populados', async () => {
    await ingest('incoming_audio-1')
    const message = await prismaUnsafe.message.findFirst({
      where: { companyId, provider: 'evolution', providerMessageId: '3A78D2DC6D0274B1A7B2' },
    })
    expect(message?.type).toBe('audio')
    expect(message?.mediaUrl).toEqual(expect.stringContaining('https://'))
    expect(message?.mediaMimeType).toContain('audio')
    expect(message?.mediaCorrelationKey).toBe('3A78D2DC6D0274B1A7B2')
  })

  it('incoming_reply-1: replyToProviderMessageId preenchido com o stanzaId', async () => {
    await ingest('incoming_reply-1')
    const message = await prismaUnsafe.message.findFirst({
      where: { companyId, provider: 'evolution', providerMessageId: '3A519B358AE3230B440A' },
    })
    expect(message?.replyToProviderMessageId).toBe('3EB04BBF39DB6587B88648')
  })

  it('status_update-1 (correlaciona com incoming_from_me-1): avança sent → delivered e grava TimelineEvent', async () => {
    const before = await prismaUnsafe.message.findFirst({
      where: { companyId, provider: 'evolution', providerMessageId: '3AA97459A5FEC29DF448' },
    })
    expect(before?.state).toBe('sent')

    const raw = await ingest('status_update-1')
    expect(raw?.processed).toBe(true)
    expect(raw?.error).toBeNull()

    const after = await prismaUnsafe.message.findFirst({
      where: { companyId, provider: 'evolution', providerMessageId: '3AA97459A5FEC29DF448' },
    })
    expect(after?.state).toBe('delivered')

    const timeline = await prismaUnsafe.customerEvent.findFirst({
      where: { companyId, type: 'message_status_changed', correlationId: after?.correlationId },
    })
    expect(timeline).not.toBeNull()
  })

  it('reprocessar o MESMO status (regressão/repetição) é ignorado: estado não muda, timeline não duplica', async () => {
    const before = await prismaUnsafe.message.findFirst({
      where: { companyId, provider: 'evolution', providerMessageId: '3AA97459A5FEC29DF448' },
    })
    const timelineCountBefore = await prismaUnsafe.customerEvent.count({
      where: { companyId, type: 'message_status_changed', correlationId: before?.correlationId },
    })

    await ingest('status_update-1') // mesmo DELIVERY_ACK de novo, novo raw id

    const after = await prismaUnsafe.message.findFirst({
      where: { companyId, provider: 'evolution', providerMessageId: '3AA97459A5FEC29DF448' },
    })
    const timelineCountAfter = await prismaUnsafe.customerEvent.count({
      where: { companyId, type: 'message_status_changed', correlationId: after?.correlationId },
    })
    expect(after?.state).toBe(before?.state) // sem regressão nem repetição
    expect(timelineCountAfter).toBe(timelineCountBefore)
  })

  it('status update para providerMessageId desconhecido: marca processado com erro, não lança', async () => {
    const raw = await ingest('status_update-3') // keyId não corresponde a nenhuma mensagem inserida
    expect(raw?.processed).toBe(true)
    expect(raw?.error).toBe('mensagem desconhecida')
  })

  it('connection_update-1: atualiza connectionState da company', async () => {
    const raw = await ingest('connection_update-1')
    expect(raw?.processed).toBe(true)

    const company = await prismaUnsafe.company.findUnique({ where: { id: companyId } })
    expect(company?.connectionState).toBe('connecting')
  })

  it('reprocessar o MESMO raw id é no-op (idempotência via processed=true)', async () => {
    const raw = await prismaUnsafe.rawWebhookEvent.create({
      data: { provider: 'evolution', companyId, payload: loadFixture('incoming_text-1') },
    })
    await processRawWebhook(raw.id)
    const countAfterFirst = await prismaUnsafe.message.count({ where: { companyId } })

    await processRawWebhook(raw.id) // mesmo raw id — deve retornar sem processar de novo
    const countAfterSecond = await prismaUnsafe.message.count({ where: { companyId } })

    expect(countAfterSecond).toBe(countAfterFirst)
  })

  it('reconcileUnprocessedWebhooks: raw não processado e órfão (>60s) reentra na fila', async () => {
    const raw = await prismaUnsafe.rawWebhookEvent.create({
      data: { provider: 'evolution', companyId, payload: loadFixture('connection_update-2') },
    })
    // Simula um evento "velho" (chegou há mais de 60s) que nunca foi enfileirado/processado.
    await prismaUnsafe.rawWebhookEvent.update({
      where: { id: raw.id },
      data: { receivedAt: new Date(Date.now() - 120_000) },
    })

    const addSpy = vi.spyOn(webhookProcessingQueue, 'add').mockResolvedValue({} as never)
    await reconcileUnprocessedWebhooks()

    const reenqueued = addSpy.mock.calls.some((call) => {
      const data = call[1] as { rawEventId?: string } | undefined
      return data?.rawEventId === raw.id
    })
    expect(reenqueued).toBe(true)

    await prismaUnsafe.rawWebhookEvent.deleteMany({ where: { id: raw.id } })
  })

  it('reconcileUnprocessedWebhooks remove um job FALHO (esgotado) antes de reenfileirar com o mesmo jobId (achado IMPORTANT da revisão T10)', async () => {
    const raw = await prismaUnsafe.rawWebhookEvent.create({
      data: { provider: 'evolution', companyId, payload: loadFixture('connection_update-1') },
    })
    await prismaUnsafe.rawWebhookEvent.update({
      where: { id: raw.id },
      data: { receivedAt: new Date(Date.now() - 120_000) },
    })

    // Sem isso, o BullMQ ignora silenciosamente um `.add()` com jobId repetido enquanto o
    // job antigo (falho, esgotou as 3 tentativas) ainda existir — a reconciliação nunca
    // re-dirigiria um job morto. `getJob`/`isFailed`/`remove` mockados: nível de mock
    // explicitamente aceito para este achado (equivalente ao teste de reconciliação acima).
    const removeSpy = vi.fn().mockResolvedValue(undefined)
    const fakeFailedJob = { isFailed: vi.fn().mockResolvedValue(true), remove: removeSpy }
    const getJobSpy = vi.spyOn(webhookProcessingQueue, 'getJob').mockResolvedValue(fakeFailedJob as never)
    const addSpy = vi.spyOn(webhookProcessingQueue, 'add').mockResolvedValue({} as never)

    await reconcileUnprocessedWebhooks()

    expect(getJobSpy).toHaveBeenCalledWith(raw.id)
    expect(removeSpy).toHaveBeenCalled() // job falho removido ANTES do re-add
    const reenqueued = addSpy.mock.calls.some((call) => (call[1] as { rawEventId?: string } | undefined)?.rawEventId === raw.id)
    expect(reenqueued).toBe(true)

    await prismaUnsafe.rawWebhookEvent.deleteMany({ where: { id: raw.id } })
  })

  it('isolamento entre companies: a MESMA fixture ingerida por duas companies cria Customer/Conversation/Message SEPARADOS, sem cross-link', async () => {
    const companyA = await prismaUnsafe.company.create({
      data: { name: `Pipeline Isolamento A ${Date.now()}`, activeProvider: 'evolution', providerCredentials: 'cifrado' },
    })
    const companyB = await prismaUnsafe.company.create({
      data: { name: `Pipeline Isolamento B ${Date.now()}`, activeProvider: 'evolution', providerCredentials: 'cifrado' },
    })
    try {
      const fixture = loadFixture('incoming_image-2') // fixture real, não usada em outro teste deste arquivo
      const rawA = await prismaUnsafe.rawWebhookEvent.create({
        data: { provider: 'evolution', companyId: companyA.id, payload: fixture },
      })
      const rawB = await prismaUnsafe.rawWebhookEvent.create({
        data: { provider: 'evolution', companyId: companyB.id, payload: fixture },
      })

      await processRawWebhook(rawA.id)
      await processRawWebhook(rawB.id)

      const customersA = await prismaUnsafe.customer.findMany({ where: { companyId: companyA.id } })
      const customersB = await prismaUnsafe.customer.findMany({ where: { companyId: companyB.id } })
      expect(customersA).toHaveLength(1)
      expect(customersB).toHaveLength(1)
      expect(customersA[0]?.id).not.toBe(customersB[0]?.id) // mesmo telefone, Customer DIFERENTE por company

      const conversationsA = await prismaUnsafe.conversation.findMany({ where: { companyId: companyA.id } })
      const conversationsB = await prismaUnsafe.conversation.findMany({ where: { companyId: companyB.id } })
      expect(conversationsA).toHaveLength(1)
      expect(conversationsB).toHaveLength(1)
      expect(conversationsA[0]?.customerId).toBe(customersA[0]?.id) // sem cross-link entre companies
      expect(conversationsB[0]?.customerId).toBe(customersB[0]?.id)

      const messagesA = await prismaUnsafe.message.findMany({ where: { companyId: companyA.id } })
      const messagesB = await prismaUnsafe.message.findMany({ where: { companyId: companyB.id } })
      expect(messagesA).toHaveLength(1)
      expect(messagesB).toHaveLength(1)
      expect(messagesA[0]?.conversationId).toBe(conversationsA[0]?.id)
      expect(messagesB[0]?.conversationId).toBe(conversationsB[0]?.id)
    } finally {
      for (const id of [companyA.id, companyB.id]) {
        await prismaUnsafe.customerEvent.deleteMany({ where: { companyId: id } })
        await prismaUnsafe.message.deleteMany({ where: { companyId: id } })
        await prismaUnsafe.conversation.deleteMany({ where: { companyId: id } })
        await prismaUnsafe.customer.deleteMany({ where: { companyId: id } })
        await prismaUnsafe.rawWebhookEvent.deleteMany({ where: { companyId: id } })
        await prismaUnsafe.company.deleteMany({ where: { id } })
      }
    }
  })

  it('caminho negativo CRÍTICO: processamento lança (publish falha) → raw NÃO fica marcado processado; retry seguinte completa (idempotência por passo)', async () => {
    const raw = await prismaUnsafe.rawWebhookEvent.create({
      data: { provider: 'evolution', companyId, payload: loadFixture('incoming_text-3') },
    })

    const addSpy = vi.spyOn(domainEventsQueue, 'add').mockRejectedValueOnce(new Error('redis fora do ar (simulado)'))
    await expect(processRawWebhook(raw.id)).rejects.toThrow('redis fora do ar (simulado)')
    addSpy.mockRestore()

    const afterFailure = await prismaUnsafe.rawWebhookEvent.findUnique({ where: { id: raw.id } })
    // NÃO marcado como processado: o job precisa falhar de verdade para o BullMQ re-tentar
    // (attempts: 3, ver queue/queues.ts) — achado CRÍTICO da revisão T10.
    expect(afterFailure?.processed).toBe(false)

    // Message/customerEvent já commitados antes do publish falhar (sem transação cobrindo
    // os 3 passos) — isso é esperado; o que importa é que o RETRY seguinte reconhece o que
    // já foi feito (dedupe por P2002 + timeline condicional) e completa sem duplicar nem
    // perder o evento de domínio.
    await processRawWebhook(raw.id)
    const afterRetry = await prismaUnsafe.rawWebhookEvent.findUnique({ where: { id: raw.id } })
    expect(afterRetry?.processed).toBe(true)
    expect(afterRetry?.error).toBeNull()

    const messages = await prismaUnsafe.message.count({
      where: { companyId, provider: 'evolution', providerMessageId: '3A245B67166D7896E259' },
    })
    expect(messages).toBe(1) // sem duplicar apesar do crash no meio do caminho
  })
})
