// Erro de unicidade do Postgres via Prisma (P2002) — checado por duck-typing para não
// importar @prisma/client fora de packages/db (ESLint proíbe, ADR-0001). Compartilhado
// entre process-webhook.ts e send-message.ts (achado IMPORTANT da re-review T11 — os dois
// precisam distinguir corridas de unicidade legítimas de erros reais; extraído para não
// duplicar a mesma checagem em dois arquivos do mesmo domínio, regra do CLAUDE.md §4).
export function isUniqueConstraintError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002'
}
