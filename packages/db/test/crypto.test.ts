import { describe, expect, it } from 'vitest'
import { encryptJson, decryptJson } from '../src/crypto.js'

const KEY = 'CTsyIGgQZbdhAtVZDdWLmeYUFrsGxJCVyBqNbGVw5CE=' // 32 bytes base64, só para teste

describe('cifra de credenciais (AES-256-GCM)', () => {
  it('roundtrip preserva o objeto', () => {
    const original = { evolution: { apiKey: 'segredo-123' } }
    const cifrado = encryptJson(original, KEY)
    expect(cifrado).not.toContain('segredo-123')
    expect(decryptJson(cifrado, KEY)).toEqual(original)
  })

  it('payload adulterado falha', () => {
    const cifrado = encryptJson({ a: 1 }, KEY)
    const adulterado = cifrado.slice(0, -4) + 'AAAA'
    expect(() => decryptJson(adulterado, KEY)).toThrow()
  })

  it('chave de tamanho errado falha com erro claro', () => {
    expect(() => encryptJson({ a: 1 }, 'Y3VydGE=')).toThrow('32 bytes')
    expect(() => decryptJson('AAAA', 'Y3VydGE=')).toThrow('32 bytes')
  })
})
