import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { prismaUnsafe } from '@aios-pocket/db/testing'
import { buildApp } from '../src/app.js'

// Mock do módulo de verificação JWT: simula um JWT válido cujo `sub` é o authUserId
// da fixture criada abaixo.
//
// Por que a fixture é criada aqui (e não lida de um seed): todo acesso de escrita a
// dados de negócio passa pelo TenantContext (ADR-0001), e antes da autenticação não
// existe tenant — não há como criar company/user pelo caminho tenant-safe. `prismaUnsafe`
// (exportado só para teste via '@aios-pocket/db/testing', com guard de ESLint) é o único
// jeito sancionado de escrever fora do fluxo de auth/tenant, e é usado SOMENTE para montar
// esta fixture isolada — nunca para lógica de negócio.
//
// Este teste NÃO depende do piloto semeado (packages/db/prisma/seed.ts): CI nunca roda
// db:seed, e os testes de packages/db fazem wipe total de `company`/`user` no setup deles
// — depender do seed deixava este teste vermelho em CI e frágil quanto à ordem local. A
// fixture usa nome de company único (randomUUID) para não colidir com dados concorrentes,
// e é removida no afterAll por id (nunca um deleteMany amplo).
vi.mock('../src/auth/verify.js')

const app = buildApp()
afterAll(() => app.close())

describe('autenticação: caminho feliz (usuário cadastrado)', () => {
  let companyId: string | undefined
  let userId: string | undefined

  beforeAll(async () => {
    const company = await prismaUnsafe.company.create({
      data: {
        name: `HP Teste ${randomUUID().slice(0, 8)}`,
        activeProvider: 'evolution',
        providerCredentials: 'cifrado-fake',
      },
    })
    companyId = company.id

    const authUserId = randomUUID()
    const user = await prismaUnsafe.user.create({
      data: {
        companyId,
        authUserId,
        name: 'Usuário Teste',
        email: `teste-${authUserId}@example.com`,
      },
    })
    userId = user.id

    const verify = await import('../src/auth/verify.js')
    const verifySupabaseJwt = vi.mocked(verify.verifySupabaseJwt)
    verifySupabaseJwt.mockResolvedValue({ sub: authUserId })
  })

  afterAll(async () => {
    // Remove exatamente as linhas criadas por este teste (escopadas por id) — nunca um
    // deleteMany amplo, que colidiria com fixtures de outros testes/seeds no mesmo banco.
    // Ordem: user antes de company (FK user.company_id -> company.id).
    //
    // GUARDA OBRIGATÓRIA: o Vitest roda afterAll mesmo se beforeAll lançar (ex.: timeout
    // de 10s contra o Postgres remoto, ou falha depois de criar a company mas antes de
    // criar o user). Sem o `if`, um `userId`/`companyId` ainda `undefined` faria
    // `deleteMany({ where: { id: undefined } })` — o Prisma IGNORA filtros com valor
    // `undefined`, o que vira `deleteMany({})`: wipe da tabela inteira no banco de dev
    // remoto compartilhado. Só apaga se o id foi de fato atribuído.
    if (userId) await prismaUnsafe.user.deleteMany({ where: { id: userId } })
    if (companyId) await prismaUnsafe.company.deleteMany({ where: { id: companyId } })
  })

  it('GET /me com JWT válido e usuário cadastrado responde 200 com o companyId do tenant', async () => {
    // Checagem em runtime (não `!`): garante que a fixture do beforeAll foi criada antes
    // de usar os ids, e transforma uma falha silenciosa de tipagem num erro claro caso
    // beforeAll não tenha rodado até o fim.
    if (!companyId || !userId) throw new Error('fixture não criada')

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
