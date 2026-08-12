"use client"

import { useCallback, useEffect, useState } from "react"
import type { ConversationSummary } from "@aios-pocket/contracts"
import { ApiError, getConversations } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { displayName, formatTime } from "./format"

type Status = "loading" | "error" | "ready"

// Lista de conversas (Task 7, spec §7): nome ?? telefone + hora da última mensagem. Sem
// realtime ainda (T8 substitui) — carrega uma vez e oferece um botão de atualizar manual.
export function ConversationList({
  accessToken,
  selectedId,
  onSelect,
}: {
  accessToken: string | null
  selectedId: string | null
  onSelect: (conversation: ConversationSummary) => void
}) {
  const [status, setStatus] = useState<Status>("loading")
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!accessToken) return
    setStatus((prev) => (prev === "ready" ? prev : "loading"))
    try {
      const result = await getConversations(accessToken)
      setConversations(result)
      setStatus("ready")
      setErrorMessage(null)
    } catch (err) {
      setErrorMessage(err instanceof ApiError ? err.message : "Falha ao carregar conversas.")
      setStatus("error")
    }
  }, [accessToken])

  useEffect(() => {
    load()
  }, [load])

  return (
    <div className="flex h-full w-full max-w-sm shrink-0 flex-col border-r border-border">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">Conversas</h2>
        <Button variant="ghost" size="sm" onClick={load} disabled={status === "loading"}>
          Atualizar
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {status === "loading" && conversations.length === 0 ? (
          <ListSkeleton />
        ) : status === "error" && conversations.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
            <p className="text-sm text-muted-foreground">{errorMessage}</p>
            <Button variant="outline" size="sm" onClick={load}>
              Tentar novamente
            </Button>
          </div>
        ) : conversations.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">Nenhuma conversa ainda.</p>
        ) : (
          <ul>
            {conversations.map((conversation) => (
              <li key={conversation.id}>
                <button
                  type="button"
                  onClick={() => onSelect(conversation)}
                  className={cn(
                    "flex w-full flex-col gap-0.5 border-b border-border px-4 py-3 text-left transition-colors hover:bg-muted",
                    selectedId === conversation.id && "bg-muted",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">{displayName(conversation.customer)}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {formatTime(conversation.lastMessageAt)}
                    </span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      {[0, 1, 2, 3].map((key) => (
        <div key={key} className="h-10 animate-pulse rounded-md bg-muted" />
      ))}
    </div>
  )
}
