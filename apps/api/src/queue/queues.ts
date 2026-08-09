import { Queue } from 'bullmq'
import { redisQueueConnection } from './connection.js'

export const QUEUE = {
  webhookProcessing: 'webhook-processing',
  messageSend: 'message-send',
  domainEvents: 'domain-events',
} as const

// Producers usam redisQueueConnection (falha rápido) — nunca a conexão do worker.
export const webhookProcessingQueue = new Queue(QUEUE.webhookProcessing, { connection: redisQueueConnection })
export const messageSendQueue = new Queue(QUEUE.messageSend, { connection: redisQueueConnection })
export const domainEventsQueue = new Queue(QUEUE.domainEvents, { connection: redisQueueConnection })
