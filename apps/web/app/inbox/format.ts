// Helpers de formatação compartilhados pelos componentes do Inbox — evita duplicar a
// mesma lógica de "nome ou telefone" / hora local em cada componente (CLAUDE.md §4:
// "nunca duplicar lógica entre módulos").

export function displayName(customer: { name: string | null; phoneE164: string }): string {
  return customer.name ?? customer.phoneE164
}

export function formatTime(date: Date | null): string {
  if (!date) return ""
  return new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(date)
}
