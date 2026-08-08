import { describe, expect, it } from 'vitest'
import { domainEventSchema } from '../src/index.js'

describe('domainEventSchema', () => {
  it('exige correlationId e schemaVersion desde o evento nº 1', () => {
    const ok = domainEventSchema.parse({
      name: 'MessageReceived',
      companyId: '3b241101-e2bb-4255-8caf-4136c566a962',
      correlationId: '9f8b8a10-1c2d-4e5f-8a9b-0c1d2e3f4a5b',
      schemaVersion: 1,
      occurredAt: '2026-08-08T12:00:00.000Z',
      payload: { messageId: 'abc' },
    })
    expect(ok.occurredAt).toBeInstanceOf(Date)
    expect(domainEventSchema.safeParse({ name: 'X', payload: {} }).success).toBe(false)
  })
})
