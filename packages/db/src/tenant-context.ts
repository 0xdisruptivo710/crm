import { AsyncLocalStorage } from 'node:async_hooks'

export interface TenantContext {
  companyId: string
}

const storage = new AsyncLocalStorage<TenantContext>()

// Detecta thenables (inclui PrismaPromise, que é um thenable "preguiçoso":
// só dispara a query de verdade no primeiro .then()).
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function'
}

// Tipo de retorno honesto (polimento do carry-over): quando `fn` devolve um thenable,
// runWithTenant devolve a Promise MATERIALIZADA (Promise.resolve abaixo), não o thenable
// original — um PrismaPromise que entra sai como Promise comum. O cast interno vira
// declaração explícita em vez de mentira silenciosa de `as T`.
type Resolved<T> = T extends PromiseLike<infer U> ? Promise<U> : T

export function runWithTenant<T>(ctx: TenantContext, fn: () => T): Resolved<T> {
  return storage.run(ctx, () => {
    const result = fn()
    // Ajuste vs. o pseudocódigo do brief: se `fn` devolve um thenable (ex.: PrismaPromise),
    // é preciso "materializá-lo" com Promise.resolve() ainda dentro da janela síncrona do
    // storage.run — o PrismaPromise só executa a query no primeiro .then(), e se isso
    // acontecer fora do run() (ex.: no `await` do chamador) o AsyncLocalStorage já perdeu
    // o contexto e getTenant() lança "TenantContext ausente" mesmo com companyId presente.
    // Promise.resolve(thenable) agenda a leitura do .then() como microtask criada ainda
    // aqui dentro, o que preserva o contexto (verificado empiricamente com Node 24).
    return (isThenable(result) ? Promise.resolve(result) : result) as Resolved<T>
  })
}

export function getTenant(): TenantContext {
  const ctx = storage.getStore()
  if (!ctx) throw new Error('TenantContext ausente — toda operação de dados exige tenant (ADR-0001)')
  return ctx
}
