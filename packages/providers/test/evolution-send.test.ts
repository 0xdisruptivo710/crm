import { describe, expect, it } from 'vitest'
import { createEvolutionProvider } from '../src/index.js'

// Integração REAL contra a instância dev dedicada (Task 4). Envia mensagem para o
// PRÓPRIO número conectado (mensagem para si mesmo — sem incomodar terceiros).
// Pula quando as vars não existem (ex.: CI, que não conhece a Evolution dev).
const baseUrl = process.env.EVOLUTION_DEV_BASE_URL
const apiKey = process.env.EVOLUTION_DEV_API_KEY
const instanceId = process.env.EVOLUTION_DEV_INSTANCE
const runIf = baseUrl && apiKey && instanceId ? describe : describe.skip

runIf('EvolutionProvider (integração real, instância dev)', () => {
  const provider = createEvolutionProvider({
    baseUrl: baseUrl as string,
    apiKey: apiKey as string,
    instanceId: instanceId as string,
  })

  it('getConnectionStatus reporta connected', async () => {
    expect(await provider.getConnectionStatus()).toBe('connected')
  }, 20000)

  it('sendText para o próprio número retorna providerMessageId', async () => {
    const status = await provider.getConnectionStatus()
    expect(status).toBe('connected')
    const self = process.env.EVOLUTION_DEV_SELF_PHONE
    if (!self) throw new Error('defina EVOLUTION_DEV_SELF_PHONE no .env (número conectado, só dígitos)')
    const result = await provider.sendText(self, `teste aios-pocket ${new Date().toISOString()}`)
    expect(result.providerMessageId.length).toBeGreaterThan(5)
  }, 30000)
})
