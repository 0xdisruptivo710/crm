import { afterAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'

const app = buildApp()
afterAll(() => app.close())

describe('esqueleto da API', () => {
  it('GET /health responde 200 sem auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok' })
  })

  it('rota protegida sem token responde 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/me' })
    expect(res.statusCode).toBe(401)
  })

  it('token inválido responde 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: 'Bearer token-invalido' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('rota /webhooks/* sem auth responde 200 (bypass público funciona)', async () => {
    // Teste não-vacuo: prova que o hook preHandler executa e aplica o bypass de /webhooks/
    // para rotas CASADAS (não apenas URLs inexistentes que vão direto ao not-found).
    // Cria app sonda com rota probe registrada DEPOIS dos hooks globais.
    const probeApp = buildApp()
    probeApp.get('/webhooks/probe', async () => ({ ok: true }))

    // GET /webhooks/probe sem auth: a rota existe, o hook roda e deixa passar (bypass).
    const res1 = await probeApp.inject({
      method: 'GET',
      url: '/webhooks/probe',
    })
    expect(res1.statusCode).toBe(200)
    expect(res1.json()).toEqual({ ok: true })

    // GET /me sem auth: rota protegida, hook nega (sem bypass).
    // Prova que o bypass é específico de /webhooks/, não global.
    const res2 = await probeApp.inject({
      method: 'GET',
      url: '/me',
    })
    expect(res2.statusCode).toBe(401)

    await probeApp.close()
  })
})
