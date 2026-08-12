"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import type { ConversationSummary, MessageView } from "@aios-pocket/contracts"
import { ApiError, getMessages } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { Composer } from "./composer"
import { displayName, formatTime } from "./format"

const POLL_INTERVAL_MS = 15_000

type Status = "loading" | "error" | "ready"

// Conversa aberta (Task 7, spec §7): bolhas de mensagem + composer. Sem realtime ainda
// (T8 substitui por Supabase Realtime, ADR-0005) — poll leve de 15s enquanto a conversa
// está aberta, mais um botão de atualizar manual, como ponte.
export function ConversationView({
  accessToken,
  conversation,
}: {
  accessToken: string | null
  conversation: ConversationSummary | null
}) {
  const [messages, setMessages] = useState<MessageView[]>([])
  const [status, setStatus] = useState<Status>("loading")
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  // Guarda de staleness (fix round 1 — Important da revisão): load()/poll/refresh manual
  // são todos assíncronos e podem resolver DEPOIS que o usuário já trocou de conversa. Sem
  // isto, uma resposta tardia da conversa ANTERIOR sobrescreve `messages` da conversa NOVA
  // por até um ciclo de poll (~15s) — o reset síncrono abaixo só cobre o instante da troca,
  // não uma resolução tardia em voo. Mesmo padrão `ref` de lib/supabase/use-access-token.ts
  // (lá era `active`/cleanup de effect; aqui é o id da conversa corrente, checado depois de
  // cada await antes de qualquer setState).
  const currentConversationIdRef = useRef<string | null>(null)

  const load = useCallback(async () => {
    if (!accessToken || !conversation) return
    const requestedConversationId = conversation.id
    setStatus((prev) => (prev === "ready" ? prev : "loading"))
    try {
      const result = await getMessages(accessToken, requestedConversationId)
      // A conversa selecionada já mudou de novo enquanto este fetch estava em voo —
      // descarta a resposta (pertence a uma conversa que não é mais a exibida).
      if (currentConversationIdRef.current !== requestedConversationId) return
      setMessages(result)
      setStatus("ready")
      setErrorMessage(null)
    } catch (err) {
      if (currentConversationIdRef.current !== requestedConversationId) return
      setErrorMessage(err instanceof ApiError ? err.message : "Falha ao carregar mensagens.")
      setStatus("error")
    }
  }, [accessToken, conversation])

  // Limpa a conversa anterior IMEDIATAMENTE ao trocar de seleção — sem isto a tela mostra
  // mensagens da conversa errada até o fetch da nova resolver (estados honestos). Também
  // atualiza a ref de staleness ANTES de qualquer load() da conversa nova poder disparar
  // (effects rodam em ordem de declaração no mesmo commit — ver efeito seguinte).
  useEffect(() => {
    currentConversationIdRef.current = conversation?.id ?? null
    setMessages([])
    setStatus("loading")
    setErrorMessage(null)
  }, [conversation?.id])

  useEffect(() => {
    if (!conversation) return
    load()
    const interval = setInterval(load, POLL_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [conversation, load])

  function appendOptimistic(message: MessageView) {
    setMessages((prev) => [...prev, message])
  }

  if (!conversation) {
    return (
      <div className="flex h-full flex-1 items-center justify-center">
        <p className="text-sm text-muted-foreground">Selecione uma conversa.</p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div>
          <p className="text-sm font-semibold">{displayName(conversation.customer)}</p>
          <p className="text-xs text-muted-foreground">{conversation.customer.phoneE164}</p>
        </div>
        <Button variant="ghost" size="sm" onClick={load}>
          Atualizar
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {status === "loading" && messages.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Carregando mensagens…</p>
        ) : status === "error" && messages.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-8">
            <p className="text-sm text-muted-foreground">{errorMessage}</p>
            <Button variant="outline" size="sm" onClick={load}>
              Tentar novamente
            </Button>
          </div>
        ) : messages.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Nenhuma mensagem ainda.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {messages.map((message) => (
              <MessageBubble key={message.id} message={message} />
            ))}
          </div>
        )}
      </div>

      <Composer accessToken={accessToken} conversationId={conversation.id} onQueued={appendOptimistic} />
    </div>
  )
}

function MessageBubble({ message }: { message: MessageView }) {
  const isOutbound = message.direction === "outbound"

  return (
    <div className={cn("flex", isOutbound ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[75%] rounded-lg px-3 py-2 text-sm",
          isOutbound ? "bg-primary text-primary-foreground" : "bg-muted text-foreground",
        )}
      >
        {message.type !== "text" ? <MediaAttachment message={message} /> : null}
        {message.text ? <p className="whitespace-pre-wrap">{message.text}</p> : null}
        <div className="mt-1 flex items-center justify-end gap-1 text-[11px] opacity-70">
          {isOutbound ? <span>{message.fromMe ? "você — celular" : "você — Aios Pocket"}</span> : null}
          <span>{formatTime(message.createdAt)}</span>
          {isOutbound ? <MessageStateIcon message={message} /> : null}
        </div>
      </div>
    </div>
  )
}

function MessageStateIcon({ message }: { message: MessageView }) {
  if (message.state === "failed") {
    // O contrato de GET /conversations/:id/messages (Task 5) não expõe failReason — só o
    // estado. Tooltip com o motivo específico fica pendente de uma mudança de contrato
    // fora do escopo de arquivos desta task (fica registrado no relatório).
    return (
      <span title="Falha no envio" className="text-destructive">
        ✗
      </span>
    )
  }
  if (message.state === "read") {
    return <span className="text-blue-500">✓✓</span>
  }
  if (message.state === "sent" || message.state === "delivered") {
    return <span>✓✓</span>
  }
  // queued | sending | received
  return <span>✓</span>
}

const MEDIA_TYPE_LABELS: Record<MessageView["type"], string> = {
  text: "Texto",
  image: "Imagem",
  audio: "Áudio",
  video: "Vídeo",
  document: "Documento",
  sticker: "Figurinha",
  unknown: "Mídia",
}

function MediaAttachment({ message }: { message: MessageView }) {
  const label = MEDIA_TYPE_LABELS[message.type]

  if (!message.mediaUrl) {
    return <p className="mb-1 text-xs italic opacity-70">{label} (sem link disponível)</p>
  }

  return (
    <a
      href={message.mediaUrl}
      target="_blank"
      rel="noreferrer"
      className="mb-1 flex items-center gap-1 text-xs underline underline-offset-2"
    >
      {label} — abrir anexo
    </a>
  )
}
