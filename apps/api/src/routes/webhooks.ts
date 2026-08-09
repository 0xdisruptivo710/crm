import type { FastifyInstance } from 'fastify'
import { companiesRepo, prisma } from '@aios-pocket/db'
import { webhookProcessingQueue } from '../queue/queues.js'

const PROVIDERS = ['evolution', 'zapi'] as const
type ProviderParam = (typeof PROVIDERS)[number]

// Arquiva ANTES de qualquer parse e responde 200 imediato (ADR-0003):
// payload cru nunca se perde; processamento é assíncrono via BullMQ.
export function registerWebhookRoutes(app: FastifyInstance): void {
  app.post<{ Params: { provider: string; webhookToken: string } }>(
    '/webhooks/:provider/:webhookToken',
    async (req, reply) => {
      const provider = req.params.provider as ProviderParam
      if (!PROVIDERS.includes(provider)) return reply.code(404).send({ error: 'provider desconhecido' })
      const company = await companiesRepo.findByWebhookToken(req.params.webhookToken)
      if (!company) return reply.code(404).send({ error: 'token desconhecido' })

      const raw = await prisma.rawWebhookEvent.create({
        data: { provider, companyId: company.id, payload: req.body as object },
      })
      await webhookProcessingQueue.add(
        'process',
        { rawEventId: raw.id, provider, companyId: company.id },
        { jobId: raw.id },
      )
      return reply.code(200).send({ received: true })
    },
  )
}
