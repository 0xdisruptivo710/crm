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
// removeOnComplete com TTL >> a janela de reconciliação (60s): mantém o jobId (=raw.id)
// vivo tempo suficiente para o dedupe do PRÓPRIO enqueue de webhook-processing (rota E
// reconciliação usam o mesmo jobId=raw.id) funcionar de verdade, mas não para sempre
// (achado IMPORTANT da revisão T10 — antes, jobs completos nunca expiravam). CORREÇÃO
// (achado FOLDED da revisão T10 round 2): isto NÃO tem relação com o dedupe de
// publishDomainEvent — aquele vive na fila domain-events, com seu próprio TTL de 24h
// (ver queue/events.ts). removeOnFail fica DE PROPÓSITO sem valor: um job falho é o sinal
// que a reconciliação usa para saber que precisa remover e re-dirigir (webhook-worker.ts).
export const WEBHOOK_JOB_RETRY_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { age: 7 * 24 * 3600 },
} as const

// Compartilhado entre a rota (apps/api/src/routes/messages.ts) e a varredura de
// reconciliação de mensagens presas (queue/send-worker.ts, achado IMPORTANT da re-review
// T11 — item 5): as duas precisam enfileirar `message-send` com as MESMAS opções,
// nunca duas definições divergentes (regra do CLAUDE.md §4).
// removeOnFail fica DE PROPÓSITO sem valor (mesmo raciocínio de WEBHOOK_JOB_RETRY_OPTIONS
// acima): um job `failed` é o sinal que `reenqueueSend` usa para saber que precisa
// remover o job morto antes de reenfileirar com o mesmo jobId — se removêssemos o job
// automaticamente ao falhar, a varredura nunca saberia que aquele jobId estava "sujo" e o
// `.add()` idempotente do BullMQ ficaria mudo (ignora silenciosamente um add com jobId
// repetido enquanto o job antigo, ainda vivo, existir).
export const MESSAGE_SEND_JOB_RETRY_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { age: 7 * 24 * 3600 },
} as const
