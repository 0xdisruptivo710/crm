import type { MessageState } from '@aios-pocket/contracts'

// Máquina de estados de Message (ADR-0006), pura — só avança, nunca regride.
// received/queued/sending são todos "pré-envio" (mesmo patamar); sent < delivered < read
// formam uma escada estrita onde qualquer salto para a frente é aceito (acks podem
// colapsar etapas — nem todo provider manda "delivered" antes de "read").
// failed é terminal: nada muda depois dele. Uma mensagem já "read" ainda pode ser
// marcada "failed" (ex.: falha reportada tardiamente pelo provider) — a única transição
// bloqueada É sair de failed, não chegar nele.
const RANK: Record<Exclude<MessageState, 'failed'>, number> = {
  received: 0,
  queued: 0,
  sending: 0,
  sent: 1,
  delivered: 2,
  read: 3,
}

export function nextState(
  current: MessageState,
  incoming: 'sent' | 'delivered' | 'read' | 'failed',
): MessageState | null {
  if (current === 'failed') return null // terminal: nenhuma transição sai dele
  if (incoming === 'failed') return 'failed'
  if (RANK[incoming] <= RANK[current]) return null // regressão ou repetição: ignorado
  return incoming
}
