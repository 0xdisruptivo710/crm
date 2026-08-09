import { createRemoteJWKSet, jwtVerify } from 'jose'
import { config } from '../config.js'

const jwks = createRemoteJWKSet(new URL('/auth/v1/.well-known/jwks.json', config.SUPABASE_URL), {
  timeoutDuration: 5000, // Supabase indisponível = falha em 5s, não espera default
})

// Constrói o issuer: <SUPABASE_URL>/auth/v1 (sem trailing slash).
// Exemplo: https://xyzabc.supabase.co/auth/v1
const issuer = new URL('/auth/v1', config.SUPABASE_URL).toString().replace(/\/$/, '')

export async function verifySupabaseJwt(token: string): Promise<{ sub: string }> {
  // jwtVerify valida signature (via JWKS), expiration, issuer e audience.
  // Caso contrário lança error que é catchado em app.ts e logado.
  // Happy path (JWT válido com sub presente) ainda não é testado — requer token real de
  // Supabase. Esse teste fica para Plano C (e2e com live Supabase token).
  const { payload } = await jwtVerify(token, jwks, {
    issuer,
    audience: 'authenticated',
  })
  if (!payload.sub) throw new Error('token sem sub')
  return { sub: payload.sub }
}
