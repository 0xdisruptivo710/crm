import { describe, expect, it } from 'vitest'
import type { MessageState } from '@aios-pocket/contracts'
import { nextState } from '../src/pipeline/apply-status.js'

// Estados possíveis do lado "corrente" (guardados na Message) e do lado "recebido"
// (o que a Evolution/Z-API manda no ack) — matriz completa (ADR-0006).
const ALL_STATES: MessageState[] = ['received', 'queued', 'sending', 'sent', 'delivered', 'read', 'failed']
const INCOMING: Array<'sent' | 'delivered' | 'read' | 'failed'> = ['sent', 'delivered', 'read', 'failed']

describe('nextState (máquina de estados de Message, pura, ADR-0006)', () => {
  it('failed é terminal: nenhuma transição sai dele', () => {
    for (const incoming of INCOMING) {
      expect(nextState('failed', incoming)).toBeNull()
    }
  })

  it('received/queued/sending (pré-envio) avançam para qualquer status recebido', () => {
    for (const current of ['received', 'queued', 'sending'] as const) {
      expect(nextState(current, 'sent')).toBe('sent')
      expect(nextState(current, 'delivered')).toBe('delivered')
      expect(nextState(current, 'read')).toBe('read')
      expect(nextState(current, 'failed')).toBe('failed')
    }
  })

  it('sent avança para delivered/read/failed, mas repetir "sent" é no-op', () => {
    expect(nextState('sent', 'sent')).toBeNull()
    expect(nextState('sent', 'delivered')).toBe('delivered')
    expect(nextState('sent', 'read')).toBe('read')
    expect(nextState('sent', 'failed')).toBe('failed')
  })

  it('delivered avança para read/failed, ignora regressão para sent e repetição', () => {
    expect(nextState('delivered', 'sent')).toBeNull()
    expect(nextState('delivered', 'delivered')).toBeNull()
    expect(nextState('delivered', 'read')).toBe('read')
    expect(nextState('delivered', 'failed')).toBe('failed')
  })

  it('read ignora qualquer regressão (sent/delivered/read repetido)', () => {
    expect(nextState('read', 'sent')).toBeNull()
    expect(nextState('read', 'delivered')).toBeNull()
    expect(nextState('read', 'read')).toBeNull()
  })

  it('matriz completa: toda combinação retorna null ou um MessageState válido, nunca lança', () => {
    for (const current of ALL_STATES) {
      for (const incoming of INCOMING) {
        expect(() => nextState(current, incoming)).not.toThrow()
        const result = nextState(current, incoming)
        expect(result === null || ALL_STATES.includes(result)).toBe(true)
      }
    }
  })
})
