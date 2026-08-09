import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { prismaUnsafe } from '@aios-pocket/db/testing'
import { buildApp } from '../src/app.js'

// Mock do módulo de verificação JWT: simula um JWT válido cujo `sub` é o authUserId
// de um usuário REAL, já existente no banco de dev remoto (semeado por
// `pnpm --filter @aios-pocket/db run db:seed` — ver packages/db/prisma/seed.ts).
//
// Por que não criamos o usuário aqui via Prisma "normal": todo acesso de escrita a
// dados de negócio passa pelo TenantContext (ADR-0001), e antes da autenticação não
// existe tenant — não há como criar company/user pelo caminho tenant-safe. `prismaUnsafe`
// (exportado só para teste via '@aios-pocket/db/testing', com guard de ESLint) é o único
// jeito sancionado de ler dados fora do fluxo de auth/tenant; por isso ele é usado aqui
// somente para LER o piloto já semeado, nunca para escrever regra de negócio.
vi.mock('../src/auth/verify.js')

const app = buildApp()
afterAll(() => app.close())

describe('autenticação: caminho feliz (usuário cadastrado)', () => {
  let companyId: string

  beforeAll(async () => {
    const company = await prismaUnsafe.company.findFirst({ where: { name: 'Aios Pocket' } })
    // Guarda com mensagem clara: se o piloto não foi semeado no banco de dev remoto,
    // este teste falha explicando o que fazer, em vez de um erro genérico de "not found".
    expect(company, 'rode pnpm --filter @aios-pocket/db run db:seed').toBeTruthy()
    companyId = company!.id

    const user = await prismaUnsafe.user.findFirst({ where: { companyId } })
    expect(user, 'rode pnpm --filter @aios-pocket/db run db:seed').toBeTruthy()

    const verify = await import('../src/auth/verify.js')
    const verifySupabaseJwt = vi.mocked(verify.verifySupabaseJwt)
    verifySupabaseJwt.mockResolvedValue({ sub: user!.authUserId })
  })

  it('GET /me com JWT válido e usuário cadastrado responde 200 com o companyId do tenant', async () => {
    // Prova o FINDING 1 corrigido: o hook onRequest (callback + runWithTenant) propaga
    // o TenantContext através dos awaits internos do handler /me. Antes da correção
    // (preHandler async + enterTenant após await), esta chamada lançava
    // "TenantContext ausente" e respondia 500.
    const res = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: 'Bearer qualquer-token-aqui-o-mock-decide' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ companyId })
  })
})
