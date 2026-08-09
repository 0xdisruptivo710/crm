import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { prismaUnsafe } from '../src/unsafe.js'
import { encryptJson } from '../src/crypto.js'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`env ${name} ausente — confira o .env da raiz`)
  return value
}

// Cria (ou reaproveita) o usuário no Supabase Auth. Sem Supabase no env, usa id sintético (dev local).
async function ensureAuthUser(email: string, password: string): Promise<string> {
  const url = process.env.SUPABASE_URL
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceRole) {
    console.warn('Supabase ausente no env — usando auth_user_id sintético (apenas dev local)')
    return randomUUID()
  }
  const supabase = createClient(url, serviceRole)
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })
  if (error) {
    // listUsers pagina (padrão 50 por página); com 1 único usuário piloto isso é suficiente.
    const { data: list, error: listError } = await supabase.auth.admin.listUsers()
    if (listError) throw listError
    const existing = list.users.find((u) => u.email === email)
    if (existing) return existing.id
    throw error
  }
  return data.user.id
}

async function main(): Promise<void> {
  const email = requireEnv('SEED_USER_EMAIL')
  const authUserId = await ensureAuthUser(email, requireEnv('SEED_USER_PASSWORD'))

  const credentials = encryptJson(
    {
      // Instância Evolution DEDICADA de dev (Plano B T4) — a de produção (murilo) é intocável.
      evolution: {
        baseUrl: requireEnv('EVOLUTION_DEV_BASE_URL'),
        apiKey: requireEnv('EVOLUTION_DEV_API_KEY'),
        instanceId: requireEnv('EVOLUTION_DEV_INSTANCE'),
      },
      zapi: {
        baseUrl: requireEnv('ZAPI_BASE_URL'),
        instanceId: requireEnv('ZAPI_INSTANCE_ID'),
        instanceToken: requireEnv('ZAPI_INSTANCE_TOKEN'),
        clientToken: requireEnv('ZAPI_CLIENT_TOKEN'),
      },
    },
    requireEnv('APP_ENCRYPTION_KEY'),
  )

  const existing = await prismaUnsafe.company.findFirst({ where: { name: 'Aios Pocket' } })
  const company = existing
    ? await prismaUnsafe.company.update({
        where: { id: existing.id },
        data: { providerCredentials: credentials },
      })
    : await prismaUnsafe.company.create({
        data: { name: 'Aios Pocket', activeProvider: 'evolution', providerCredentials: credentials },
      })

  await prismaUnsafe.user.upsert({
    where: { authUserId },
    update: { email },
    create: { companyId: company.id, authUserId, name: 'Piloto', email },
  })

  // webhookToken (ADR-0003) é o que se cadastra manualmente nos dashboards
  // da Evolution API e da Z-API para o piloto — expor aqui poupa uma consulta ao banco.
  console.log(`seed ok — company ${company.id}, user auth ${authUserId}`)
  console.log(`webhook token: ${company.webhookToken}`)
  console.log(`  POST /webhooks/evolution/${company.webhookToken}`)
  console.log(`  POST /webhooks/zapi/${company.webhookToken}`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(() => prismaUnsafe.$disconnect())
