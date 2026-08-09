import { Worker } from 'bullmq'
import { domainEventSchema } from '@aios-pocket/contracts'
import { redisWorkerConnection } from './connection.js'
import { QUEUE } from './queues.js'
import { getHandlers } from './events.js'

export function startDomainEventsWorker(): Worker {
  return new Worker(
    QUEUE.domainEvents,
    async (job) => {
      const event = domainEventSchema.parse(job.data)
      for (const handler of getHandlers(event.name)) {
        await handler(event)
      }
    },
    { connection: redisWorkerConnection },
  )
}
