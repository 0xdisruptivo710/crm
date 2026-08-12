import { createServerClient } from "@supabase/ssr"
import { cookies } from "next/headers"

// Cliente Supabase para uso em Server Components / Route Handlers — lê e
// escreve os cookies de sessão via next/headers. Apenas anon key (ver
// lib/supabase/client.ts).
export async function createClient() {
  const cookieStore = await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            )
          } catch {
            // Server Component não pode escrever cookie fora de uma
            // Server Action/Route Handler — a sessão é renovada pelo proxy
            // (lib/supabase/session.ts), que roda antes em toda navegação.
          }
        },
      },
    },
  )
}
