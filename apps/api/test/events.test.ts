import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Worker } from 'bullmq'

// Teste de integração: exige Redis remoto acessível (ver .env REDIS_URL).
import { onDomainEvent, publishDomainEvent } from '../src/queue/events.js'
import { startDomainEventsWorker } from '../src/queue/workers.js'
import { domainEventsQueue } from '../src/queue/queues.js'
import { redisConnection } from '../src/queue/connection.js'

let worker: Worker | undefined

beforeAll(async () => {
  // Redis é remoto e compartilhado entre execuções: drena jobs antigos
  // desta fila específica para não reprocessar eventos de runs anteriores.
  await domainEventsQueue.drain()
})

afterAll(async () => {
  await worker?.close()
  await domainEventsQueue.close()
  await redisConnection.quit()
})

describe('eventos de domínio (ADR-0004)', () => {
  it(
    'publicação em duplicata processa uma única vez (jobId por correlationId)',
    async () => {
      const processados: string[] = []
      onDomainEvent('TesteEvento', async (e) => {
        processados.push(e.correlationId)
      })
      worker = startDomainEventsWorker()

      const event = {
        name: 'TesteEvento',
        companyId: randomUUID(),
        correlationId: randomUUID(),
        schemaVersion: 1,
        occurredAt: new Date(),
        payload: { valor: 42 },
      }
      await publishDomainEvent(event)
      await publishDomainEvent(event)

      await new Promise((resolve) => setTimeout(resolve, 3000))
      expect(processados).toEqual([event.correlationId])
    },
    20000,
  )
})
