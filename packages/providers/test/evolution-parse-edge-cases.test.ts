import { describe, expect, it } from 'vitest'
import { parseEvolutionWebhook } from '../src/index.js'
import { STATUS_MAP } from '../src/evolution/parse.js'

// Casos de borda testados com payload SINTÉTICO mínimo (não fixture): Conventions.md
// §3.10 proíbe fixture INVENTADA no diretório compartilhado (tests/providers/fixtures) —
// isso não se aplica a um objeto construído inline para exercitar um branch defensivo
// específico do parser, prática distinta de fabricar uma captura fingindo ser real.

describe('remoteJid @lid no topo (achado da revisão T10)', () => {
  it('messages.upsert com key.remoteJid terminando em @lid é ignorado (null), não vira IncomingMessage com telefone fantasma', () => {
    const raw = {
      event: 'messages.upsert',
      date_time: '2026-08-10T12:00:00.000Z',
      data: {
        key: { id: 'ABC123', fromMe: false, remoteJid: '5511999990099@lid' },
        message: { conversation: 'oi' },
        messageType: 'conversation',
        messageTimestamp: 1786400000,
      },
    }
    expect(parseEvolutionWebhook(raw)).toBeNull()
  })
})

describe('STATUS_MAP (tabela de mapeamento pura, Evolution → contrato normalizado)', () => {
  it('mapeia PENDING e SERVER_ACK para sent (colapsados — sem estado intermediário no contrato)', () => {
    expect(STATUS_MAP.PENDING).toBe('sent')
    expect(STATUS_MAP.SERVER_ACK).toBe('sent')
  })

  it('mapeia DELIVERY_ACK para delivered e READ para read', () => {
    expect(STATUS_MAP.DELIVERY_ACK).toBe('delivered')
    expect(STATUS_MAP.READ).toBe('read')
  })

  it('mapeia ERROR para failed (achado T9/T10: falha de envio genuína não pode virar null)', () => {
    expect(STATUS_MAP.ERROR).toBe('failed')
  })

  it('não tem nenhuma outra chave além das 5 conhecidas (matriz fechada, muda só com decisão explícita)', () => {
    expect(Object.keys(STATUS_MAP).sort()).toEqual(['DELIVERY_ACK', 'ERROR', 'PENDING', 'READ', 'SERVER_ACK'].sort())
  })

  it('messages.update com status ERROR vira MessageStatusUpdate com status failed', () => {
    const raw = {
      event: 'messages.update',
      date_time: '2026-08-10T12:00:00.000Z',
      data: { keyId: 'ABC123', status: 'ERROR' },
    }
    const parsed = parseEvolutionWebhook(raw)
    expect(parsed?.kind).toBe('message_status_update')
    if (parsed?.kind === 'message_status_update') expect(parsed.status).toBe('failed')
  })
})
