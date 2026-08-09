// Identidade canônica de telefone (Domain.md): E.164 + original preservado.
// Regra do 9º dígito BR: móveis têm 9 dígitos (9XXXXXXXX); o mesmo cliente pode
// chegar com ou sem o 9 dependendo do provider/época — matching considera os dois.

export interface CanonicalPhone {
  e164: string
  original: string
}

export function canonicalizePhone(raw: string): CanonicalPhone {
  // Rejeita JID de grupo/lid ANTES de processar
  if (/@(g\.us|lid)$/i.test(raw)) {
    throw new Error(`telefone inválido (identificador de grupo/lid): "${raw}"`)
  }
  // Strip de sufixos conhecidos (@s.whatsapp.net, @c.us) e remove tudo que não é dígito
  // @g.us e @lid já foram rejeitados acima; qualquer outro sufixo @ é dropado
  const digits = raw.replace(/@.*$/, '').replace(/\D/g, '')
  if (digits.length < 8 || digits.length > 15) {
    throw new Error(`telefone inválido: "${raw}"`)
  }
  return { e164: `+${digits}`, original: raw }
}

export function phoneMatchCandidates(e164: string): string[] {
  const br = /^\+55(\d{2})(\d{8,9})$/.exec(e164)
  if (!br) return [e164]
  const [, ddd, local] = br
  if (local !== undefined && local.length === 9 && local.startsWith('9')) {
    return [e164, `+55${ddd}${local.slice(1)}`] // com 9 → alternativo sem 9
  }
  if (local !== undefined && local.length === 8 && /^[6-9]/.test(local)) {
    return [e164, `+55${ddd}9${local}`] // móvel antigo sem 9 → alternativo com 9
  }
  return [e164] // fixo
}
