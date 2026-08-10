import { customersRepo, phoneMatchCandidates, type CanonicalPhone } from '@aios-pocket/db'
import { isUniqueConstraintError } from './prisma-errors.js'

// Resolve o Customer dono do telefone JÁ CANONICALIZADO de uma IncomingMessage; cria se
// nenhuma candidata bater (Domain.md: "Customer é resolvido/criado na chegada de qualquer
// mensagem"). Assume-se chamado de dentro de um runWithTenant (process-webhook.ts).
//
// O parse do telefone (canonicalizePhone, que PODE lançar para JID inválido) é
// responsabilidade do CHAMADOR, não deste módulo — achado IMPORTANT da revisão T10 round
// 2: um catch aqui dentro capturava TAMBÉM erros de banco (pool esgotado, TenantContext
// ausente, etc.) e os confundia com "telefone inválido", descartando uma mensagem real em
// silêncio. Este módulo só faz I/O — qualquer erro dele deve propagar para o BullMQ tentar
// de novo, nunca virar "ignorado".
export async function resolveCustomer(canonical: CanonicalPhone) {
  const candidates = phoneMatchCandidates(canonical.e164)
  const existing = await customersRepo.findByPhoneCandidates(candidates)
  if (existing) return existing

  try {
    return await customersRepo.create({ phoneE164: canonical.e164, phoneOriginal: canonical.original })
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err
    // Corrida legítima: outra chamada concorrente (ex.: dois webhooks quase simultâneos do
    // mesmo cliente, ou um retry paralelo) criou o MESMO Customer entre o
    // findByPhoneCandidates e este create (unique [companyId, phoneE164]) — quem venceu a
    // corrida "ganhou"; relê e continua com ELE em vez de propagar o erro.
    const winner = await customersRepo.findByPhoneCandidates(candidates)
    if (!winner) throw err // não deveria acontecer: é exatamente essa unique que disparou o P2002
    return winner
  }
}
