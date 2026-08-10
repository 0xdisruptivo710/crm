import { Worker } from 'bullmq'
import { prisma } from '@aios-pocket/db'
import { processRawWebhook } from '../pipeline/process-webhook.js'
import { redisWorkerConnection } from './connection.js'
import { QUEUE, WEBHOOK_JOB_RETRY_OPTIONS, webhookProcessingQueue } from './queues.js'

// Janela mínima antes de considerar um raw "órfão de fila" (T6: enqueue pode falhar
// depois do arquivamento já ter acontecido — a rota assume esse risco de propósito).
// 60s dá folga confortável para o caminho feliz (enqueue + processamento normal).
const RECONCILE_MIN_AGE_MS = 60_000

export function startWebhookWorker(): Worker {
  const worker = new Worker(
    QUEUE.webhookProcessing,
    async (job) => {
      await processRawWebhook(job.data.rawEventId as string)
    },
    { connection: redisWorkerConnection },
  )

  // Roda uma vez na subida do processo — não é um cron, é a rede de segurança do
  // restart para o cenário órfão descrito na revisão da Task 6.
  void reconcileUnprocessedWebhooks().catch((err: unknown) => {
    console.error('[webhook worker] falha ao reconciliar webhooks não processados', err)
  })

  return worker
}

// Reenfileira raws com processed=false mais velhos que RECONCILE_MIN_AGE_MS — cobre o
// caso em que o `.add()` da rota falhou (Redis fora do ar no momento do POST) e o
// payload ficou arquivado sem nunca entrar na fila. jobId=raw.id torna o reenqueue
// idempotente: se o job ainda existir na fila (BullMQ não cria duplicata) ou já tiver
// sido processado (processRawWebhook é idempotente via `processed`), não há efeito colateral.
export async function reconcileUnprocessedWebhooks(): Promise<number> {
  const cutoff = new Date(Date.now() - RECONCILE_MIN_AGE_MS)
  const orphaned = await prisma.rawWebhookEvent.findMany({
    where: { processed: false, receivedAt: { lt: cutoff } },
  })
  for (const raw of orphaned) {
    await webhookProcessingQueue.add(
      'process',
      { rawEventId: raw.id, provider: raw.provider, companyId: raw.companyId },
      { jobId: raw.id, ...WEBHOOK_JOB_RETRY_OPTIONS },
    )
  }
  return orphaned.length
}
