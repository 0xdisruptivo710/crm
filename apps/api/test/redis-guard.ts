// Guarda de segurança para testes de integração que fazem operações destrutivas em Redis
// (obliterate, filas reais — events.test.ts e send-flow.test.ts). O Redis remoto de dev é
// COMPARTILHADO com o índice 0, que hoje é o Redis VIVO do piloto (BullMQ de produção do
// Plano B). Só passam: localhost (Redis efêmero do CI) OU um índice de banco dedicado
// (>=1) no Redis remoto — nunca o índice 0 remoto.
export function assertTestRedis(url: string): void {
  const parsed = new URL(url)
  const isLocalhost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
  const pathIndex = parsed.pathname.replace(/^\//, '')
  const dbIndex = pathIndex === '' ? 0 : Number(pathIndex)
  const hasDedicatedIndex = Number.isFinite(dbIndex) && dbIndex >= 1
  if (isLocalhost || hasDedicatedIndex) return
  throw new Error(
    'Redis de teste deve usar localhost ou db index dedicado (>=1) — o índice 0 remoto é o Redis VIVO do piloto',
  )
}
