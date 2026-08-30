import { describe, expect, it } from 'vitest'
import {
  conversationSummarySchema,
  messageViewSchema,
  sendMessageRequestSchema,
} from '../src/index.js'

const UUID = '3b241101-e2bb-4255-8caf-4136c566a962'
const UUID_2 = '4c352212-f3cc-5366-9dbf-5247c677b073'

describe('sendMessageRequestSchema (validação compartilhada web/api — POST /messages)', () => {
  it('aceita conversationId (uuid) + clientMessageId (uuid) + text não vazio', () => {
    const ok = sendMessageRequestSchema.parse({
      conversationId: UUID,
      clientMessageId: UUID_2,
      text: 'resposta de teste',
    })
    expect(ok.text).toBe('resposta de teste')
    expect(ok.clientMessageId).toBe(UUID_2)
  })

  it('rejeita conversationId que não é uuid', () => {
    expect(
      sendMessageRequestSchema.safeParse({
        conversationId: 'não-é-uuid',
        clientMessageId: UUID_2,
        text: 'oi',
      }).success,
    ).toBe(false)
  })

  it('rejeita text vazio', () => {
    expect(
      sendMessageRequestSchema.safeParse({
        conversationId: UUID,
        clientMessageId: UUID_2,
        text: '',
      }).success,
    ).toBe(false)
  })

  it('rejeita text acima de 4096 caracteres', () => {
    expect(
      sendMessageRequestSchema.safeParse({
        conversationId: UUID,
        clientMessageId: UUID_2,
        text: 'x'.repeat(4097),
      }).success,
    ).toBe(false)
  })

  it('rejeita payload sem clientMessageId — chave de idempotência OBRIGATÓRIA (fecha o "202 dangling" da review do Plano B)', () => {
    expect(
      sendMessageRequestSchema.safeParse({ conversationId: UUID, text: 'oi' }).success,
    ).toBe(false)
  })

  it('rejeita clientMessageId que não é uuid', () => {
    expect(
      sendMessageRequestSchema.safeParse({
        conversationId: UUID,
        clientMessageId: 'não-é-uuid',
        text: 'oi',
      }).success,
    ).toBe(false)
  })
})

describe('conversationSummarySchema (resposta de GET /conversations)', () => {
  it('aceita forma completa com customer embutido', () => {
    const ok = conversationSummarySchema.parse({
      id: UUID,
      provider: 'evolution',
      status: 'open',
      lastMessageAt: '2026-08-11T10:00:00.000Z',
      customer: { id: UUID_2, phoneE164: '+5511999990000', name: 'Cliente Teste' },
    })
    expect(ok.customer.phoneE164).toBe('+5511999990000')
    expect(ok.lastMessageAt).toBeInstanceOf(Date)
  })

  it('aceita lastMessageAt nulo (conversa sem mensagens ainda) e customer.name nulo', () => {
    const ok = conversationSummarySchema.parse({
      id: UUID,
      provider: 'zapi',
      status: 'closed',
      lastMessageAt: null,
      customer: { id: UUID_2, phoneE164: '+5511999990000', name: null },
    })
    expect(ok.lastMessageAt).toBeNull()
    expect(ok.customer.name).toBeNull()
  })

  it('rejeita provider fora do enum evolution/zapi', () => {
    expect(
      conversationSummarySchema.safeParse({
        id: UUID,
        provider: 'invalido',
        status: 'open',
        lastMessageAt: null,
        customer: { id: UUID_2, phoneE164: '+5511999990000', name: null },
      }).success,
    ).toBe(false)
  })
})

describe('messageViewSchema (resposta de GET /conversations/:id/messages)', () => {
  it('aceita forma completa', () => {
    const ok = messageViewSchema.parse({
      id: UUID,
      direction: 'outbound',
      state: 'sent',
      type: 'text',
      text: 'oi',
      mediaUrl: null,
      mediaMimeType: null,
      fromMe: false,
      providerMessageId: 'FAKE123',
      failReason: null,
      createdAt: '2026-08-11T10:00:00.000Z',
    })
    expect(ok.direction).toBe('outbound')
    expect(ok.createdAt).toBeInstanceOf(Date)
  })

  it('aceita text/mediaUrl/mediaMimeType/providerMessageId nulos (mensagem de mídia recebida ainda sem eco do provider)', () => {
    const ok = messageViewSchema.parse({
      id: UUID,
      direction: 'inbound',
      state: 'received',
      type: 'image',
      text: null,
      mediaUrl: null,
      mediaMimeType: null,
      fromMe: false,
      providerMessageId: null,
      failReason: null,
      createdAt: '2026-08-11T10:00:00.000Z',
    })
    expect(ok.text).toBeNull()
  })

  it('failed carrega failReason para a UI (tooltip da cicatriz — ADR-0006: falha nunca silenciosa)', () => {
    const ok = messageViewSchema.parse({
      id: UUID,
      direction: 'outbound',
      state: 'failed',
      type: 'text',
      text: 'não foi',
      mediaUrl: null,
      mediaMimeType: null,
      fromMe: false,
      providerMessageId: null,
      failReason: 'evolution indisponível (simulado)',
      createdAt: '2026-08-11T10:00:00.000Z',
    })
    expect(ok.failReason).toBe('evolution indisponível (simulado)')
  })

  it('failReason é null em mensagem sem falha', () => {
    const ok = messageViewSchema.parse({
      id: UUID,
      direction: 'inbound',
      state: 'received',
      type: 'text',
      text: 'oi',
      mediaUrl: null,
      mediaMimeType: null,
      fromMe: false,
      providerMessageId: null,
      failReason: null,
      createdAt: '2026-08-11T10:00:00.000Z',
    })
    expect(ok.failReason).toBeNull()
  })

  it('rejeita direction fora do enum inbound/outbound', () => {
    expect(
      messageViewSchema.safeParse({
        id: UUID,
        direction: 'lateral',
        state: 'sent',
        type: 'text',
        text: 'oi',
        mediaUrl: null,
        mediaMimeType: null,
        fromMe: false,
        providerMessageId: null,
        createdAt: '2026-08-11T10:00:00.000Z',
      }).success,
    ).toBe(false)
  })
})
