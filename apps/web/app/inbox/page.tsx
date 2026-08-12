"use client"

import { useState } from "react"
import type { ConversationSummary } from "@aios-pocket/contracts"
import { useAccessToken } from "@/lib/supabase/use-access-token"
import { ConversationList } from "./conversation-list"
import { ConversationView } from "./conversation-view"
import { InstanceBadge } from "./instance-badge"

// Inbox (Task 7, Plano C): lista de conversas + conversa aberta + composer + badge de
// conexão da instância. A guarda de sessão roda antes desta página (proxy.ts +
// lib/supabase/session.ts) — sem sessão válida, redirect /login.
export default function InboxPage() {
  const { accessToken, loading } = useAccessToken()
  const [selectedConversation, setSelectedConversation] = useState<ConversationSummary | null>(null)

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
            />
            <ConversationView accessToken={accessToken} conversation={selectedConversation} />
          </>
        )}
      </div>
    </div>
  )
}
