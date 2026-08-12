"use client"

import { useEffect, useState } from "react"
import { createClient } from "./client"

// Mantém o access_token da sessão Supabase disponível para os componentes do Inbox — o
// supabase-js renova o token sozinho em background (persistSession/autoRefreshToken,
// padrão do createBrowserClient) e dispara onAuthStateChange quando troca; centralizar
// aqui evita que cada componente (lista, conversa, composer, badge) duplique essa leitura
// (CLAUDE.md §4: "nunca duplicar lógica entre módulos").
export function useAccessToken(): { accessToken: string | null; loading: boolean } {
  const [accessToken, setAccessToken] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const supabase = createClient()
    let active = true

    supabase.auth.getSession().then(({ data }) => {
      if (!active) return
      setAccessToken(data.session?.access_token ?? null)
      setLoading(false)
    })

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setAccessToken(session?.access_token ?? null)
    })

    return () => {
      active = false
      listener.subscription.unsubscribe()
    }
  }, [])

  return { accessToken, loading }
}
