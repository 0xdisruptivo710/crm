import { Queue } from 'bullmq'
import { redisConnection } from './connection.js'

export const QUEUE = {
  webhookProcessing: 'webhook-processing',
  messageSend: 'message-send',
  domainEvents: 'domain-events',
} as const

export const webhookProcessingQueue = new Queue(QUEUE.webhookProcessing, { connection: redisConnection })
export const messageSendQueue = new Queue(QUEUE.messageSend, { connection: redisConnection })
export const domainEventsQueue = new Queue(QUEUE.domainEvents, { connection: redisConnection })
