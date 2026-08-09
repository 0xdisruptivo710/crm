import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { enterTenant, getTenant, resolveUserByAuthId } from '@aios-pocket/db'
import { verifySupabaseJwt } from './auth/verify.js'

// Predicate para rotas públicas: exatamente /health (com/sem query), e /webhooks/* (sem auth).
// Nota: /health é pública sem restrição; /webhooks/ deve estar presente mas a autorização
// daquela rota depende do token de instância (Plano B), não do JWT de usuário.
// Limitar com startsWith('/' . 'prefixo') causaria falsos positivos (/healthcheck, /healthz, etc).
function isPublicUrl(url: string): boolean {
  // Exatamente /health com querystring opcional
  if (url === '/health' || url.startsWith('/health?')) return true
  // Prefixo /webhooks/ requer slash para evitar /webhooksexec ou similar
  if (url.startsWith('/webhooks/')) return true
  return false
}

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: true, genReqId: () => randomUUID() })

  app.addHook('preHandler', async (req, reply) => {
    if (isPublicUrl(req.url)) return
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'não autenticado' })
    }
    try {
      const { sub } = await verifySupabaseJwt(header.slice('Bearer '.length))
      const user = await resolveUserByAuthId(sub)
      if (!user) return reply.code(401).send({ error: 'usuário não cadastrado' })
      enterTenant({ companyId: user.companyId })
    } catch (err) {
      req.log.warn({ err }, 'falha de autenticação')
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
