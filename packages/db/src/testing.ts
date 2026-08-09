// USO EXCLUSIVO EM TESTES — nunca importar em código de produção.
//
// Reexporta `prismaUnsafe` (client Prisma sem TenantContext) através de um subpath
// dedicado (`@aios-pocket/db/testing`) para que testes de outros pacotes (ex.: apps/api)
// possam montar fixtures diretamente no banco sem passar pelo fluxo de auth/tenant —
// coisa que o resto do código nunca pode fazer (ADR-0001). O guard de ESLint em
// eslint.config.js restringe esse import a arquivos de teste.
export { prismaUnsafe } from './unsafe.js'
