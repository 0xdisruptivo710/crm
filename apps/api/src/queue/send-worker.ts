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

// Achado IMPORTANT da re-review T11 round 2: a varredura precisa se repetir — rodar só na
// subida do processo deixava qualquer `sending` presa DEPOIS do boot silenciosa até o
// próximo restart. 5min: mesma ordem de grandeza da janela de "queued órfã" (não precisa
// ser mais fina que isso; a Message só termina presa por minutos, nunca por horas).
const SWEEP_INTERVAL_MS = 5 * 60 * 1000

export function startSendWorker(): Worker {
  // autorun:false — CRÍTICO (achado da re-review T11 round 2, item 2): sem isso, o Worker
  // já começaria a puxar jobs da fila ENQUANTO a varredura de boot (linha abaixo) ainda
  // está rodando. O PRÓPRIO reenfileiramento de uma `queued` órfã (sweep i) podia ser
  // pego e processado pelo worker (virando `sending` de verdade, envio em voo) enquanto a
  // MESMA chamada de reconcileStuckMessages ainda varria `sending` presas (sweep ii,
  // filtrado só por `createdAt`) — uma corrida da varredura consigo mesma que marcava
  // `failed` um envio genuinamente em andamento, descartando o providerMessageId real
  // quando o eco chegasse depois. `worker.run()` só é chamado DEPOIS do `await` da
  // varredura terminar (via `.finally`), garantindo a ordem mesmo sem o chamador de
  // startSendWorker() esperar essa promise.
  const worker = new Worker(
    QUEUE.messageSend,
    async (job) => {
      const { messageId, companyId } = job.data as SendJobData
      await sendQueuedMessage(messageId, companyId)
    },
    { connection: redisWorkerConnection, autorun: false },
  )

  // Falha NUNCA silenciosa (regra do CLAUDE.md §4). `handleSendFailed` confirma que o job
  // TERMINOU de verdade antes de marcar a Message — ver comentário na própria função.
  worker.on('failed', (job, err) => {
    handleSendFailed(job, err).catch((markErr: unknown) => {
      console.error('[send worker] falha ao marcar message como failed', markErr)
    })
  })

  void reconcileStuckMessages()
    .catch((err: unknown) => {
      console.error('[send worker] falha ao reconciliar mensagens presas na subida', err)
    })
    .finally(() => {
      void worker.run()
    })

  schedulePeriodicSweep(worker)

  return worker
}

// Varredura periódica (achado IMPORTANT da re-review T11 round 2, item 3): a varredura de
// boot sozinha deixava qualquer `sending` presa DEPOIS da subida do processo invisível até
// o próximo restart. `setInterval` com `.unref()` (não impede o processo de encerrar —
// importante em testes e em shutdown gracioso) e uma guarda de reentrância simples
// (booleano): se uma rodada ainda está em andamento quando o timer dispara de novo
// (varredura lenta contra o Postgres remoto, ou muitas linhas presas), pula esta rodada em
// vez de empilhar chamadas concorrentes. Encerrada junto do worker via o evento `closing`.
function schedulePeriodicSweep(worker: Worker): void {
  let sweeping = false
  const timer = setInterval(() => {
    if (sweeping) return
    sweeping = true
    reconcileStuckMessages()
      .catch((err: unknown) => {
        console.error('[send worker] falha na varredura periódica de mensagens presas', err)
      })
      .finally(() => {
        sweeping = false
      })
  }, SWEEP_INTERVAL_MS)
  timer.unref()
  worker.on('closing', () => clearInterval(timer))
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
// webhook-worker.ts (`existing.isFailed()`). O mesmo `UnrecoverableError` é lançado de
// propósito por sendQueuedMessage numa reentrada em `sending` (achado CRÍTICO da re-review
// T11 round 2) — o efeito é o mesmo: terminal já, `isFailed()` verdadeiro na hora.
export async function handleSendFailed(job: Job | undefined, err: Error): Promise<void> {
  if (!job) return
  const { messageId, companyId } = job.data as SendJobData
  const terminal = await job.isFailed()
  if (!terminal) {
    // Ainda não é terminal — BullMQ vai reagendar. Loga mesmo assim: sem isso, uma
    // instabilidade real do provider (ex.: Evolution fora do ar por alguns minutos) fica
    // invisível até a tentativa final, dificultando o diagnóstico de outages em produção.
    console.error('[send] tentativa falhou (retry a caminho)', { messageId, err: err?.message })
    return
  }
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

// Achado CRÍTICO da re-review T11 round 2, item 2(b): sem este filtro, uma linha que
// ACABOU de virar `sending` de verdade (envio genuinamente em voo AGORA) podia ter
// `createdAt` mais velho que SENDING_STUCK_MS (ficou `queued` muito tempo antes de
// finalmente ser pega por um worker) e seria marcada `failed` por engano pela varredura —
// descartando o providerMessageId real quando o eco da Evolution chegasse depois. Consulta
// o BullMQ diretamente: se o jobId (= messageId) ainda está active/waiting/delayed, o
// envio está genuinamente em andamento (ou prestes a rodar) — não é órfão.
async function excludeInFlight(rows: StuckMessage[]): Promise<StuckMessage[]> {
  if (rows.length === 0) return rows
  const inFlight = await messageSendQueue.getJobs(['active', 'waiting', 'delayed'])
  const inFlightIds = new Set(inFlight.map((job) => job.id))
  return rows.filter((row) => !inFlightIds.has(row.id))
}

// Varredura de reconciliação (achado CRÍTICO/IMPORTANT da re-review T11, itens 1 e 5):
// cobre tanto o `queued` órfão (enqueue da rota falhou — item 5) quanto o `sending` preso
// (job "stalled"/crash entre a transição e a confirmação do provider — item 1). Exportada
// para ser chamada diretamente em teste, como reconcileUnprocessedWebhooks.
//
// `filter?.companyId` (fold da re-review T11 round 2, item 4c): a chamada de PRODUÇÃO
// (startSendWorker, acima) nunca passa filtro — precisa varrer TODAS as companies. Testes
// passam `companyId` para escopar a varredura à própria fixture, protegendo o banco de
// dev compartilhado de efeitos colaterais entre suítes.
export async function reconcileStuckMessages(filter?: { companyId?: string }): Promise<{
  requeued: number
  failed: number
}> {
  let requeued = 0
  let failed = 0

  const stuckQueued = await messagesRepo.findStuckQueued(new Date(Date.now() - QUEUED_STUCK_MS), filter?.companyId)
  for (const message of stuckQueued) {
    await reenqueueSend(message)
    requeued += 1
  }

  const stuckSendingRaw = await messagesRepo.findStuckSending(
    new Date(Date.now() - SENDING_STUCK_MS),
    filter?.companyId,
  )
  const stuckSending = await excludeInFlight(stuckSendingRaw)
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
