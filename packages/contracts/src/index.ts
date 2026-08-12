// ATENÇÃO: sem sufixo `.js` nos specifiers relativos — diferente da convenção do resto do
// monorepo (packages/db, apps/api, packages/providers usam `.js` -> `.ts`, padrão ESM+TS
// com moduleResolution "Bundler"). Este pacote é o único hoje consumido por um bundler de
// verdade (apps/web, Next.js/Turbopack, Task 7 do Plano C): o Turbopack falha ao resolver
// `export * from './webhooks.js'` contra o `webhooks.ts` irmão dentro de um workspace
// package transpilado (`transpilePackages` em apps/web/next.config.ts) — funciona só sem o
// sufixo. tsx (apps/api) e vitest (testes deste pacote) resolvem os dois formatos sem
// diferença, então a mudança aqui é segura para os demais consumidores.
export * from './webhooks'
export * from './events'
export * from './api'
