"use client"

import { useCallback, useState } from "react"
import type { ConversationSummary } from "@aios-pocket/contracts"
import { useAccessToken } from "@/lib/supabase/use-access-token"
import { useInboxRealtime } from "@/lib/realtime"
import { ConversationList } from "./conversation-list"
import { ConversationView } from "./conversation-view"
import { InstanceBadge } from "./instance-badge"

// Inbox (Task 7, Plano C): lista de conversas + conversa aberta + composer + badge de
// conexão da instância. A guarda de sessão roda antes desta página (proxy.ts +
// lib/supabase/session.ts) — sem sessão válida, redirect /login.
//
// Realtime (Task 8, ADR-0005): a assinatura vive AQUI (um canal por página, não por
// componente) e propaga "versões" de refresh para os filhos — cada evento relevante do
// Supabase Realtime incrementa o contador, e o filho refaz o fetch na API (a fonte da
// verdade continua sendo os DTOs validados de @aios-pocket/contracts — ver lib/realtime.ts).
export default function InboxPage() {
  const { accessToken, loading } = useAccessToken()
  const [selectedConversation, setSelectedConversation] = useState<ConversationSummary | null>(null)
  const [conversationsVersion, setConversationsVersion] = useState(0)
  const [messagesVersion, setMessagesVersion] = useState(0)

  const bumpConversations = useCallback(() => setConversationsVersion((v) => v + 1), [])
  const bumpMessages = useCallback(() => setMessagesVersion((v) => v + 1), [])

  useInboxRealtime({
    accessToken,
    conversationId: selectedConversation?.id ?? null,
    onConversationsTouched: bumpConversations,
    onMessagesTouched: bumpMessages,
  })

  return (
    <div className="flex h-screen flex-col bg-zinc-50 dark:bg-black">
      <InstanceBadge accessToken={accessToken} />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {loading ? (
          <div className="flex flex-1 items-center justify-center">
            <p className="text-sm text-muted-foreground">Carregando sessão…</p>
          </div>
        ) : (
          <>
            <ConversationList
              accessToken={accessToken}
              selectedId={selectedConversation?.id ?? null}
              onSelect={setSelectedConversation}
              refreshVersion={conversationsVersion}
            />
            <ConversationView
              accessToken={accessToken}
              conversation={selectedConversation}
              refreshVersion={messagesVersion}
            />
          </>
        )}
      </div>
    </div>
  )
}
