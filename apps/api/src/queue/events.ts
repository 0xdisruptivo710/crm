import { type DomainEvent, domainEventSchema } from '@aios-pocket/contracts'
import { domainEventsQueue } from './queues.js'

type Handler = (event: DomainEvent) => Promise<void>

const handlers = new Map<string, Handler[]>()

export function onDomainEvent(name: string, handler: Handler): void {
  handlers.set(name, [...(handlers.get(name) ?? []), handler])
}

export function getHandlers(name: string): Handler[] {
  return handlers.get(name) ?? []
}

// Publicar SEMPRE depois do commit da transação (ADR-0004).
// jobId dedupa a PUBLICAÇÃO enquanto o job vive na fila; a garantia
// permanente de idempotência é responsabilidade dos consumers.
// Obs.: separador é '-', não ':' — o BullMQ 5.x reserva jobId com ':' para
// o formato interno de jobs repetíveis (rejeita ids com ':' que não tenham
// exatamente 3 partes ao dar split).
export async function publishDomainEvent(event: DomainEvent): Promise<void> {
  domainEventSchema.parse(event)
  await domainEventsQueue.add(event.name, event, {
    jobId: `${event.name}-${event.correlationId}`,
    removeOnComplete: { age: 24 * 3600 },
    removeOnFail: false,
  })
}
