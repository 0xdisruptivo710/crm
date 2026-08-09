import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

// AES-256-GCM: payload = base64(iv[12] + authTag[16] + ciphertext)
export function encryptJson(value: unknown, keyB64: string): string {
  const key = Buffer.from(keyB64, 'base64')
  if (key.length !== 32) {
    throw new Error('APP_ENCRYPTION_KEY inválida: esperados 32 bytes em base64')
  }
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64')
}

export function decryptJson<T>(payload: string, keyB64: string): T {
  const key = Buffer.from(keyB64, 'base64')
  if (key.length !== 32) {
    throw new Error('APP_ENCRYPTION_KEY inválida: esperados 32 bytes em base64')
  }
  const raw = Buffer.from(payload, 'base64')
  const iv = raw.subarray(0, 12)
  const authTag = raw.subarray(12, 28)
  const ciphertext = raw.subarray(28)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(authTag)
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return JSON.parse(plain.toString('utf8')) as T
}
