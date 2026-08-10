import { describe, expect, it } from 'vitest'
import { encryptJson } from '@aios-pocket/db'
import { config } from '../src/config.js'
import { providerForCompany } from '../src/provider-factory.js'

// Teste direto do provider-factory (achado IMPORTANT da re-review T11: send-flow.test.ts
// só exercita a versão MOCKADA — este arquivo prova o comportamento REAL, sem mocks).
const validCredentials = encryptJson(
  {
    evolution: { baseUrl: 'https://evolution.exemplo.invalido', apiKey: 'chave-fake', instanceId: 'instancia-fake' },
    zapi: { baseUrl: 'https://zapi.exemplo.invalido', instanceId: 'x', instanceToken: 'y', clientToken: 'z' },
  },
  config.APP_ENCRYPTION_KEY,
)

describe('providerForCompany (único ponto que liga db⇄providers — ADR-0002)', () => {
  it('activeProvider evolution: decifra de verdade e devolve um MessagingProvider (não chama sendText)', () => {
    const provider = providerForCompany({ activeProvider: 'evolution', providerCredentials: validCredentials })
    expect(typeof provider.sendText).toBe('function')
    expect(typeof provider.sendMedia).toBe('function')
    expect(typeof provider.getConnectionStatus).toBe('function')
  })

  it('activeProvider zapi: lança "Plano D" (ainda não implementado)', () => {
    expect(() =>
      providerForCompany({ activeProvider: 'zapi', providerCredentials: validCredentials }),
    ).toThrow('ZApiProvider: Plano D')
  })

  it('activeProvider desconhecido: lança com o valor recebido na mensagem', () => {
    expect(() =>
      providerForCompany({ activeProvider: 'carrier-pigeon', providerCredentials: validCredentials }),
    ).toThrow(/carrier-pigeon/)
  })

  it('credenciais corrompidas: erro claro em vez do erro opaco de decrypt/JSON (fold da re-review T11)', () => {
    expect(() =>
      providerForCompany({ activeProvider: 'evolution', providerCredentials: 'isto-nao-e-base64-cifrado-valido' }),
    ).toThrow('credenciais da company não puderam ser decifradas')
  })
})
