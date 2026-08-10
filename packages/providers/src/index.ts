export type { MessagingProvider, SendResult, OutboundMedia, EvolutionConfig } from './types.js'
export { createEvolutionProvider } from './evolution/provider.js'
// Exports puros (sem dependência de config): o pipeline de ingestão (apps/api) usa estes
// diretamente para não precisar montar um MessagingProvider completo só para parsear.
export { parseEvolutionWebhook } from './evolution/parse.js'
export { parseProviderWebhook } from './parse-webhook.js'
