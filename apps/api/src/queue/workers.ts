import { Worker } from 'bullmq'
import { domainEventSchema } from '@aios-pocket/contracts'
import { redisWorkerConnection } from './connection.js'
import { QUEUE } from './queues.js'
import { getHandlers } from './events.js'

export function startDomainEventsWorker(): Worker {
  const worker = new Worker(
    QUEUE.domainEvents,
    async (job) => {
      const event = domainEventSchema.parse(job.data)
      for (const handler of getHandlers(event.name)) {
        await handler(event)
      }
    },
    { connection: redisWorkerConnection },
  )

  // Hardening batch C, Step 1: o evento 'error' do Worker (erro de INFRA — conexão com o
  // Redis, por exemplo) é diferente do evento 'failed' (um JOB específico que lançou).
  // Sem este handler, um EventEmitter que recebe 'error' sem listener derruba o processo
  // Node inteiro (unhandled 'error' event) — fatal neste repo porque API e workers vivem
  // no MESMO processo (CLAUDE.md §2): um blip de infra no worker de domain-events matava
  // a API junto.
  worker.on('error', (err) => console.error('[domain events worker] erro do worker bullmq', err.message))

  return worker
}
