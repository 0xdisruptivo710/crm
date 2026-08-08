import { z } from 'zod'

// União normalizada de webhooks (ADR-0003): todo payload de provider vira um destes três tipos.
export const providerSchema = z.enum(['evolution', 'zapi'])
export const messageStateSchema = z.enum(['received', 'queued', 'sending', 'sent', 'delivered', 'read', 'failed'])
export const messageTypeSchema = z.enum(['text', 'image', 'audio', 'video', 'document', 'sticker', 'unknown'])

export const incomingMessageSchema = z.object({
  kind: z.literal('incoming_message'),
  provider: providerSchema,
  providerMessageId: z.string().min(1),
  phone: z.string().min(8),
  conversationExternalId: z.string().min(1),
  fromMe: z.boolean(),
  type: messageTypeSchema,
  text: z.string().nullable(),
  media: z
    .object({
      url: z.string().nullable(),
      mimeType: z.string().nullable(),
      correlationKey: z.string().nullable(),
    })
    .nullable(),
  replyToProviderMessageId: z.string().nullable(),
  isEdit: z.boolean(),
  timestamp: z.coerce.date(),
  metadata: z.record(z.string(), z.unknown()),
})

export const messageStatusUpdateSchema = z.object({
  kind: z.literal('message_status_update'),
  provider: providerSchema,
  providerMessageId: z.string().min(1),
  status: z.enum(['sent', 'delivered', 'read', 'failed']),
  timestamp: z.coerce.date(),
})

export const connectionStatusChangeSchema = z.object({
  kind: z.literal('connection_status_change'),
  provider: providerSchema,
  status: z.enum(['connected', 'disconnected', 'connecting']),
  reason: z.string().nullable(),
  timestamp: z.coerce.date(),
})

export const normalizedWebhookEventSchema = z.discriminatedUnion('kind', [
  incomingMessageSchema,
  messageStatusUpdateSchema,
  connectionStatusChangeSchema,
])

export type Provider = z.infer<typeof providerSchema>
export type MessageState = z.infer<typeof messageStateSchema>
export type IncomingMessage = z.infer<typeof incomingMessageSchema>
export type MessageStatusUpdate = z.infer<typeof messageStatusUpdateSchema>
export type ConnectionStatusChange = z.infer<typeof connectionStatusChangeSchema>
export type NormalizedWebhookEvent = z.infer<typeof normalizedWebhookEventSchema>
