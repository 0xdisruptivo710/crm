import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Tabelas globais sem company_id exigem entrada aqui + justificativa em ADR.
// Company É o próprio tenant — única exceção de nascença.
const WHITELIST = new Set<string>(['Company'])

const schema = readFileSync(
  new URL('../../packages/db/prisma/schema.prisma', import.meta.url),
  'utf8',
)
const models = [...schema.matchAll(/model\s+(\w+)\s+\{([\s\S]*?)\n\}/g)].map((m) => ({
  name: m[1] ?? '',
  body: m[2] ?? '',
}))

describe('arquitetura: tenancy no schema (ADR-0001)', () => {
  it('encontrou models no schema', () => {
    expect(models.length).toBeGreaterThanOrEqual(7)
  })

  it.each(models)('model $name tem coluna company_id ou está na whitelist', ({ name, body }) => {
    if (WHITELIST.has(name)) return
    expect(body, `model ${name} nasceu sem company_id`).toContain('@map("company_id")')
  })
})
