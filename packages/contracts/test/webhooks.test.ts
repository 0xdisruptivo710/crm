import { describe, expect, it } from 'vitest'
import { incomingMessageSchema, normalizedWebhookEventSchema } from '../src/index.js'

const validIncoming = {
  kind: 'incoming_message',
  provider: 'evolution',
  providerMessageId: 'ABC123',
  phone: '+5511999990000',
  conversationExternalId: '5511999990000@s.whatsapp.net',
  fromMe: false,
  type: 'text',
  text: 'olá',
  media: null,
  replyToProviderMessageId: null,
  isEdit: false,
  timestamp: '2026-08-08T12:00:00.000Z',
  metadata: {},
}

describe('incomingMessageSchema', () => {
  it('aceita mensagem válida e coage timestamp para Date', () => {
    const parsed = incomingMessageSchema.parse(validIncoming)
    expect(parsed.timestamp).toBeInstanceOf(Date)
    expect(parsed.fromMe).toBe(false)
  })

  it('rejeita mensagem sem fromMe (campo aprendido em produção — obrigatório)', () => {
    const { fromMe: _omitted, ...semFromMe } = validIncoming
    expect(incomingMessageSchema.safeParse(semFromMe).success).toBe(false)
  })
})

describe('normalizedWebhookEventSchema', () => {
  it('discrimina pelos três kinds internos', () => {
    const status = normalizedWebhookEventSchema.parse({
      kind: 'message_status_update',
      provider: 'zapi',
      providerMessageId: 'ABC123',
      status: 'delivered',
      timestamp: '2026-08-08T12:00:01.000Z',
    })
    expect(status.kind).toBe('message_status_update')
    const conn = normalizedWebhookEventSchema.parse({
      kind: 'connection_status_change',
      provider: 'evolution',
      status: 'disconnected',
      reason: 'qr expirado',
      timestamp: '2026-08-08T12:00:02.000Z',
    })
    expect(conn.kind).toBe('connection_status_change')
  })
})
