import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseEvolutionWebhook, parseProviderWebhook } from '../src/index.js'

const FIXTURES_DIR = join(import.meta.dirname, '..', '..', '..', 'tests', 'providers', 'fixtures', 'evolution')

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), 'utf8'))
}

describe('parseEvolutionWebhook (export puro, ADR-0002)', () => {
  it('é a mesma implementação usada pelo EvolutionProvider — exportada diretamente do pacote', () => {
    const raw = loadFixture('incoming_text-1.json')
    const parsed = parseEvolutionWebhook(raw)
    expect(parsed?.kind).toBe('incoming_message')
  })
})

describe('parseProviderWebhook (dispatch agnóstico de provider, ADR-0002)', () => {
  it('evolution: delega para parseEvolutionWebhook', () => {
    const raw = loadFixture('incoming_text-1.json')
    const parsed = parseProviderWebhook('evolution', raw)
    expect(parsed?.kind).toBe('incoming_message')
  })

  it('zapi: ainda não implementado — lança (Plano D), nunca retorna null silenciosamente', () => {
    expect(() => parseProviderWebhook('zapi', { any: 'payload' })).toThrow(/Plano D/)
  })
})
