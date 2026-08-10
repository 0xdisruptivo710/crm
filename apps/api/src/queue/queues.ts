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

// Compartilhado entre a rota (T6) e a reconciliação de órfãos (T10, worker de
// webhook-processing): erro de processamento não marca `processed` (process-webhook.ts)
// — o job falha e o BullMQ tenta de novo até esgotar as tentativas.
export const WEBHOOK_JOB_RETRY_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
} as const
