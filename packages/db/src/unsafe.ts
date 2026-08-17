// USO RESTRITO: seed, testes e resolução de auth (pré-tenant). Nunca em código de domínio.
import { PrismaClient, type Prisma } from '@prisma/client'

export const prismaUnsafe = new PrismaClient()

// Reexporta o tipo de entrada Json do Prisma — permite a scripts fora de packages/db
// (ex.: scripts/copy-live-db.ts) fazer cast seguro ao reescrever um valor Json LIDO
// (JsonValue, que inclui `null` como literal JSON válido) de volta como entrada de
// escrita (InputJsonValue) em outra tabela, sem precisar do specifier literal
// '@prisma/client' (bloqueado fora daqui pelo ESLint, ADR-0001).
export type PrismaJsonInput = Prisma.InputJsonValue

// Fábrica com datasource explícito — uso EXCLUSIVO de scripts operacionais de instância
// única que precisam de MAIS DE UM client Prisma simultâneo apontando para bancos
// diferentes (ex.: scripts/copy-live-db.ts, T3 do Plano C: origem e destino do cutover).
// Scripts fora de packages/db importam esta função por caminho relativo (mesma
// convenção de scripts/harvest-fixtures.ts) — o guard de ESLint bloqueia o specifier
// literal '@prisma/client' fora daqui, não o caminho relativo até este arquivo.
export function createUnsafeClient(datasourceUrl: string): PrismaClient {
  return new PrismaClient({ datasources: { db: { url: datasourceUrl } } })
}
