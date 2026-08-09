import { createRemoteJWKSet, jwtVerify } from 'jose'
import { config } from '../config.js'

const jwks = createRemoteJWKSet(new URL('/auth/v1/.well-known/jwks.json', config.SUPABASE_URL))

export async function verifySupabaseJwt(token: string): Promise<{ sub: string }> {
  const { payload } = await jwtVerify(token, jwks)
  if (!payload.sub) throw new Error('token sem sub')
  return { sub: payload.sub }
}
