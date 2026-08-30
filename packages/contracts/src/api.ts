import { z } from 'zod'
// Sem sufixo `.js` — ver comentário em index.ts deste pacote (exigência do Turbopack para
// resolver o workspace package transpilado consumido pelo apps/web, Task 7 do Plano C).
import { messageStateSchema, messageTypeSchema, providerSchema } from './webhooks'

// Validação COMPARTILHADA entre web e api (regra do CLAUDE.md §4: "todo endpoint nasce
// com validação Zod... compartilhada entre web e api"). Usado pela rota POST /messages
// (apps/api/src/routes/messages.ts) e, no futuro, pelo formulário de envio do apps/web —
// um único schema, nunca duas validações divergentes do mesmo contrato.
export const sendMessageRequestSchema = z.object({
  conversationId: z.uuid(),
  // OBRIGATÓRIO — a UI sempre gera via crypto.randomUUID(). É a chave de idempotência do
  // envio (unique [companyId, clientMessageId] em Message) e o rastreio estável 202↔linha:
  // um retry de rede/duplo clique do MESMO clientMessageId nunca cria uma segunda Message,
  // fechando o "202 dangling" apontado na review do Plano B.
  clientMessageId: z.uuid(),
  text: z.string().min(1).max(4096),
})

export type SendMessageRequest = z.infer<typeof sendMessageRequestSchema>

// Reaproveita os enums já definidos em webhooks.ts (regra do CLAUDE.md §4: "reutilizar
// antes de criar") — status de Conversation/direction de Message não existiam ali porque
// não fazem parte da união normalizada de webhook (ADR-0003), só do schema de domínio.
export const conversationStatusSchema = z.enum(['open', 'closed'])
export const messageDirectionSchema = z.enum(['inbound', 'outbound'])

// Resposta de GET /conversations (Task 5): lista por lastMessageAt desc, customer embutido
// para a UI não precisar de um round-trip extra por conversa.
export const conversationSummarySchema = z.object({
  id: z.uuid(),
  provider: providerSchema,
  status: conversationStatusSchema,
  lastMessageAt: z.coerce.date().nullable(),
  customer: z.object({
    id: z.uuid(),
    phoneE164: z.string(),
    name: z.string().nullable(),
  }),
})

export type ConversationSummary = z.infer<typeof conversationSummarySchema>

// Resposta de GET /conversations/:id/messages (Task 5): mensagens createdAt asc.
export const messageViewSchema = z.object({
  id: z.uuid(),
  direction: messageDirectionSchema,
  state: messageStateSchema,
  type: messageTypeSchema,
  text: z.string().nullable(),
  mediaUrl: z.string().nullable(),
  mediaMimeType: z.string().nullable(),
  fromMe: z.boolean(),
  providerMessageId: z.string().nullable(),
  // Motivo da falha para a UI (tooltip da cicatriz ✗ — ADR-0006: falha nunca silenciosa).
  // null em toda mensagem que não está em `failed` (carry-over do Plano B, entregue no D).
  failReason: z.string().nullable(),
  createdAt: z.coerce.date(),
})

export type MessageView = z.infer<typeof messageViewSchema>
