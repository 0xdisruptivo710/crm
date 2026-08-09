import { AsyncLocalStorage } from 'node:async_hooks'

export interface TenantContext {
  companyId: string
}

const storage = new AsyncLocalStorage<TenantContext>()

// Detecta thenables (inclui PrismaPromise, que é um thenable "preguiçoso":
// só dispara a query de verdade no primeiro .then()).
function isThenable(value: unknown): value is { then: unknown } {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function'
}

export function runWithTenant<T>(ctx: TenantContext, fn: () => T): T {
  return storage.run(ctx, () => {
    const result = fn()
    // Ajuste vs. o pseudocódigo do brief: se `fn` devolve um thenable (ex.: PrismaPromise),
    // é preciso "materializá-lo" com Promise.resolve() ainda dentro da janela síncrona do
    // storage.run — o PrismaPromise só executa a query no primeiro .then(), e se isso
    // acontecer fora do run() (ex.: no `await` do chamador) o AsyncLocalStorage já perdeu
    // o contexto e getTenant() lança "TenantContext ausente" mesmo com companyId presente.
    // Promise.resolve(thenable) agenda a leitura do .then() como microtask criada ainda
    // aqui dentro, o que preserva o contexto (verificado empiricamente com Node 24).
    return (isThenable(result) ? Promise.resolve(result) : result) as T
  })
}

// Para hooks do Fastify: fixa o contexto na execução assíncrona da request corrente.
//
// ATENÇÃO (footgun): diferente de runWithTenant, enterTenant NÃO tem escopo — ele fixa
// o contexto para TUDO que rodar depois, na mesma cadeia assíncrona, até o processo
// decidir trocar (ou até a request terminar, se usado corretamente). Use SOMENTE dentro
// de um hook por-request (ex.: preHandler/onRequest do Fastify, chamado uma vez no início
// de cada request). NUNCA chame em um recurso assíncrono compartilhado ou de vida longa
// (worker de fila reaproveitado entre jobs, conexão de socket persistente, singleton,
// listener global) — nesses casos o tenant de uma execução vaza para as próximas que
// reusam o mesmo recurso. Fora do hook por-request, prefira sempre runWithTenant, que
// delimita o contexto à própria chamada.
export function enterTenant(ctx: TenantContext): void {
  storage.enterWith(ctx)
}

export function getTenant(): TenantContext {
  const ctx = storage.getStore()
  if (!ctx) throw new Error('TenantContext ausente — toda operação de dados exige tenant (ADR-0001)')
  return ctx
}
