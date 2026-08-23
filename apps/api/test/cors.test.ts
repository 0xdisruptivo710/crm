import { afterAll, describe, expect, it } from 'vitest'

// CORS (Task 9 do Plano C, metade "código" adiantada na T8 — ver app.ts). WEB_ORIGIN
// precisa existir ANTES do import do app: config.ts parseia process.env no momento do
// import. O import dinâmico abaixo + o isolamento de módulos por arquivo do vitest
// garantem a ordem sem vazar a env para os outros arquivos de teste.
process.env.WEB_ORIGIN = 'http://localhost:3000, https://aios-pocket.vercel.app'
const { buildApp } = await import('../src/app.js')

const app = buildApp()
afterAll(() => app.close())

describe('CORS (WEB_ORIGIN definida)', () => {
  it('preflight OPTIONS em rota protegida passa SEM auth e devolve os headers de CORS', async () => {
    // Preflight é anônimo por especificação — o hook de auth precisa liberar OPTIONS,
    // senão o browser morre no 401 antes de qualquer GET real acontecer.
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/conversations',
      headers: {
        origin: 'http://localhost:3000',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization',
      },
    })
    expect(res.statusCode).toBe(204)
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000')
    // O header Authorization solicitado pelo preflight tem que voltar permitido —
    // é ele que o apiFetch do web manda em toda chamada.
    expect(String(res.headers['access-control-allow-headers'] ?? '')).toMatch(/authorization/i)
  })

  it('segunda origem da lista (separada por vírgula) também é aceita', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/conversations',
      headers: {
        origin: 'https://aios-pocket.vercel.app',
        'access-control-request-method': 'GET',
      },
    })
    expect(res.statusCode).toBe(204)
    expect(res.headers['access-control-allow-origin']).toBe('https://aios-pocket.vercel.app')
  })

  it('origem fora da lista NÃO recebe allow-origin', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/conversations',
      headers: {
        origin: 'https://malicioso.example',
        'access-control-request-method': 'GET',
      },
    })
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('GET protegido continua exigindo auth mesmo com CORS registrado (OPTIONS não abre porta)', async () => {
    // O bypass do hook de auth é SÓ para o método OPTIONS — um GET cross-origin sem token
    // continua barrado. (Limitação documentada no app.ts: este 401 sai sem headers de
    // CORS, porque o hook do plugin roda depois do de auth.)
    const res = await app.inject({
      method: 'GET',
      url: '/conversations',
      headers: { origin: 'http://localhost:3000' },
    })
    expect(res.statusCode).toBe(401)
  })
})
