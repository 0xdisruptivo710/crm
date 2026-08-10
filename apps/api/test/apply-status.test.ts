import { describe, expect, it } from 'vitest'
import type { MessageState } from '@aios-pocket/contracts'
import { isBlockedFailureAck, nextState } from '../src/pipeline/apply-status.js'

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

  it('received/queued/sending (pré-envio) avançam para qualquer status recebido, inclusive failed', () => {
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

  it('delivered avança para read, ignora regressão/repetição de sent/delivered, BLOQUEIA failed (achado FOLDED da revisão T10)', () => {
    expect(nextState('delivered', 'sent')).toBeNull()
    expect(nextState('delivered', 'delivered')).toBeNull()
    expect(nextState('delivered', 'read')).toBe('read')
    // read/delivered são fatos mais fortes que um ack de falha tardio — a mensagem
    // comprovadamente chegou. nextState bloqueia (null); isBlockedFailureAck sinaliza
    // o motivo para o chamador gravar failReason sem tocar no estado.
    expect(nextState('delivered', 'failed')).toBeNull()
  })

  it('read ignora qualquer regressão (sent/delivered/read repetido) e também BLOQUEIA failed', () => {
    expect(nextState('read', 'sent')).toBeNull()
    expect(nextState('read', 'delivered')).toBeNull()
    expect(nextState('read', 'read')).toBeNull()
    expect(nextState('read', 'failed')).toBeNull()
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

describe('isBlockedFailureAck (sinaliza failReason sem mexer no estado, achado FOLDED da revisão T10)', () => {
  it('true apenas quando o estado atual é delivered ou read e o ack recebido é failed', () => {
    expect(isBlockedFailureAck('delivered', 'failed')).toBe(true)
    expect(isBlockedFailureAck('read', 'failed')).toBe(true)
  })

  it('false para qualquer estado pré-delivered recebendo failed (a transição é aceita, não bloqueada)', () => {
    for (const current of ['received', 'queued', 'sending', 'sent'] as const) {
      expect(isBlockedFailureAck(current, 'failed')).toBe(false)
    }
  })

  it('false quando o ack não é failed, mesmo em delivered/read', () => {
    for (const current of ['delivered', 'read'] as const) {
      expect(isBlockedFailureAck(current, 'sent')).toBe(false)
      expect(isBlockedFailureAck(current, 'delivered')).toBe(false)
      expect(isBlockedFailureAck(current, 'read')).toBe(false)
    }
  })

  it('false quando o estado atual já é failed (terminal — outro branch, não bloqueio)', () => {
    for (const incoming of INCOMING) {
      expect(isBlockedFailureAck('failed', incoming)).toBe(false)
    }
  })

  it('matriz completa: nunca lança, sempre booleano', () => {
    for (const current of ALL_STATES) {
      for (const incoming of INCOMING) {
        expect(() => isBlockedFailureAck(current, incoming)).not.toThrow()
        expect(typeof isBlockedFailureAck(current, incoming)).toBe('boolean')
      }
    }
  })
})
