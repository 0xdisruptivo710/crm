import { beforeAll, describe, expect, it } from 'vitest'
import { prismaUnsafe } from '../src/unsafe.js'
import { prisma } from '../src/client.js'
import { runWithTenant } from '../src/tenant-context.js'
import { customersRepo } from '../src/repositories/customers.js'

let companyA = ''
let companyB = ''

// Guarda de segurança: este arquivo apaga (deleteMany) o conteúdo das tabelas de negócio
// antes de cada rodada. Isso é aceitável NUM banco de dev descartável, mas seria uma
// tragédia se um DATABASE_URL mal configurado apontasse sem querer para produção
// (ex.: um projeto Supabase real) ou qualquer outro banco desconhecido. Recusa explícita
// antes de qualquer deleteMany, ao invés de confiar apenas em disciplina de configuração.
function assertSafeToWipe(databaseUrl: string | undefined): void {
  if (!databaseUrl) {
    throw new Error('Recusando apagar dados: DATABASE_URL não está definido no ambiente de teste.')
  }
  const url = new URL(databaseUrl)
  const dbName = url.pathname.replace(/^\//, '')
  // 'aios-pocket' é o banco VIVO do piloto desde o deploy do Plano B — proibido.
  // Só os bancos de teste dedicados entram na lista: 'aios-pocket-test' (dev remoto) e
  // 'aios_pocket' (nome usado em ambientes locais/CI, ver .env.example).
  const allowedDbNames = new Set(['aios-pocket-test', 'aios_pocket'])
  if (url.hostname.endsWith('.supabase.co') || !allowedDbNames.has(dbName)) {
    throw new Error(
      `Recusando apagar dados: DATABASE_URL aponta para host="${url.hostname}" db="${dbName}", ` +
        'que não é reconhecido como o banco de dev descartável deste projeto (ADR-0001 nunca autoriza truncar produção).',
    )
  }
}

beforeAll(async () => {
  assertSafeToWipe(process.env.DATABASE_URL)
  await prismaUnsafe.message.deleteMany()
  await prismaUnsafe.customerEvent.deleteMany()
  await prismaUnsafe.conversation.deleteMany()
  await prismaUnsafe.customer.deleteMany()
  await prismaUnsafe.user.deleteMany()
  await prismaUnsafe.company.deleteMany()
  const a = await prismaUnsafe.company.create({
    data: { name: 'Empresa A', activeProvider: 'evolution', providerCredentials: 'cifrado' },
  })
  const b = await prismaUnsafe.company.create({
    data: { name: 'Empresa B', activeProvider: 'zapi', providerCredentials: 'cifrado' },
  })
  companyA = a.id
  companyB = b.id
  await prismaUnsafe.customer.create({
    data: { companyId: companyA, phoneE164: '+5511999990000', phoneOriginal: '5511999990000' },
  })
  await prismaUnsafe.customer.create({
    data: { companyId: companyB, phoneE164: '+5511999990000', phoneOriginal: '5511999990000' },
  })
})

describe('tenancy por aplicação (ADR-0001)', () => {
  it('leituras enxergam apenas o tenant do contexto', async () => {
    // Independente de ordem de execução dos testes (não assume contagem exata):
    // toda linha devolvida é do tenant A, e nenhuma é do tenant B.
    const rows = await runWithTenant({ companyId: companyA }, () => customersRepo.list())
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((row) => row.companyId === companyA)).toBe(true)
    expect(rows.some((row) => row.companyId === companyB)).toBe(false)
  })

  it('criação injeta o company_id do contexto', async () => {
    const created = await runWithTenant({ companyId: companyA }, () =>
      customersRepo.create({ phoneE164: '+5511888880000', phoneOriginal: '5511888880000' }),
    )
    expect(created.companyId).toBe(companyA)
  })

  it('sobrescreve company_id forjado em prisma.customer.create direto (extension > payload do chamador)', async () => {
    // Diferente do teste acima (que confia no repository), este chama o client do Prisma
    // diretamente e força um companyId de OUTRO tenant no payload — prova que é a
    // extension (não o repository) que garante o tenant correto, mesmo contra um payload
    // malicioso ou um bug em uma camada acima do repository.
    const created = await runWithTenant({ companyId: companyA }, () =>
      prisma.customer.create({
        data: {
          companyId: companyB,
          phoneE164: '+5511777770000',
          phoneOriginal: '5511777770000',
        },
      }),
    )
    expect(created.companyId).toBe(companyA)
  })

  it('lança erro sem TenantContext', async () => {
    await expect(customersRepo.list()).rejects.toThrow('TenantContext')
  })

  it('proíbe operações que não aceitam filtro de tenant', async () => {
    await expect(
      runWithTenant({ companyId: companyA }, () =>
        prisma.customer.findUnique({ where: { id: companyA } }),
      ),
    ).rejects.toThrow('proibida')
  })

  it('proíbe operações raw, mesmo com TenantContext ativo', async () => {
    await expect(
      runWithTenant({ companyId: companyA }, () => prisma.$queryRaw`SELECT 1`),
    ).rejects.toThrow('raw')
  })

  it('proíbe operações raw também sem TenantContext', async () => {
    await expect(prisma.$queryRaw`SELECT 1`).rejects.toThrow('raw')
  })
})
