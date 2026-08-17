// Script de uso ÚNICO para a Task 3 do Plano C (cutover do banco vivo droplet → Supabase).
//
// Copia tabela a tabela, na ordem de dependência de FK:
//   companies → users → customers → conversations → messages → customer_events → raw_webhook_events
//
// GARANTIAS:
//  - ORIGEM NUNCA é modificada — só SELECT (findMany/count). Nenhuma escrita, nenhum DDL.
//  - Campos são copiados VERBATIM (ids inclusos) — as FKs entre as tabelas dependem de
//    que o id da linha no destino seja idêntico ao da origem.
//  - Idempotente: createMany com skipDuplicates:true — reexecução não duplica linhas já
//    copiadas (a chave primária/unique de cada tabela decide o que é "duplicado").
//  - Não conhece Supabase/droplet por nome: origem e destino vêm 100% de env
//    (SOURCE_DATABASE_URL / TARGET_DATABASE_URL) no momento da execução — o MESMO script
//    roda no ensaio (banco de teste → banco descartável) e no cutover real (droplet →
//    Supabase) só trocando as duas envs.
//  - One-shot: sempre termina com process.exit(); nunca fica pendurado. Um watchdog
//    global mata o processo se alguma chamada de rede/DB travar sem responder.
//
// Uso:
//   Dry-run (não escreve em lugar nenhum, não conecta no destino):
//     SOURCE_DATABASE_URL=postgres://... tsx scripts/copy-live-db.ts
//   Execução real (copia de fato):
//     COPY_CONFIRM=yes SOURCE_DATABASE_URL=postgres://... TARGET_DATABASE_URL=postgres://... tsx scripts/copy-live-db.ts
//
// Nota de import: '@prisma/client' é proibido fora de packages/db pelo ESLint
// (no-restricted-imports, ADR-0001). Este script usa createUnsafeClient — uma fábrica de
// PrismaClient com datasource explícito adicionada a packages/db/src/unsafe.ts —
// importada por CAMINHO RELATIVO (mesma convenção de scripts/harvest-fixtures.ts), que o
// guard de ESLint não intercepta (ele casa no specifier literal, não no caminho
// resolvido). Motivo de precisar da fábrica em vez do `prismaUnsafe` pronto: este script
// precisa de DOIS clients simultâneos apontando para bancos DIFERENTES (origem e
// destino) — `prismaUnsafe` é um singleton fixo na DATABASE_URL do ambiente.
import { createUnsafeClient, type PrismaJsonInput } from '../packages/db/src/unsafe.js'

const BATCH_SIZE = 500
const QUERY_TIMEOUT_MS = 30_000
const GLOBAL_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutos — mata o processo se algo pendurar (rede/DB).

