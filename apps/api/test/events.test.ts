import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Worker } from 'bullmq'

// Teste de integração: exige Redis remoto acessível (ver .env REDIS_URL).
import { onDomainEvent, publishDomainEvent } from '../src/queue/events.js'
import { startDomainEventsWorker } from '../src/queue/workers.js'
import { domainEventsQueue, webhookProcessingQueue, messageSendQueue } from '../src/queue/queues.js'
import { redisWorkerConnection, redisQueueConnection } from '../src/queue/connection.js'
import { assertTestRedis } from './redis-guard.js'

let worker: Worker | undefined

beforeAll(async () => {
  // Antes de QUALQUER obliterate: recusa rodar contra o Redis vivo do piloto (mesmo env
  // que as filas de produção consomem — config.REDIS_URL).
  assertTestRedis(process.env.REDIS_URL ?? 'redis://localhost:6379')
  // Redis é remoto e compartilhado entre execuções: limpa a fila ANTES de rodar, para
  // não reprocessar (nem competir com) backlog de execuções anteriores. obliterate
  // (force: true) em vez do antigo drain(): outros arquivos deste pacote (ex.:
  // pipeline-inbound.test.ts, T10) publicam em `domain-events` sem nunca consumir —
  // drain() só limpa jobs 'wait', deixando 'active'/'failed' represados, que um worker
  // novo tentaria varrer antes do job do PRÓPRIO teste, e era a raiz real da flakiness
  // recorrente aqui (achado FOLDED da revisão T10 — "os testes paralelos desta task
  // agravam"). obliterate remove a fila inteira, em qualquer estado.
  //
  // LIMITE CONHECIDO (herdado do drain original): isso só é seguro hoje porque (a) o CI
  // roda contra um Redis efêmero próprio, sem concorrência entre runs, e (b) este Redis
  // remoto de dev é de uso único (single-developer). Se a equipe crescer e mais de uma
  // pessoa/CI rodar a suíte contra o mesmo Redis simultaneamente, isolar por run (ex.:
  // nome de fila único por execução) antes de manter essa limpeza destrutiva.
  await domainEventsQueue.obliterate({ force: true })
})

afterAll(async () => {
  await worker?.close()
  await domainEventsQueue.close()
  await webhookProcessingQueue.close()
  await messageSendQueue.close()
  await redisWorkerConnection.quit()
  await redisQueueConnection.quit()
})

describe('eventos de domínio (ADR-0004)', () => {
  it(
    'publicação em duplicata processa uma única vez (jobId por correlationId)',
    async () => {
      const processados: string[] = []
      onDomainEvent('TesteEvento', async (e) => {
        processados.push(e.correlationId)
      })
      worker = startDomainEventsWorker()

      const event = {
        name: 'TesteEvento',
        companyId: randomUUID(),
        correlationId: randomUUID(),
        schemaVersion: 1,
        occurredAt: new Date(),
        payload: { valor: 42 },
      }

      // Espera o evento 'completed' do worker, não um sleep fixo (achado FOLDED da
      // revisão T10 — raiz da flakiness recorrente: 3000ms às vezes não bastava sob a
      // carga concorrente que os testes paralelos deste pacote colocam no mesmo Redis
      // remoto compartilhado). Listener registrado ANTES do publish — sem corrida.
      const completed = new Promise<void>((resolve, reject) => {
        worker?.on('completed', (job) => {
          if (job.data?.correlationId === event.correlationId) resolve()
        })
        worker?.on('failed', (job, err) => {
          if (job?.data?.correlationId === event.correlationId) reject(err)
        })
      })

      await publishDomainEvent(event)
      await publishDomainEvent(event)
      await completed

      // Grace period curta e limitada: sem isso, o teste "passa" só por ter observado a
      // PRIMEIRA conclusão — não prova que não havia uma segunda em voo (achado FOLDED da
      // revisão T10 round 2). Se o dedupe por jobId quebrasse, a segunda publicação teria
      // virado um job PRÓPRIO, ainda pendente/ativo neste instante.
      await new Promise((resolve) => setTimeout(resolve, 500))
      const counts = await domainEventsQueue.getJobCounts('waiting', 'active', 'delayed')
      expect((counts.waiting ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0)).toBe(0)

      expect(processados).toEqual([event.correlationId])
    },
    20000,
  )
})
