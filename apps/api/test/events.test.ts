import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Worker } from 'bullmq'

// Teste de integração: exige Redis remoto acessível (ver .env REDIS_URL).
import { onDomainEvent, publishDomainEvent } from '../src/queue/events.js'
import { startDomainEventsWorker } from '../src/queue/workers.js'
import { domainEventsQueue, webhookProcessingQueue, messageSendQueue } from '../src/queue/queues.js'
import { redisWorkerConnection, redisQueueConnection } from '../src/queue/connection.js'

let worker: Worker | undefined

beforeAll(async () => {
  // Redis é remoto e compartilhado entre execuções: drena jobs antigos
  // desta fila específica para não reprocessar eventos de runs anteriores.
  //
  // LIMITE CONHECIDO: drain() apaga qualquer job em voo dessa fila no momento
  // em que roda — inclusive de uma execução concorrente. Isso só é seguro
  // hoje porque (a) o CI roda contra um Redis efêmero próprio, sem
  // concorrência entre runs, e (b) este Redis remoto de dev é de uso único
  // (single-developer) — não há outra pessoa/processo publicando nele ao
  // mesmo tempo. Se a equipe crescer e mais de uma pessoa/CI rodar a suíte
  // contra o mesmo Redis simultaneamente, isso deixa de ser seguro; nesse
  // cenário, isolar por run (ex.: nome de fila único por execução) antes de
  // manter esse drain().
  await domainEventsQueue.drain()
})

afterAll(async () => {
  await worker?.close()
  await domainEventsQueue.close()
  await webhookProcessingQueue.close()
  await messageSendQueue.close()
  await redisWorkerConnection.quit()
  await redisQueueConnection.quit()
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
