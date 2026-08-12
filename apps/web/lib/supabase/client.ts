import { createBrowserClient } from "@supabase/ssr"

// Cliente Supabase para uso em Client Components (browser). Usa somente a
// anon key — nenhuma chave privilegiada (service_role) pode chegar aqui
// (ADR-0001: "A service_role key do Supabase jamais chega ao frontend").
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  )
}
