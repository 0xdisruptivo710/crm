import type { ConnectionStatusChange, IncomingMessage, MessageStatusUpdate, NormalizedWebhookEvent } from '@aios-pocket/contracts'

// Shapes REAIS observados nas fixtures (tests/providers/fixtures/evolution/), não os
// da documentação da Evolution — ela mente sobre vários detalhes (ex.: contextInfo de
// reply vem como IRMÃO de `message`, não aninhado nele). Ver README das fixtures.

interface EvolutionKey {
  id?: unknown
  fromMe?: unknown
  remoteJid?: unknown
}

interface EvolutionContextInfo {
  stanzaId?: unknown
}

interface EvolutionMediaMessage {
  url?: unknown
  mimetype?: unknown
}

interface EvolutionImageMessage extends EvolutionMediaMessage {
  caption?: unknown
}

interface EvolutionDocumentMessage extends EvolutionMediaMessage {
  title?: unknown
  fileName?: unknown
}

interface EvolutionMessageContent {
  conversation?: unknown
  audioMessage?: EvolutionMediaMessage
  imageMessage?: EvolutionImageMessage
  documentMessage?: EvolutionDocumentMessage
  videoMessage?: EvolutionMediaMessage
  stickerMessage?: EvolutionMediaMessage
}

interface EvolutionUpsertData {
  key?: EvolutionKey
  message?: EvolutionMessageContent
  pushName?: unknown
  contextInfo?: EvolutionContextInfo | null
  messageType?: unknown
  messageTimestamp?: unknown
}

interface EvolutionUpdateData {
  keyId?: unknown
  status?: unknown
}

interface EvolutionConnectionData {
  state?: unknown
  statusReason?: unknown
}

interface EvolutionWebhookEnvelope {
  event?: unknown
  data?: unknown
  date_time?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

// Extrai só os dígitos do JID (ex.: "5511999990006@s.whatsapp.net" → "5511999990006").
// O sufixo varia (@s.whatsapp.net, @lid) mas o número sempre vem antes do "@".
function phoneFromJid(jid: string): string {
  return jid.split('@')[0] ?? jid
}

// JIDs de grupo (@g.us) nunca viram IncomingMessage no v1 — o CRM modela conversa 1:1
// (Domain.md) e o módulo de telefone (Task 3) rejeita esse formato de qualquer forma.
// Falhar aqui, cedo, evita propagar um "phone" inválido rio abaixo.
function isGroupJid(jid: string): boolean {
  return jid.endsWith('@g.us')
}

// Endereçamento "LID" (linked ID) do WhatsApp no TOPO do key.remoteJid: não é um número
// de telefone real, é um identificador interno — canonicalizePhone (Task 3) até aceitaria
// os dígitos, mas o "telefone" resultante seria fantasma (não dá para resolver Customer
// nem responder de volta a partir dele). Nenhuma fixture real tem key.remoteJid @lid no
// topo hoje (o @lid observado nas fixtures aparece em campos aninhados, ex.:
// contextInfo.participant) — comportamento defensivo antecipado (achado da revisão T10).
// Carry-over consciente para Plano C/D: suporte a LID de verdade exige outro fluxo de
// resolução de identidade, não um patch aqui.
function isLidJid(jid: string): boolean {
  return jid.endsWith('@lid')
}

// Timestamp da Evolution vem em segundos unix (messageTimestamp); date_time do envelope
// é ISO 8601. Ambos convertidos para Date; nunca deixamos `undefined` virar `new Date(undefined)`
// (que resultaria em "Invalid Date" silencioso).
function timestampFromUnixSeconds(value: unknown, fallbackIso: unknown): Date {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value * 1000)
  const iso = asString(fallbackIso)
  if (iso) return new Date(iso)
  return new Date()
}

function parseMessagesUpsert(data: EvolutionUpsertData, dateTime: unknown): IncomingMessage | null {
  const key = data.key
  const remoteJid = isRecord(key) ? asString(key.remoteJid) : null
  const providerMessageId = isRecord(key) ? asString(key.id) : null
  if (!remoteJid || !providerMessageId) return null
  if (isGroupJid(remoteJid)) return null
  if (isLidJid(remoteJid)) return null

  const message = data.message
  if (!isRecord(message)) return null

  const conversation = asString(message.conversation)
  const audio = isRecord(message.audioMessage) ? (message.audioMessage as EvolutionMediaMessage) : null
  const image = isRecord(message.imageMessage) ? (message.imageMessage as EvolutionImageMessage) : null
  const document = isRecord(message.documentMessage) ? (message.documentMessage as EvolutionDocumentMessage) : null
  const video = isRecord(message.videoMessage) ? (message.videoMessage as EvolutionMediaMessage) : null
  const sticker = isRecord(message.stickerMessage) ? (message.stickerMessage as EvolutionMediaMessage) : null

  let type: IncomingMessage['type']
  let text: string | null = null
  let media: IncomingMessage['media'] = null

  if (conversation !== null) {
    type = 'text'
    text = conversation
  } else if (audio) {
    type = 'audio'
    media = { url: asString(audio.url), mimeType: asString(audio.mimetype), correlationKey: providerMessageId }
  } else if (image) {
    type = 'image'
    text = asString(image.caption)
    media = { url: asString(image.url), mimeType: asString(image.mimetype), correlationKey: providerMessageId }
  } else if (document) {
    type = 'document'
    text = asString(document.title) ?? asString(document.fileName)
    media = { url: asString(document.url), mimeType: asString(document.mimetype), correlationKey: providerMessageId }
  } else if (video) {
    type = 'video'
    media = { url: asString(video.url), mimeType: asString(video.mimetype), correlationKey: providerMessageId }
  } else if (sticker) {
    type = 'sticker'
    media = { url: asString(sticker.url), mimeType: asString(sticker.mimetype), correlationKey: providerMessageId }
  } else {
    // reactionMessage, secretEncryptedMessage, templateMessage e qualquer outro tipo
    // não decodificado: ignorado conscientemente no v1 (ADR-0003 permite null para
    // eventos irrelevantes) — melhor não virar IncomingMessage do que virar um
    // errado. Ver tests/providers/fixtures/README.md sobre `incoming_special`.
    return null
  }

  // contextInfo de reply vem como IRMÃO de `data.message`, não aninhado nele — forma
  // real observada em incoming_reply-1/2.json, diferente da doc da Evolution.
  const stanzaId = isRecord(data.contextInfo) ? asString(data.contextInfo.stanzaId) : null

  return {
    kind: 'incoming_message',
    provider: 'evolution',
    providerMessageId,
    phone: phoneFromJid(remoteJid),
    conversationExternalId: remoteJid,
    fromMe: isRecord(key) ? key.fromMe === true : false,
    type,
    text,
    media,
    replyToProviderMessageId: stanzaId,
    // Evolution 2.3.7 não emite evento de edição via webhook (verificado ao vivo,
    // ver README das fixtures) — sempre false no v1. Campo continua no contrato
    // porque outro provider (Z-API, Plano D) pode entregá-lo.
    isEdit: false,
    timestamp: timestampFromUnixSeconds(data.messageTimestamp, dateTime),
    metadata: {
      pushName: asString(data.pushName),
      messageType: asString(data.messageType),
    },
  }
}

