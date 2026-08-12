import { z } from "zod"
import {
  conversationSummarySchema,
  messageViewSchema,
  sendMessageRequestSchema,
  type ConversationSummary,
  type MessageView,
  type SendMessageRequest,
} from "@aios-pocket/contracts"

// Client tipado da API (Fastify, apps/api) para o Inbox (Task 7, Plano C). Todo fetch
// valida a resposta com os MESMOS schemas Zod usados pela API em @aios-pocket/contracts —
// nunca confia em `any` implícito de JSON cru (CLAUDE.md §4/§5: "todo endpoint nasce com
// validação Zod... compartilhada entre web e api").
const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL

// Erro tipado de chamada à API: carrega o status HTTP para a UI decidir como reagir
// (retry manual, banner, etc.) sem inspecionar o Response cru em cada componente.
export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = "ApiError"
    this.status = status
  }
}

async function apiFetch<T>(
  path: string,
  schema: z.ZodType<T>,
  accessToken: string,
  init?: RequestInit,
): Promise<T> {
  if (!API_BASE_URL) {
    throw new ApiError("NEXT_PUBLIC_API_URL não configurada.", 0)
  }

  let response: Response
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    })
  } catch {
    throw new ApiError("Falha de rede ao contatar a API.", 0)
  }

  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null)
    const message =
      body && typeof body === "object" && "error" in body && typeof body.error === "string"
        ? body.error
        : `Erro ${response.status} ao contatar a API.`
    throw new ApiError(message, response.status)
  }

  const json: unknown = await response.json()
  const parsed = schema.safeParse(json)
  if (!parsed.success) {
    throw new ApiError("Resposta da API em formato inesperado.", response.status)
  }
  return parsed.data
}

// GET /me/status (Task 5, Plano C) — fora de packages/contracts porque só este client o
// consome hoje (regra do CLAUDE.md §4: "nunca adicionar abstração sem necessidade
// comprovada por pelo menos dois usos reais").
const meStatusResponseSchema = z.object({
  companyId: z.uuid(),
  connectionState: z.enum(["connected", "disconnected", "connecting"]),
})
export type MeStatusResponse = z.infer<typeof meStatusResponseSchema>

const sendMessageResponseSchema = z.object({ messageId: z.uuid() })

export function getConversations(accessToken: string): Promise<ConversationSummary[]> {
  return apiFetch("/conversations", z.array(conversationSummarySchema), accessToken)
}

export function getMessages(accessToken: string, conversationId: string): Promise<MessageView[]> {
  return apiFetch(
    `/conversations/${encodeURIComponent(conversationId)}/messages`,
    z.array(messageViewSchema),
    accessToken,
  )
}

export function getMyStatus(accessToken: string): Promise<MeStatusResponse> {
  return apiFetch("/me/status", meStatusResponseSchema, accessToken)
}

export function sendMessage(
  accessToken: string,
  body: SendMessageRequest,
): Promise<{ messageId: string }> {
  // Valida no cliente com o MESMO schema da rota (packages/contracts) antes do round-trip.
  sendMessageRequestSchema.parse(body)
  return apiFetch("/messages", sendMessageResponseSchema, accessToken, {
    method: "POST",
    body: JSON.stringify(body),
  })
}
