import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { normalizedWebhookEventSchema } from '@aios-pocket/contracts'
import type { MessagingProvider } from '../src/index.js'

interface ManifestEntry {
  file: string
  kind:
    | 'incoming_text'
    | 'incoming_from_me'
    | 'incoming_audio'
    | 'incoming_image'
    | 'incoming_document'
    | 'incoming_reply'
    | 'incoming_reaction'
    | 'incoming_special'
    | 'status_update'
    | 'connection_update'
    | 'send_message_echo'
}

// Kinds cujo payload é real e válido, mas que a v1 ignora conscientemente (ADR-0003
// permite null para eventos irrelevantes): reação de emoji, tipos "especiais" que o
// parser não decodifica em detalhe (secretEncryptedMessage/templateMessage) e o eco do
// próprio envio feito pela API (send.message, correlacionável só por key.id — sem valor
// para o pipeline, que já sabe o que enviou). Nenhum desses vira IncomingMessage no v1.
//
// NOTA sobre incoming_reaction-1.json (fix round 1, review do controller): essa fixture
// é de GRUPO (remoteJid terminado em @g.us) — o retorno null que ela exercita é o
// early-return de JID de grupo em parseMessagesUpsert, não o branch genérico de "tipo
// de mensagem não decodificado" que cobre reactionMessage/secretEncryptedMessage/
// templateMessage. Checado ao vivo no banco de dev em 2026-08-10: só existem 2 eventos
// reactionMessage capturados até agora, ambos de grupo — não há candidato 1:1 para
// virar fixture ainda. Cobertura da reação está limitada ao caso de grupo
// (early-return); reação 1:1 pendente de captura — o branch genérico (mesmo código que
// trataria uma reação 1:1) já é exercitado por incoming_special-1/2.json.
const IGNORED_KINDS = new Set<ManifestEntry['kind']>(['incoming_reaction', 'incoming_special', 'send_message_echo'])

// Suíte de contrato provider-agnóstica (ADR-0002): a MESMA bateria roda para
// Evolution (agora) e UAZAPI (Fatia 4 — ADR-0008; a Z-API saiu do roadmap).
// Critério da Fatia 4: passar aqui, sobre fixtures reais capturadas ao vivo.
// Itens a cobrir quando a UAZAPI entrar (carry-over): sinal wasSentByApi na guarda
// de eco; verificar se ela emite evento de edição (a Evolution 2.3.7 não emite).
export function runProviderContractSuite(provider: MessagingProvider, fixturesDir: string): void {
  const manifest = JSON.parse(readFileSync(join(fixturesDir, 'manifest.json'), 'utf8')) as ManifestEntry[]

  describe(`contrato de provider sobre ${manifest.length} fixtures reais`, () => {
    it('manifest cobre todas as categorias obrigatórias', () => {
      const kinds = new Set(manifest.map((m) => m.kind))
      // incoming_edit NÃO está aqui: a Evolution 2.3.7 empiricamente não emite esse
      // evento via webhook (tests/providers/fixtures/README.md) — não existe fixture
      // real para capturar, e fixture inventada é proibida (Conventions.md §3.10).
      for (const required of [
        'incoming_text',
        'incoming_from_me',
        'incoming_audio',
        'incoming_reply',
        'status_update',
        'connection_update',
      ] as const) {
        expect(kinds, `categoria ${required} sem fixture — capture-a antes`).toContain(required)
      }
    })

    it('toda fixture do diretório está no manifest', () => {
      const files = readdirSync(fixturesDir).filter((f) => f.endsWith('.json') && f !== 'manifest.json')
      expect(files.sort()).toEqual(manifest.map((m) => m.file).sort())
    })

    for (const entry of manifest) {
      it(`${entry.file} → ${entry.kind}`, () => {
        const raw = JSON.parse(readFileSync(join(fixturesDir, entry.file), 'utf8')) as unknown
        const parsed = provider.parseWebhook(raw)

        if (IGNORED_KINDS.has(entry.kind)) {
          // Reação/especial/eco de envio: payload real, mas irrelevante para o v1.
          expect(parsed, `${entry.kind} deve ser ignorado (null) nesta fase — ADR-0003`).toBeNull()
          return
        }

        expect(parsed, 'payload real não pode virar null nas categorias mapeadas').not.toBeNull()
        if (!parsed) return

        // Proteção contra schema-drift (fix round 1): todo resultado não-nulo, de
        // QUALQUER provider, precisa satisfazer o contrato normalizado — pega tanto
        // um campo esquecido quanto um enum inválido que os `expect` pontuais abaixo
        // não cobrem individualmente.
        expect(() => normalizedWebhookEventSchema.parse(parsed)).not.toThrow()

        if (entry.kind.startsWith('incoming')) {
          expect(parsed.kind).toBe('incoming_message')
          if (parsed.kind !== 'incoming_message') return
          expect(parsed.providerMessageId.length).toBeGreaterThan(3)
          expect(parsed.phone.length).toBeGreaterThan(7)
          expect(parsed.conversationExternalId.length).toBeGreaterThan(3)
          if (entry.kind === 'incoming_from_me') expect(parsed.fromMe).toBe(true)
          if (entry.kind === 'incoming_audio' || entry.kind === 'incoming_image' || entry.kind === 'incoming_document') {
            expect(parsed.media, 'mídia precisa de referência/chave de correlação').not.toBeNull()
          }
          if (entry.kind === 'incoming_reply') expect(parsed.replyToProviderMessageId).not.toBeNull()
        }
        if (entry.kind === 'status_update') {
          expect(parsed.kind).toBe('message_status_update')
          if (parsed.kind !== 'message_status_update') return
          expect(parsed.providerMessageId.length).toBeGreaterThan(3)
          expect(['sent', 'delivered', 'read', 'failed']).toContain(parsed.status)
        }
        if (entry.kind === 'connection_update') {
          expect(parsed.kind).toBe('connection_status_change')
          if (parsed.kind !== 'connection_status_change') return
          expect(['connected', 'disconnected', 'connecting']).toContain(parsed.status)
        }
      })
    }

    it('payload desconhecido retorna null, nunca lança', () => {
      expect(provider.parseWebhook({ event: 'algo.novo.desconhecido', data: {} })).toBeNull()
      expect(provider.parseWebhook('lixo')).toBeNull()
      expect(provider.parseWebhook(null)).toBeNull()
    })
  })
}
