import type { FastifyInstance, FastifyRequest } from 'fastify'
import { companiesRepo, prisma } from '@aios-pocket/db'
import { webhookProcessingQueue } from '../queue/queues.js'

const PROVIDERS = ['evolution', 'zapi'] as const
type ProviderParam = (typeof PROVIDERS)[number]

// Parser de content-type passthrough: entrega o Buffer bruto sem tentar nenhum parse —
// nem o Fastify pode decidir que o body é inválido antes do handler rodar (ADR-0003).
function passthrough(_req: FastifyRequest, body: Buffer, done: (err: Error | null, body?: unknown) => void): void {
  done(null, body)
}

// Body cru pode chegar malformado, vazio, ou sem content-type — nenhum desses casos pode
// virar 4xx/5xx do parser do Fastify ANTES do handler (ADR-0003: payload cru nunca se
// perde). O parse de JSON é tentado aqui, manualmente, com fallback explícito para cada caso.
function toArchivablePayload(raw: Buffer): object {
  const rawText = raw.toString('utf8')
  if (rawText.length === 0) return { empty_body: true }
  try {
    return JSON.parse(rawText) as object
  } catch {
    return { raw_text: rawText, parse_error: true }
  }
}

// Arquiva ANTES de qualquer parse e responde 200 imediato (ADR-0003):
// payload cru nunca se perde; processamento é assíncrono via BullMQ.
export function registerWebhookRoutes(app: FastifyInstance): void {
  // Plugin encapsulado: o parser permissivo abaixo vale só para estas rotas — não
  // pode vazar para /me, /health etc, que continuam com o parser JSON padrão do Fastify.
  void app.register(async (scope) => {
    // Sem isto, o Fastify rejeita (400 FST_ERR_CTP_EMPTY_JSON_BODY / 400 JSON inválido /
    // 415 sem content-type) ANTES do handler — nada seria arquivado e o provider veria 4xx.
    // Sobrescrevemos 'application/json' explicitamente (senão o parser padrão herdado do
    // escopo pai continuaria valendo aqui — content-type exato tem prioridade sobre '*')
    // e '*' para qualquer outro content-type, incluindo ausente.
    scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, passthrough)
    scope.addContentTypeParser('*', { parseAs: 'buffer' }, passthrough)

    scope.post<{ Params: { provider: string; webhookToken: string } }>(
      '/webhooks/:provider/:webhookToken',
      async (req, reply) => {
        const provider = req.params.provider as ProviderParam
        if (!PROVIDERS.includes(provider)) return reply.code(404).send({ error: 'provider desconhecido' })
        const company = await companiesRepo.findByWebhookToken(req.params.webhookToken)
        if (!company) return reply.code(404).send({ error: 'token desconhecido' })

        const payload = toArchivablePayload(req.body as Buffer)
        const raw = await prisma.rawWebhookEvent.create({
          data: { provider, companyId: company.id, payload },
        })
        try {
          await webhookProcessingQueue.add(
            'process',
            { rawEventId: raw.id, provider, companyId: company.id },
            { jobId: raw.id },
          )
        } catch (err) {
          // Falha ao enfileirar NÃO pode virar 5xx: o payload já está arquivado (invariante
          // cumprida) — o worker da Task 10 reconcilia linhas com processed=false órfãs de fila.
          req.log.error({ err, rawEventId: raw.id }, 'falha ao enfileirar webhook — arquivado, aguardando reconciliação')
        }
        return reply.code(200).send({ received: true })
      },
    )
  })
}
