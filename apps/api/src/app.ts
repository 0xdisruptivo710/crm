import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { runWithTenant, getTenant, resolveUserByAuthId } from '@aios-pocket/db'
import { verifySupabaseJwt } from './auth/verify.js'
import { registerWebhookRoutes } from './routes/webhooks.js'

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

  // Hook em estilo callback (não async) registrado em onRequest, não preHandler.
  //
  // POR QUE não pode ser um preHandler `async`: um hook async do Fastify tem sua
  // continuação (o resto do ciclo da request, incluindo o handler) anexada à Promise
  // do hook na PRIMEIRA suspensão (o primeiro `await`) — não no fim da função. Isso
  // significa que qualquer `enterWith()` chamado DEPOIS de um `await` já roda fora da
  // cadeia assíncrona que o Fastify vai retomar para o handler: o AsyncLocalStorage não
  // se propaga. Isso foi provado empiricamente neste repo, no Fastify 5.11.3 + Node 24,
  // em ambos os modos de ALS: com `preHandler: async` chamando `enterTenant()` (que usa
  // `storage.enterWith`) após os `await`s de verifySupabaseJwt/resolveUserByAuthId,
  // `GET /me` com usuário válido lançava "TenantContext ausente" → 500.
  //
  // A correção comprovada é usar o estilo callback (`done`) do Fastify: fazemos o
  // trabalho assíncrono (verificação de JWT, lookup do usuário) via Promise comum e,
  // no `.then()` final — ainda dentro do mesmo hook, mas agora de forma síncrona em
  // relação ao `done()` — chamamos `runWithTenant(ctx, () => done())`. `runWithTenant`
  // usa `storage.run`, que cria o contexto e chama `done()` SINCRONAMENTE dentro da
  // janela do `storage.run`. O Fastify então continua o ciclo da request (preHandler
  // seguintes, handler) a partir de dentro dessa chamada síncrona de `done()`, então
  // toda a cadeia assíncrona subsequente — incluindo qualquer `await` dentro do
  // handler — nasce dentro do AsyncLocalStorage e o herda corretamente.
  app.addHook('onRequest', (req, reply, done) => {
    if (isPublicUrl(req.url)) return done()
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) {
      void reply.code(401).send({ error: 'não autenticado' })
      return
    }
    verifySupabaseJwt(header.slice('Bearer '.length))
      .then((payload) => resolveUserByAuthId(payload.sub))
      .then((user) => {
        if (!user) {
          void reply.code(401).send({ error: 'usuário não cadastrado' })
          return
        }
        // done() SÍNCRONO dentro da janela do ALS: o resto do ciclo da request roda com tenant
        runWithTenant({ companyId: user.companyId }, () => done())
      })
      .catch((err: unknown) => {
        req.log.warn({ err }, 'falha de autenticação')
        void reply.code(401).send({ error: 'token inválido' })
      })
  })

  app.get('/health', async () => ({ status: 'ok' }))

  // Rota protegida mínima: prova o fluxo auth → tenant (e serve à UI no Plano C).
  app.get('/me', async () => {
    const { companyId } = getTenant()
    return { companyId }
  })

  registerWebhookRoutes(app)

  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'rota inexistente' }))

  return app
}
