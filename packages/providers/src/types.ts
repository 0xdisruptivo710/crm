import type { NormalizedWebhookEvent } from '@aios-pocket/contracts'

export interface SendResult {
  providerMessageId: string
}

export interface OutboundMedia {
  url: string
  mimeType: string
  caption?: string
}

// Contrato único (ADR-0002): nenhum módulo de negócio conhece Evolution ou Z-API.
export interface MessagingProvider {
  sendText(to: string, text: string): Promise<SendResult>
  sendMedia(to: string, media: OutboundMedia): Promise<SendResult>
  parseWebhook(raw: unknown): NormalizedWebhookEvent | null
  getConnectionStatus(): Promise<'connected' | 'disconnected' | 'connecting'>
}

export interface EvolutionConfig {
  baseUrl: string
  apiKey: string
  instanceId: string
}
