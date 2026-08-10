import type { NormalizedWebhookEvent, Provider } from '@aios-pocket/contracts'
import { parseEvolutionWebhook } from './evolution/parse.js'

// Dispatch agnóstico de provider (ADR-0002): o pipeline (apps/api) conhece o CONTRATO
// normalizado, nunca a Evolution ou a Z-API diretamente. Z-API é Plano D — lança em vez
// de devolver null (que o pipeline interpretaria como "payload irrelevante, ignorar";
// aqui o problema é "provider não suportado ainda", erro real que deve derrubar o job).
export function parseProviderWebhook(provider: Provider, raw: unknown): NormalizedWebhookEvent | null {
  if (provider === 'evolution') return parseEvolutionWebhook(raw)
  throw new Error(`parseProviderWebhook: provider "${provider}" ainda não implementado (Plano D)`)
}
