"use client"

import { useState, type FormEvent } from "react"
import type { MessageView } from "@aios-pocket/contracts"
import { ApiError, sendMessage } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

// Composer (Task 7, spec §7): envia via POST /messages com clientMessageId gerado por
// crypto.randomUUID() (Task 4 — chave de idempotência do envio). Só entra na lista local
// como otimista `queued` DEPOIS do POST confirmar (202) — nunca mostra uma mensagem que a
// API não aceitou (estados honestos). O próximo poll/refresh de ConversationView substitui
// esse item pela linha real assim que a API responder.
export function Composer({
  accessToken,
  conversationId,
  onQueued,
}: {
  accessToken: string | null
  conversationId: string
  onQueued: (message: MessageView) => void
}) {
  const [text, setText] = useState("")
  const [sending, setSending] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const trimmed = text.trim()
    if (!trimmed || !accessToken || sending) return

    setErrorMessage(null)
    setSending(true)

    const clientMessageId = crypto.randomUUID()

    try {
      await sendMessage(accessToken, { conversationId, clientMessageId, text: trimmed })
      onQueued({
        id: clientMessageId,
        direction: "outbound",
        state: "queued",
        type: "text",
        text: trimmed,
        mediaUrl: null,
        mediaMimeType: null,
        // Enviada pela UI do Aios Pocket, não pelo celular do humano — ver
        // conversation-view.tsx (indicador "você — Aios Pocket" vs "você — celular").
        fromMe: false,
        providerMessageId: null,
        createdAt: new Date(),
      })
      setText("")
    } catch (err) {
      setErrorMessage(err instanceof ApiError ? err.message : "Falha ao enviar mensagem.")
    } finally {
      setSending(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-1 border-t border-border p-3">
      <div className="flex gap-2">
        <Input
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Digite uma mensagem…"
          disabled={sending || !accessToken}
          maxLength={4096}
        />
        <Button type="submit" disabled={sending || !accessToken || !text.trim()}>
          {sending ? "Enviando…" : "Enviar"}
        </Button>
      </div>
      {errorMessage ? (
        <p role="alert" className="text-xs text-destructive">
          {errorMessage}
        </p>
      ) : null}
    </form>
  )
}
