"use client"

import { useEffect, useRef } from "react"
import { createClient } from "@/lib/supabase/client"

// Realtime do Inbox (Task 8, Plano C — ADR-0005): o browser assina postgres_changes de
// INSERT/UPDATE em public.messages e public.conversations. O RLS read-only da Task 2
// (policies realtime_read_* + SECURITY DEFINER company_ids_of_current_user) garante que o
// Supabase só entrega eventos de linhas da company do usuário autenticado — o filtro de
// tenancy mora no Postgres, porque o Realtime não conhece o TenantContext da aplicação.
//
// Estratégia deliberada: o evento é um SINAL, não a fonte dos dados. O payload do Realtime
// traz a linha crua do banco (colunas snake_case), enquanto a UI consome os DTOs validados
// de @aios-pocket/contracts servidos pela API (Task 5) — mapear linha crua → DTO aqui seria
// duplicar no frontend a tradução que já vive na API (CLAUDE.md §4: "nunca duplicar lógica
// entre módulos"). Então cada evento apenas dispara o refetch do que ele toca, com debounce
// para colapsar rajadas (acks sent→delivered→read chegam em sequência). No volume do
// piloto, o custo é desprezível e o estado exibido é sempre a verdade da API.
//
// Reconexão: o supabase-js refaz o socket e o canal sozinho; todo status SUBSCRIBED (o
// primeiro E cada resubscribe pós-queda) dispara um refetch de segurança de tudo — eventos
// perdidos durante o vão entre conectar/cair nunca deixam a tela mentindo (requisito
// explícito da Task 8: "resubscribe + refetch de segurança").

const DEBOUNCE_MS = 300

export function useInboxRealtime({
  accessToken,
  conversationId,
  onConversationsTouched,
  onMessagesTouched,
}: {
  accessToken: string | null
  // Conversa aberta agora — eventos de messages de OUTRAS conversas não disparam o refetch
  // da thread (só o da lista). Vive numa ref para não derrubar/recriar o canal a cada troca
  // de seleção.
  conversationId: string | null
  onConversationsTouched: () => void
  onMessagesTouched: () => void
}): void {
  const conversationIdRef = useRef(conversationId)
  useEffect(() => {
    conversationIdRef.current = conversationId
  }, [conversationId])

  // Callbacks em ref: o canal assina UMA vez por sessão autenticada; identidades novas das
  // funções a cada render do pai não podem forçar resubscribe (mesmo padrão de staleness
  // por ref de conversation-view.tsx).
  const callbacksRef = useRef({ onConversationsTouched, onMessagesTouched })
  useEffect(() => {
    callbacksRef.current = { onConversationsTouched, onMessagesTouched }
  })

  const hasSession = accessToken != null
  // Token em ref pelo mesmo motivo: o refresh de token NÃO recria o canal — o supabase-js
  // propaga o token novo ao socket sozinho (realtime.setAuth em TOKEN_REFRESHED); a ref só
  // alimenta o setAuth inicial, antes do primeiro subscribe.
  const accessTokenRef = useRef(accessToken)
  useEffect(() => {
    accessTokenRef.current = accessToken
  }, [accessToken])

  useEffect(() => {
    if (!hasSession) return

    const supabase = createClient()
    let conversationsTimer: ReturnType<typeof setTimeout> | null = null
    let messagesTimer: ReturnType<typeof setTimeout> | null = null

    const touchConversations = () => {
      if (conversationsTimer) clearTimeout(conversationsTimer)
      conversationsTimer = setTimeout(() => callbacksRef.current.onConversationsTouched(), DEBOUNCE_MS)
    }
    const touchMessages = () => {
      if (messagesTimer) clearTimeout(messagesTimer)
      messagesTimer = setTimeout(() => callbacksRef.current.onMessagesTouched(), DEBOUNCE_MS)
    }

    // Linha crua do banco (snake_case) — só o conversation_id interessa aqui (roteia o
    // evento para a thread aberta ou não); o conteúdo real vem do refetch na API.
    const handleMessageChange = (payload: { new: Record<string, unknown> }) => {
      touchConversations() // mensagem nova/ack reordena a lista e atualiza lastMessageAt
      const rowConversationId = payload.new["conversation_id"]
      if (typeof rowConversationId === "string" && rowConversationId === conversationIdRef.current) {
        touchMessages()
      }
    }
    const handleConversationChange = () => {
      touchConversations()
    }

    // Garante que o socket do Realtime já nasce com o JWT da sessão (a policy RLS é para a
    // role authenticated — com o token anon, o canal conecta mas nunca entrega nada).
    supabase.realtime.setAuth(accessTokenRef.current)

    const channel = supabase
      .channel("inbox-realtime")
      // INSERT+UPDATE explícitos (escopo da Task 8) — DELETE não existe no domínio
      // (messages/conversations nunca são apagadas; ADR-0004: histórico não mente).
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, handleMessageChange)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "messages" }, handleMessageChange)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "conversations" }, handleConversationChange)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "conversations" }, handleConversationChange)
      .subscribe((status) => {
        // Todo SUBSCRIBED = começo de um período em que confiamos no canal. Refetch de
        // segurança imediato (sem debounce): cobre tanto o vão entre o load inicial dos
        // componentes e o canal ficar de pé, quanto eventos perdidos durante uma queda.
        if (status === "SUBSCRIBED") {
          callbacksRef.current.onConversationsTouched()
          callbacksRef.current.onMessagesTouched()
        }
      })

    return () => {
      if (conversationsTimer) clearTimeout(conversationsTimer)
      if (messagesTimer) clearTimeout(messagesTimer)
      supabase.removeChannel(channel)
    }
  }, [hasSession])
}
