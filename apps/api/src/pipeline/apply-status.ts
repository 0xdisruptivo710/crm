import type { MessageState } from '@aios-pocket/contracts'

// Máquina de estados de Message (ADR-0006), pura — só avança, nunca regride.
// received/queued/sending são todos "pré-envio" (mesmo patamar); sent < delivered < read
// formam uma escada estrita onde qualquer salto para a frente é aceito (acks podem
// colapsar etapas — nem todo provider manda "delivered" antes de "read").
// failed é terminal: nada muda depois dele. Um ack de falha TARDIO (chegando depois que
// já sabemos "delivered"/"read") é BLOQUEADO — não regride o estado — porque
// delivered/read são fatos mais fortes e já confirmados do que um erro reportado depois
// (achado FOLDED da revisão T10; antes desta revisão, "failed" sempre vencia, mesmo
// tarde demais). `isBlockedFailureAck` sinaliza esse caso específico para o chamador
// (process-webhook.ts) gravar `failReason` sem tocar no estado.
type ExcludeFailed = Exclude<MessageState, 'failed'>
const RANK: Record<ExcludeFailed, number> = {
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
  if (incoming === 'failed') return isBlockedFailureAck(current, incoming) ? null : 'failed'
  if (RANK[incoming] <= RANK[current]) return null // regressão ou repetição: ignorado
  return incoming
}

// true só quando um ack "failed" chega para uma mensagem já delivered/read — nextState
// bloqueia essa transição (retorna null); isso distingue esse bloqueio de uma regressão
// comum, para o chamador decidir gravar failReason mesmo sem mudar o estado.
export function isBlockedFailureAck(
  current: MessageState,
  incoming: 'sent' | 'delivered' | 'read' | 'failed',
): boolean {
  if (incoming !== 'failed' || current === 'failed') return false
  return RANK[current] >= RANK.delivered
}