// Mata o processo se o script inteiro não terminar sozinho — rede instável/servidor
// pendurado nunca deve deixar isto rodando para sempre (proibição do brief).
const watchdog = setTimeout(() => {
  console.error(`ERRO FATAL: timeout global de ${GLOBAL_TIMEOUT_MS}ms estourado — abortando processo.`)
  process.exit(1)
}, GLOBAL_TIMEOUT_MS)

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout (${ms}ms) em: ${label}`)), ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e: unknown) => {
        clearTimeout(timer)
        reject(e instanceof Error ? e : new Error(String(e)))
      },
    )
  })
}

interface TableResult {
  table: string
  copied: number
  durationMs: number
}

// Copia uma tabela inteira em páginas por cursor de `id` (estável mesmo sem coluna de
// data — UUID ordena de forma determinística e a origem não é escrita durante a cópia).
// Genérico o bastante para as 7 tabelas sem duplicar a lógica de paginação/lote.
async function copyTable<Row extends { id: string }>(
  name: string,
  findMany: (args: {
    take: number
    orderBy: { id: 'asc' }
    cursor?: { id: string }
    skip?: number
  }) => Promise<Row[]>,
  createMany: (rows: Row[]) => Promise<{ count: number }>,
): Promise<TableResult> {
  const start = Date.now()
  let copied = 0
  let cursor: string | undefined
  for (;;) {
    const page = await withTimeout(
      findMany({
        take: BATCH_SIZE,
        orderBy: { id: 'asc' },
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      }),
      QUERY_TIMEOUT_MS,
      `findMany(${name})`,
    )
    if (page.length === 0) break
    await withTimeout(createMany(page), QUERY_TIMEOUT_MS, `createMany(${name})`)
    copied += page.length
    const lastRow = page[page.length - 1]
    if (lastRow === undefined) break
    cursor = lastRow.id
    if (page.length < BATCH_SIZE) break
  }
  return { table: name, copied, durationMs: Date.now() - start }
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value || value.trim().length === 0) {
    throw new Error(`env obrigatória ausente: ${name}`)
  }
  return value
}

async function main(): Promise<void> {
  const sourceUrl = requireEnv('SOURCE_DATABASE_URL')
  const confirmed = process.env.COPY_CONFIRM === 'yes'

  console.log('=== scripts/copy-live-db.ts — cópia do banco vivo (T3 do Plano C) ===')
  console.log(`Modo: ${confirmed ? 'EXECUÇÃO REAL (COPY_CONFIRM=yes)' : 'DRY-RUN (defina COPY_CONFIRM=yes para copiar de verdade)'}`)

  const source = createUnsafeClient(sourceUrl)

  if (!confirmed) {
    // Dry-run: só lê a origem, NUNCA conecta no destino.
    try {
      console.log('\nContagens da ORIGEM (o que seria copiado):')
      const tables: Array<[string, () => Promise<number>]> = [
        ['companies', () => source.company.count()],
        ['users', () => source.user.count()],
        ['customers', () => source.customer.count()],
        ['conversations', () => source.conversation.count()],
        ['messages', () => source.message.count()],
        ['customer_events', () => source.customerEvent.count()],
        ['raw_webhook_events', () => source.rawWebhookEvent.count()],
      ]
      for (const [name, count] of tables) {
        const n = await withTimeout(count(), QUERY_TIMEOUT_MS, `count(${name})`)
        console.log(`  ${name.padEnd(20)} ${n}`)
      }
      console.log('\nDry-run concluído. Nenhuma escrita foi feita (destino não foi conectado).')
      console.log('Para copiar de fato: defina TARGET_DATABASE_URL e COPY_CONFIRM=yes.')
    } finally {
      await source.$disconnect()
      clearTimeout(watchdog)
    }
    process.exit(0)
  }

  const targetUrl = requireEnv('TARGET_DATABASE_URL')
  const target = createUnsafeClient(targetUrl)

  try {
    console.log('\nCopiando tabelas na ordem de FK (lotes de 500, skipDuplicates:true)...\n')

    const results: TableResult[] = []

    results.push(
      await copyTable(
        'companies',
        (args) => source.company.findMany(args),
        (rows) => target.company.createMany({ data: rows, skipDuplicates: true }),
      ),
    )
    results.push(
      await copyTable(
        'users',
        (args) => source.user.findMany(args),
        (rows) => target.user.createMany({ data: rows, skipDuplicates: true }),
      ),
    )
    results.push(
      await copyTable(
        'customers',
        (args) => source.customer.findMany(args),
        (rows) => target.customer.createMany({ data: rows, skipDuplicates: true }),
      ),
    )
    results.push(
      await copyTable(
        'conversations',
        (args) => source.conversation.findMany(args),
        (rows) => target.conversation.createMany({ data: rows, skipDuplicates: true }),
      ),
    )
    results.push(
      await copyTable(
        'messages',
        (args) => source.message.findMany(args),
        (rows) => target.message.createMany({ data: rows, skipDuplicates: true }),
      ),
    )
    results.push(
      await copyTable(
        'customer_events',
        (args) => source.customerEvent.findMany(args),
        (rows) =>
          target.customerEvent.createMany({
            // payload lido volta como JsonValue (inclui `null` como literal JSON válido);
            // cast para InputJsonValue é seguro aqui — o valor é copiado verbatim, nunca
            // construído do zero (ver PrismaJsonInput em packages/db/src/unsafe.ts).
            data: rows.map((r) => ({ ...r, payload: r.payload as PrismaJsonInput })),
            skipDuplicates: true,
          }),
      ),
    )
    results.push(
      await copyTable(
        'raw_webhook_events',
        (args) => source.rawWebhookEvent.findMany(args),
        (rows) =>
          target.rawWebhookEvent.createMany({
            data: rows.map((r) => ({ ...r, payload: r.payload as PrismaJsonInput })),
            skipDuplicates: true,
          }),
      ),
    )

    for (const r of results) {
      console.log(`  ${r.table.padEnd(20)} ${String(r.copied).padEnd(8)} copiadas em ${r.durationMs}ms`)
    }

    console.log('\nConferindo contagens origem × destino...\n')

    const countPairs: Array<[string, () => Promise<number>, () => Promise<number>]> = [
      ['companies', () => source.company.count(), () => target.company.count()],
      ['users', () => source.user.count(), () => target.user.count()],
      ['customers', () => source.customer.count(), () => target.customer.count()],
      ['conversations', () => source.conversation.count(), () => target.conversation.count()],
      ['messages', () => source.message.count(), () => target.message.count()],
      ['customer_events', () => source.customerEvent.count(), () => target.customerEvent.count()],
      ['raw_webhook_events', () => source.rawWebhookEvent.count(), () => target.rawWebhookEvent.count()],
    ]

    let allMatch = true
    console.log(`  ${'tabela'.padEnd(20)} ${'origem'.padEnd(10)} ${'destino'.padEnd(10)} status`)
    for (const [name, sourceCount, targetCount] of countPairs) {
      const [s, t] = await Promise.all([
        withTimeout(sourceCount(), QUERY_TIMEOUT_MS, `count origem(${name})`),
        withTimeout(targetCount(), QUERY_TIMEOUT_MS, `count destino(${name})`),
      ])
      const ok = s === t
      if (!ok) allMatch = false
      console.log(`  ${name.padEnd(20)} ${String(s).padEnd(10)} ${String(t).padEnd(10)} ${ok ? 'OK' : 'DIVERGENTE'}`)
    }

    if (allMatch) {
      console.log('\nTodas as contagens batem. Cópia concluída com sucesso.')
    } else {
      console.error('\nERRO: alguma contagem divergiu entre origem e destino. Investigar antes de prosseguir com o cutover.')
    }

    clearTimeout(watchdog)
    await source.$disconnect()
    await target.$disconnect()
    process.exit(allMatch ? 0 : 1)
  } catch (err) {
    console.error('ERRO durante a cópia:', err instanceof Error ? err.message : err)
    try {
      await source.$disconnect()
    } catch {
      // já desconectado ou nunca conectou — ignora.
    }
    try {
      await target.$disconnect()
    } catch {
      // idem.
    }
    clearTimeout(watchdog)
    process.exit(1)
  }
}

main().catch((err: unknown) => {
  console.error('ERRO FATAL não tratado:', err instanceof Error ? err.message : err)
  clearTimeout(watchdog)
  process.exit(1)
})
