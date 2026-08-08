// USO RESTRITO: seed, testes e resolução de auth (pré-tenant). Nunca em código de domínio.
import { PrismaClient } from '@prisma/client'

export const prismaUnsafe = new PrismaClient()