// Status/ack da Evolution (Baileys por baixo) não mapeiam 1:1 para a máquina de
// estados do ADR-0006. PENDING e SERVER_ACK (mensagem aceita/entregue ao servidor do
// WhatsApp, ainda não no aparelho do destinatário) colapsam em "sent" — o contrato só
// tem sent/delivered/read/failed, sem um estado intermediário para elas. ERROR (falha
// genuína de envio) mapeia para "failed" — faltava na v1 (achado da revisão T10: sem
// isso, uma falha de envio de verdade virava null e desaparecia silenciosamente em vez
// de acionar a máquina de estados). Valor desconhecido continua ignorado (null) em vez
// de arriscar um mapeamento errado. Exportado para teste direto e puro da tabela
// (packages/providers/test/evolution-parse-edge-cases.test.ts) — sem fixture real para
// ERROR ainda, então o teste cobre a tabela, não um payload capturado.
export const STATUS_MAP: Record<string, MessageStatusUpdate['status']> = {
  PENDING: 'sent',
  SERVER_ACK: 'sent',
  DELIVERY_ACK: 'delivered',
  READ: 'read',
  ERROR: 'failed',
}

function parseMessagesUpdate(data: EvolutionUpdateData, dateTime: unknown): MessageStatusUpdate | null {
  // O ID que correlaciona com `key.id` de messages.upsert é `data.keyId`, NÃO
  // `data.messageId` (esse é um id interno da Evolution, formato cuid, sem relação
  // com o id da mensagem no WhatsApp) — confirmado cruzando os fixtures reais
  // (mesmo `key.id`/`keyId` aparece em incoming_from_me-1 e status_update-1).
  const providerMessageId = asString(data.keyId)
  if (!providerMessageId) return null

  const rawStatus = asString(data.status)
  const status = rawStatus ? STATUS_MAP[rawStatus] : undefined
  if (!status) return null

  return {
    kind: 'message_status_update',
    provider: 'evolution',
    providerMessageId,
    status,
    timestamp: timestampFromUnixSeconds(undefined, dateTime),
  }
}

function parseConnectionUpdate(data: EvolutionConnectionData, dateTime: unknown): ConnectionStatusChange {
  const state = asString(data.state)
  // "Instância morta em silêncio é o pior modo de falha do produto" (ADR-0003) — por
  // isso qualquer estado que não seja explicitamente "open"/"connecting" vira
  // "disconnected" (alerta), nunca null. Melhor um falso alarme do que silêncio.
  const status: ConnectionStatusChange['status'] = state === 'open' ? 'connected' : state === 'connecting' ? 'connecting' : 'disconnected'

  return {
    kind: 'connection_status_change',
    provider: 'evolution',
    status,
    reason: data.statusReason != null ? String(data.statusReason) : null,
    timestamp: timestampFromUnixSeconds(undefined, dateTime),
  }
}

// Nunca lança em payload estranho (ADR-0003): retorna null e o worker marca o raw
// como processado-ignorado. Todo `unknown` é checado antes de ser lido.
export function parseEvolutionWebhook(raw: unknown): NormalizedWebhookEvent | null {
  if (!isRecord(raw)) return null
  const envelope = raw as EvolutionWebhookEnvelope
  const event = asString(envelope.event)
  if (!event) return null
  const data = envelope.data
  if (!isRecord(data)) return null

  switch (event) {
    case 'messages.upsert':
      return parseMessagesUpsert(data as EvolutionUpsertData, envelope.date_time)
    case 'messages.update':
      return parseMessagesUpdate(data as EvolutionUpdateData, envelope.date_time)
    case 'connection.update':
      return parseConnectionUpdate(data as EvolutionConnectionData, envelope.date_time)
    default:
      // Inclui send.message (eco do próprio envio) e qualquer evento futuro
      // desconhecido — ignorado, nunca lançado.
      return null
  }
}
