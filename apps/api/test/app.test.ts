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

  it('GET /webhooks/qualquer sem auth responde 404 (não 401)', async () => {
    // Prova que o bypass público funciona: não precisa de auth header,
    // mas como a rota não existe, retorna 404.
    const res = await app.inject({ method: 'GET', url: '/webhooks/qualquer' })
    expect(res.statusCode).toBe(404)
  })
})
