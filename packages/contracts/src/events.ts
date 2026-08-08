import { z } from 'zod'

// Evento entre domínios (ADR-0004): publicado após o commit, consumers idempotentes.
export const domainEventSchema = z.object({
  name: z.string().min(1),
  companyId: z.string().uuid(),
  correlationId: z.string().uuid(),
  schemaVersion: z.number().int().positive(),
  occurredAt: z.coerce.date(),
  payload: z.record(z.string(), z.unknown()),
})

export type DomainEvent = z.infer<typeof domainEventSchema>
