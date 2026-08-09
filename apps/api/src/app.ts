import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { enterTenant, getTenant, resolveUserByAuthId } from '@aios-pocket/db'
import { verifySupabaseJwt } from './auth/verify.js'

// Rotas sem auth: health e webhooks (webhooks autenticam por token de instância — Plano B).
const PUBLIC_PREFIXES = ['/health', '/webhooks/']

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: true, genReqId: () => randomUUID() })

  app.addHook('preHandler', async (req, reply) => {
    if (PUBLIC_PREFIXES.some((p) => req.url.startsWith(p))) return
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'não autenticado' })
    }
    try {
      const { sub } = await verifySupabaseJwt(header.slice('Bearer '.length))
      const user = await resolveUserByAuthId(sub)
      if (!user) return reply.code(401).send({ error: 'usuário não cadastrado' })
      enterTenant({ companyId: user.companyId })
    } catch {
      return reply.code(401).send({ error: 'token inválido' })
    }
  })

  app.get('/health', async () => ({ status: 'ok' }))

  // Rota protegida mínima: prova o fluxo auth → tenant (e serve à UI no Plano C).
  app.get('/me', async () => {
    const { companyId } = getTenant()
    return { companyId }
  })

  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'rota inexistente' }))

  return app
}
