"use client"

import { useCallback, useEffect, useState } from "react"
import { ApiError, getMyStatus, type MeStatusResponse } from "@/lib/api"

const POLL_INTERVAL_MS = 30_000

// Badge de conexão da instância WhatsApp (Task 7, spec §7) — poll de 30s em /me/status.
// `disconnected` vira banner vermelho de alto contraste: "instância morta em silêncio é o
// pior modo de falha do produto" (ADR-0003). T8 substitui o poll pelo evento
// ConnectionStatusChange via Supabase Realtime (ADR-0005) — este poll é só a ponte.
export function InstanceBadge({ accessToken }: { accessToken: string | null }) {
  const [status, setStatus] = useState<MeStatusResponse | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!accessToken) return
    try {
      const result = await getMyStatus(accessToken)
      setStatus(result)
      setErrorMessage(null)
    } catch (err) {
      setErrorMessage(err instanceof ApiError ? err.message : "Falha ao verificar status da instância.")
    }
  }, [accessToken])

  useEffect(() => {
    load()
    const interval = setInterval(load, POLL_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [load])

  if (status?.connectionState === "disconnected") {
    return (
      <div role="alert" className="w-full bg-destructive px-4 py-2 text-center text-sm font-medium text-white">
        Instância WhatsApp desconectada
      </div>
    )
  }

  // Falha ao consultar o status (rede/API fora do ar): honesto, mas discreto — não é o
  // mesmo alerta de instância desconectada, então não usa o mesmo destaque.
  if (errorMessage) {
    return (
      <div className="w-full bg-amber-500/10 px-4 py-1 text-center text-xs text-amber-700 dark:text-amber-400">
        {errorMessage}
      </div>
    )
  }

  return null
}
