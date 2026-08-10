import { describe, expect, it } from 'vitest'
import { sendMessageRequestSchema } from '../src/index.js'

describe('sendMessageRequestSchema (validação compartilhada web/api — POST /messages)', () => {
  it('aceita conversationId (uuid) + text não vazio', () => {
    const ok = sendMessageRequestSchema.parse({
      conversationId: '3b241101-e2bb-4255-8caf-4136c566a962',
      text: 'resposta de teste',
    })
    expect(ok.text).toBe('resposta de teste')
  })

  it('rejeita conversationId que não é uuid', () => {
    expect(
      sendMessageRequestSchema.safeParse({ conversationId: 'não-é-uuid', text: 'oi' }).success,
    ).toBe(false)
  })

  it('rejeita text vazio', () => {
    expect(
      sendMessageRequestSchema.safeParse({
        conversationId: '3b241101-e2bb-4255-8caf-4136c566a962',
        text: '',
      }).success,
    ).toBe(false)
  })

  it('rejeita text acima de 4096 caracteres', () => {
    expect(
      sendMessageRequestSchema.safeParse({
        conversationId: '3b241101-e2bb-4255-8caf-4136c566a962',
        text: 'x'.repeat(4097),
      }).success,
    ).toBe(false)
  })
})
