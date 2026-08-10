import { z } from 'zod'

// Validação COMPARTILHADA entre web e api (regra do CLAUDE.md §4: "todo endpoint nasce
// com validação Zod... compartilhada entre web e api"). Usado pela rota POST /messages
// (apps/api/src/routes/messages.ts) e, no futuro, pelo formulário de envio do apps/web —
// um único schema, nunca duas validações divergentes do mesmo contrato.
export const sendMessageRequestSchema = z.object({
  conversationId: z.uuid(),
  text: z.string().min(1).max(4096),
})

export type SendMessageRequest = z.infer<typeof sendMessageRequestSchema>
