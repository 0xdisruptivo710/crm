import type { NormalizedWebhookEvent } from '@aios-pocket/contracts'
import type { EvolutionConfig, MessagingProvider, OutboundMedia, SendResult } from '../types.js'
import { evolutionRequest } from './http.js'

interface EvolutionSendResponse {
  key?: { id?: string }
}

interface EvolutionConnectionState {
  instance?: { state?: string }
}

export function createEvolutionProvider(config: EvolutionConfig): MessagingProvider {
  return {
    async sendText(to: string, text: string): Promise<SendResult> {
      const res = await evolutionRequest<EvolutionSendResponse>(
        config,
        'POST',
        `/message/sendText/${config.instanceId}`,
        { number: to, text },
      )
      const id = res.key?.id
      if (!id) throw new Error('evolution sendText sem key.id na resposta')
      return { providerMessageId: id }
    },

    async sendMedia(to: string, media: OutboundMedia): Promise<SendResult> {
      const res = await evolutionRequest<EvolutionSendResponse>(
        config,
        'POST',
        `/message/sendMedia/${config.instanceId}`,
        {
          number: to,
          mediatype: media.mimeType.startsWith('image/') ? 'image' : media.mimeType.startsWith('video/') ? 'video' : media.mimeType.startsWith('audio/') ? 'audio' : 'document',
          mimetype: media.mimeType,
          media: media.url,
          caption: media.caption ?? '',
        },
      )
      const id = res.key?.id
      if (!id) throw new Error('evolution sendMedia sem key.id na resposta')
      return { providerMessageId: id }
    },

    parseWebhook(raw: unknown): NormalizedWebhookEvent | null {
      // Implementado na Task 9, com TDD sobre fixtures REAIS capturadas nas Tasks 7-8.
      // Fixture inventada é proibida (Conventions.md) — por isso o stub lança.
      // `raw` fica sem uso até lá; referenciá-lo evita o erro de no-unused-vars
      // (aqui é o último parâmetro, então o "^_" de outros stubs no repo não ajuda).
      void raw
      throw new Error('parseWebhook: implementado na Task 9 sobre fixtures reais')
    },

    async getConnectionStatus(): Promise<'connected' | 'disconnected' | 'connecting'> {
      const res = await evolutionRequest<EvolutionConnectionState>(
        config,
        'GET',
        `/instance/connectionState/${config.instanceId}`,
      )
      const state = res.instance?.state
      if (state === 'open') return 'connected'
      if (state === 'connecting') return 'connecting'
      return 'disconnected'
    },
  }
}
