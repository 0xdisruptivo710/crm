import { z } from 'zod'

// Env carregado pelos scripts via dotenv-cli (scripts standalone não leem .env sozinhos).
const envSchema = z.object({
  PORT: z.coerce.number().default(3001),
  SUPABASE_URL: z.string().url(),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  // Chave de cifra das credenciais de provider da Company (ADR-0002) — consumida por
  // provider-factory.ts via decryptJson (packages/db/src/crypto.ts).
  APP_ENCRYPTION_KEY: z.string().min(1),
  // Origens permitidas para o browser do inbox (Task 9 do Plano C; metade "código"
  // adiantada na T8 para a prova via browser). Lista separada por vírgula (ex.:
  // "https://<app>.vercel.app,http://localhost:3000"). AUSENTE = CORS não registrado —
  // comportamento idêntico ao deploy atual (nenhuma origem cross-site liberada).
  WEB_ORIGIN: z.string().optional(),
})

export const config = envSchema.parse(process.env)
