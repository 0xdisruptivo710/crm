import { Worker } from 'bullmq'
import { markSendFailed, sendQueuedMessage } from '../pipeline/send-message.js'
import { redisWorkerConnection } from './connection.js'
import { QUEUE } from './queues.js'

interface SendJobData {
  messageId: string
  companyId: string
}

export function startSendWorker(): Worker {
  const worker = new Worker(
    QUEUE.messageSend,
    async (job) => {
      const { messageId, companyId } = job.data as SendJobData
      await sendQueuedMessage(messageId, companyId, job.attemptsMade)
    },
    { connection: redisWorkerConnection },
  )

  // Falha NUNCA silenciosa (regra do CLAUDE.md §4): quando o BullMQ esgota as tentativas
  // (attempts: 3, configuradas no enqueue da rota — apps/api/src/routes/messages.ts), o
  // Message precisa terminar em `failed` com o motivo registrado, não ficar preso em
  // `sending` para sempre. `worker.on('failed')` dispara em TODA tentativa que lança, não
  // só na última — `job.attemptsMade` já reflete as tentativas feitas ATÉ AQUI
  // (incrementado internamente pelo BullMQ antes de emitir este evento), então só agimos
  // quando ele alcança o total configurado (nenhum retry programado depois deste).
  worker.on('failed', (job, err) => {
    if (!job) return
    const attempts = job.opts.attempts ?? 1
    if (job.attemptsMade < attempts) return
    const { messageId, companyId } = job.data as SendJobData
    markSendFailed(messageId, companyId, err.message).catch((markErr: unknown) => {
      console.error('[send worker] falha ao marcar message como failed', markErr)
    })
  })

  return worker
}
