import { decryptJson } from '@aios-pocket/db'
import { createEvolutionProvider, type EvolutionConfig, type MessagingProvider } from '@aios-pocket/providers'
import { config } from './config.js'

// Shape das credenciais cifradas gravadas em Company.providerCredentials (o mesmo shape
// que packages/db/prisma/seed.ts cifra com encryptJson): carrega AMBOS os providers
// possíveis — só `activeProvider` decide qual é usado em runtime.
interface ZApiCredentials {
  baseUrl: string
  instanceId: string
  instanceToken: string
  clientToken: string
}

interface DecryptedCredentials {
  evolution: EvolutionConfig
  zapi: ZApiCredentials
}

// Shape mínimo da Company necessário aqui — evita importar o tipo gerado pelo Prisma
// (proibido fora de packages/db, ADR-0001/ESLint). Quem chama passa a Company inteira
// (que satisfaz este shape estruturalmente) ou um subconjunto equivalente.
export interface CompanyForProvider {
  activeProvider: string
  providerCredentials: string
}

// ÚNICO ponto que liga db⇄providers (ADR-0002): decifra as credenciais da company com
// APP_ENCRYPTION_KEY e devolve a implementação de MessagingProvider correta para o
// provider ativo do tenant. Nenhum outro módulo de negócio deve saber decifrar
// credenciais ou instanciar um provider diretamente.
export function providerForCompany(company: CompanyForProvider): MessagingProvider {
  const credentials = decryptJson<DecryptedCredentials>(company.providerCredentials, config.APP_ENCRYPTION_KEY)

  if (company.activeProvider === 'evolution') {
    return createEvolutionProvider(credentials.evolution)
  }
  if (company.activeProvider === 'zapi') {
    // Z-API é Plano D (ADR-0002 — "Não existe WTSProvider... só Evolution e Z-API", mas
    // Z-API ainda não tem implementação de envio nesta fatia).
    throw new Error('ZApiProvider: Plano D')
  }
  throw new Error(`providerForCompany: provider desconhecido "${company.activeProvider}"`)
}
