import { canonicalizePhone, customersRepo, phoneMatchCandidates } from '@aios-pocket/db'

// Resolve o Customer dono do telefone de uma IncomingMessage; cria se nenhuma candidata
// bater (Domain.md: "Customer é resolvido/criado na chegada de qualquer mensagem").
// Assume-se chamado de dentro de um runWithTenant (process-webhook.ts) — customersRepo
// usa o TenantContext para o create.
export async function resolveCustomer(phone: string) {
  const canonical = canonicalizePhone(phone)
  const candidates = phoneMatchCandidates(canonical.e164)
  const existing = await customersRepo.findByPhoneCandidates(candidates)
  if (existing) return existing
  return customersRepo.create({ phoneE164: canonical.e164, phoneOriginal: canonical.original })
}
