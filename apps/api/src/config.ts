import { z } from 'zod'

// Env carregado pelos scripts via dotenv-cli (scripts standalone não leem .env sozinhos).
const envSchema = z.object({
  PORT: z.coerce.number().default(3001),
  SUPABASE_URL: z.string().url(),
  REDIS_URL: z.string().default('redis://localhost:6379'),
})

export const config = envSchema.parse(process.env)
