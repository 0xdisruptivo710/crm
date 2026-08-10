import type { Job } from 'bullmq'
import { Worker } from 'bullmq'
import { messagesRepo } from '@aios-pocket/db'
import { markSendFailed, sendQueuedMessage } from '../pipeline/send-message.js'
import { redisWorkerConnection } from './connection.js'
import { MESSAGE_SEND_JOB_RETRY_OPTIONS, QUEUE, messageSendQueue } from './queues.js'

interface SendJobData {
  messageId: string
  companyId: string
}

// Janelas da varredura de reconciliação (achado CRÍTICO/IMPORTANT da re-review T11, itens
// 1 e 5) — mesmo espírito de RECONCILE_MIN_AGE_MS em webhook-worker.ts, mas com dois
// limiares distintos porque `queued` e `sending` representam riscos diferentes:
// - `queued` órfã (enqueue da rota falhou, ou o job sumiu por algum motivo): é SEGURO
//   reenfileirar — o envio real nunca saiu.
// - `sending` presa (crash/stall entre a transição e a confirmação do provider): NÃO é
//   seguro reenviar — não há como saber se o provider já foi chamado. Marca `failed`
//   como cicatriz visível, nunca reenvio automático (ver send-message.ts).
const QUEUED_STUCK_MS = 5 * 60 * 1000
const SENDING_STUCK_MS = 10 * 60 * 1000

export function startSendWorker(): Worker {
  const worker = new Worker(
    QUEUE.messageSend,
    async (job) => {
      const { messageId, companyId } = job.data as SendJobData
      await sendQueuedMessage(messageId, companyId)
    },
    { connection: redisWorkerConnection },
  )

  // Falha NUNCA silenciosa (regra do CLAUDE.md §4). `handleSendFailed` confirma que o job
  // TERMINOU de verdade antes de marcar a Message — ver comentário na própria função.
  worker.on('failed', (job, err) => {
    handleSendFailed(job, err).catch((markErr: unknown) => {
      console.error('[send worker] falha ao marcar message como failed', markErr)
    })
  })

  // Roda uma vez na subida do processo — não é um cron, é a rede de segurança do restart
  // (mesmo padrão de reconcileUnprocessedWebhooks em webhook-worker.ts).
  reconcileStuckMessages().catch((err: unknown) => {
    console.error('[send worker] falha ao reconciliar mensagens presas', err)
  })

  return worker
}

// Handler do evento `failed` do Worker, extraído para ser testável diretamente (achado
// IMPORTANT da re-review T11, item 4).
//
// VERIFICAÇÃO (registrada para a re-review, contra o Lua/JS instalado do bullmq@5.81.3):
// o evento `failed` do Worker dispara em TODA tentativa que lança — inclusive quando o
// BullMQ ainda vai reagendar um retry (worker.js `handleFailed`: `await job.moveToFailed(...)`
// seguido de `this.emit('failed', ...)` SEM condicional sobre o resultado). A decisão de
// retry-vs-terminal acontece DENTRO de `job.moveToFailed` (via `shouldRetryJob`, que checa
// `attemptsMade+1 < attempts` E `!(err instanceof UnrecoverableError)`) e não é exposta de
// volta ao chamador do evento — ou seja, a hipótese de "failed só dispara na tentativa
// final" NÃO se confirmou; por isso `job.attemptsMade` (usado na 1ª versão desta função)
// também não é confiável para decidir isso: quando um job é recuperado de "stalled" mais
// de `maxStalledCount` vezes, o BullMQ o marca com `deferredFailure` e a PRÓXIMA execução
// lança `UnrecoverableError` DIRETO — isso força `shouldRetry=false` (terminal) só por ser
// Unrecoverable, mas `attemptsMade` pode estar bem abaixo de `attempts`
// (moveStalledJobsToWait-9.lua: "job stalled more than allowable limit"). A checagem
// correta e documentada é `job.isFailed()` — consulta direta ao Redis se o job está no
// ZSET `failed` (terminal de verdade) — o MESMO padrão já usado neste repo em
// webhook-worker.ts (`existing.isFailed()`).
export async function handleSendFailed(job: Job | undefined, err: Error): Promise<void> {
  if (!job) return
  const terminal = await job.isFailed()
  if (!terminal) return // BullMQ ainda vai reagendar esta tentativa — nada a fazer aqui
  const { messageId, companyId } = job.data as SendJobData
  await markSendFailed(messageId, companyId, err.message)
}

interface StuckMessage {
  id: string
  companyId: string
}

async function reenqueueSend(message: StuckMessage): Promise<void> {
  // Mesmo cuidado de reenqueueOrphan (webhook-worker.ts): um job com o mesmo jobId ainda
  // 'failed' (esgotado) faz o BullMQ ignorar silenciosamente um novo `.add()`.
  const existing = await messageSendQueue.getJob(message.id)
  if (existing && (await existing.isFailed())) {
    await existing.remove()
  }
  await messageSendQueue.add(
    'send',
    { messageId: message.id, companyId: message.companyId },
    { jobId: message.id, ...MESSAGE_SEND_JOB_RETRY_OPTIONS },
  )
}

// Varredura de reconciliação (achado CRÍTICO/IMPORTANT da re-review T11, itens 1 e 5):
// cobre tanto o `queued` órfão (enqueue da rota falhou — item 5) quanto o `sending` preso
// (job "stalled"/crash entre a transição e a confirmação do provider — item 1). Exportada
// para ser chamada diretamente em teste, como reconcileUnprocessedWebhooks.
export async function reconcileStuckMessages(): Promise<{ requeued: number; failed: number }> {
  let requeued = 0
  let failed = 0

  const stuckQueued = await messagesRepo.findStuckQueued(new Date(Date.now() - QUEUED_STUCK_MS))
  for (const message of stuckQueued) {
    await reenqueueSend(message)
    requeued += 1
  }

  const stuckSending = await messagesRepo.findStuckSending(new Date(Date.now() - SENDING_STUCK_MS))
  for (const message of stuckSending) {
    // Limitação aceita, documentada (exigência da re-review T11): não há como saber, a
    // esta altura, se o envio real chegou a sair ou não. Se saiu, o eco da Evolution (a
    // guarda fromMe de process-webhook.ts) cria a linha outbound CANÔNICA via pipeline
    // inbound, com o providerMessageId real. Esta linha aqui — presa em `sending` — vira
    // `failed`: uma cicatriz visível no histórico, nunca silêncio, nunca reenvio
    // automático (reenviar arriscaria duplicar uma mensagem real para o cliente).
    await markSendFailed(message.id, message.companyId, 'estado incerto (crash durante envio)')
    failed += 1
  }

  return { requeued, failed }
}
