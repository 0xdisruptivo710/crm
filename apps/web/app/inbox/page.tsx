// Placeholder do Inbox — a implementação real (lista de conversas, realtime,
// envio) é a Task 7 do Plano C. A guarda de sessão roda antes desta página
// (proxy.ts + lib/supabase/session.ts): sem sessão válida, redirect /login.
export default function InboxPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 px-4 dark:bg-black">
      <p className="text-sm text-muted-foreground">
        Inbox — em construção, T7
      </p>
    </div>
  )
}
