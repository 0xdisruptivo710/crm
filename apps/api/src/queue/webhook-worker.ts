import { Worker } from 'bullmq'
import { prisma } from '@aios-pocket/db'
import { processRawWebhook } from '../pipeline/process-webhook.js'
import { redisWorkerConnection } from './connection.js'
import { QUEUE, WEBHOOK_JOB_RETRY_OPTIONS, webhookProcessingQueue } from './queues.js'

// Janela mínima antes de considerar um raw "órfão de fila" (T6: enqueue pode falhar
// depois do arquivamento já ter acontecido — a rota assume esse risco de propósito).
// 60s dá folga confortável para o caminho feliz (enqueue + processamento normal).
const RECONCILE_MIN_AGE_MS = 60_000

// Lote da paginação por cursor (item 4 da revisão T10): evita carregar a tabela inteira
// de raws não processados em memória de uma vez — a query já é limitada por índice
// (@@index([processed, receivedAt]) em schema.prisma), mas sem paginação o findMany
// ainda poderia devolver um resultado gigante numa reconciliação atrasada.
const RECONCILE_BATCH_SIZE = 200

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

interface OrphanedRaw {
  id: string
  provider: string
  companyId: string | null
}

// Reenfileira um raw órfão. Se já existe um job com esse jobId em estado 'failed'
// (esgotou as 3 tentativas), o BullMQ IGNORA silenciosamente um novo `.add()` com o
// mesmo jobId enquanto o job antigo existir — sem remover o job morto primeiro, a
// reconciliação nunca conseguiria re-dirigir um job exaurido (achado IMPORTANT da
// revisão T10). Job ainda 'waiting'/'active'/'completed' não precisa de remoção: o
// `.add()` idempotente do BullMQ ou o `processed=true` do use case já cobrem esses casos.
async function reenqueueOrphan(raw: OrphanedRaw): Promise<void> {
  const existing = await webhookProcessingQueue.getJob(raw.id)
  if (existing && (await existing.isFailed())) {
    await existing.remove()
  }
  await webhookProcessingQueue.add(
    'process',
    { rawEventId: raw.id, provider: raw.provider, companyId: raw.companyId },
    { jobId: raw.id, ...WEBHOOK_JOB_RETRY_OPTIONS },
  )
}

// Reenfileira raws com processed=false mais velhos que RECONCILE_MIN_AGE_MS — cobre o
// caso em que o `.add()` da rota falhou (Redis fora do ar no momento do POST) e o
// payload ficou arquivado sem nunca entrar na fila. Paginado por cursor em lotes de
// RECONCILE_BATCH_SIZE (item 4 da revisão T10) e projetando só os campos usados
// (`select`) — nunca carrega a linha inteira (payload pode ser grande) nem a tabela
// inteira de uma vez.
export async function reconcileUnprocessedWebhooks(): Promise<number> {
  const cutoff = new Date(Date.now() - RECONCILE_MIN_AGE_MS)
  let cursor: string | undefined
  let total = 0

  for (;;) {
    const batch = await prisma.rawWebhookEvent.findMany({
      where: { processed: false, receivedAt: { lt: cutoff } },
      select: { id: true, provider: true, companyId: true },
      orderBy: { id: 'asc' },
      take: RECONCILE_BATCH_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    })
    if (batch.length === 0) break

    for (const raw of batch) {
      await reenqueueOrphan(raw)
      total += 1
    }

    cursor = batch[batch.length - 1]?.id
    if (batch.length < RECONCILE_BATCH_SIZE) break
  }

  return total
}
