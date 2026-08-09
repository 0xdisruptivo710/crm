import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'

// Mock do módulo de verificação JWT para simular um usuário desconhecido.
vi.mock('../src/auth/verify.js')

const app = buildApp()
afterAll(() => app.close())

describe('autenticação: usuario não encontrado', () => {
  beforeAll(async () => {
    // verifySupabaseJwt resolve com um sub válido (simula JWT real válido).
    const verify = await import('../src/auth/verify.js')
    const verifySupabaseJwt = vi.mocked(verify.verifySupabaseJwt)
    const fakeAuthId = randomUUID()
    verifySupabaseJwt.mockResolvedValue({ sub: fakeAuthId })
  })

  it('GET /me com JWT válido mas usuário desconhecido responde 401', async () => {
    // Mesmo com JWT validado, se resolveUserByAuthId retorna null,
    // a rota responde 401 com mensagem 'usuário não cadastrado'.
    const res = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: 'Bearer fake-but-valid-token' },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'usuário não cadastrado' })
  })
})
