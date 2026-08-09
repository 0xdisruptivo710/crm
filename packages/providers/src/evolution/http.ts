import type { EvolutionConfig } from '../types.js'

// Cliente HTTP mínimo da Evolution v2. Único lugar do produto que fala com a API dela.
export async function evolutionRequest<T>(
  config: EvolutionConfig,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${config.baseUrl}${path}`, {
    method,
    headers: { apikey: config.apiKey, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`evolution ${method} ${path} falhou: ${res.status} ${text.slice(0, 300)}`)
  }
  return (await res.json()) as T
}
