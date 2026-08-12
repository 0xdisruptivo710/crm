import type { NextRequest } from "next/server"
import { updateSession } from "@/lib/supabase/session"

// Guarda de rota das páginas autenticadas. Next.js 16 renomeou o arquivo
// middleware.ts para proxy.ts (função exportada também mudou de nome) — ver
// docs/app/api-reference/file-conventions/proxy.
export function proxy(request: NextRequest) {
  return updateSession(request)
}

export const config = {
  matcher: ["/inbox/:path*"],
}
