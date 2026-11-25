import { z } from 'zod'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const base64 = (bytes: Uint8Array) =>
  btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))
const unbase64 = (value: string) => Uint8Array.from(atob(value), (letter) => letter.charCodeAt(0))
const envelopeSchema = z.object({ iv: z.string().length(16), ciphertext: z.string().min(24) })
export const encryptionSchema = z.object({ salt: z.string().length(24), check: envelopeSchema })
export type Encryption = z.infer<typeof encryptionSchema>
async function derive(phrase: string, salt: string, extractable = false) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(phrase), 'PBKDF2', false, [
    'deriveKey',
  ])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: unbase64(salt), iterations: 600000 },
    material,
    { name: 'AES-GCM', length: 256 },
    extractable,
    ['encrypt', 'decrypt'],
  )
}
export async function seal(key: CryptoKey, data: unknown, context: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const bytes = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(context) },
    key,
    encoder.encode(JSON.stringify(data)),
  )
  return { iv: base64(iv), ciphertext: base64(new Uint8Array(bytes)) }
}
export async function unseal(key: CryptoKey, raw: unknown, context: string): Promise<unknown> {
  const data = envelopeSchema.parse(raw)
  const bytes = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unbase64(data.iv), additionalData: encoder.encode(context) },
    key,
    unbase64(data.ciphertext),
  )
  return JSON.parse(decoder.decode(bytes))
}
export async function createEncryption(phrase: string) {
  const salt = base64(crypto.getRandomValues(new Uint8Array(16)))
  const key = await derive(phrase, salt)
  const config = { salt, check: await seal(key, 'horas-v1', 'horas-profile') }
  return { key, config }
}
export class InvalidEncryptionKey extends Error {}

async function verifyKey(key: CryptoKey, config: Encryption) {
  let check: unknown
  try {
    check = await unseal(key, config.check, 'horas-profile')
  } catch (error) {
    if (error instanceof DOMException && error.name === 'OperationError') {
      throw new InvalidEncryptionKey('Invalid encryption key')
    }
    throw error
  }
  if (check !== 'horas-v1') throw new InvalidEncryptionKey('Invalid encryption key')
  return key
}

export async function unlockEncryption(phrase: string, config: Encryption) {
  return verifyKey(await derive(phrase, config.salt), config)
}

export async function exportMigrationKey(phrase: string, config: Encryption) {
  const key = await verifyKey(await derive(phrase, config.salt, true), config)
  const raw = await crypto.subtle.exportKey('raw', key)
  if (!(raw instanceof ArrayBuffer)) throw new Error('Could not export decryption key')
  return base64(new Uint8Array(raw))
}

export async function importMigrationKey(encoded: string, config: Encryption) {
  const raw = unbase64(encoded)
  if (raw.length !== 32) throw new InvalidEncryptionKey('Invalid encryption key')
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt'])
  return verifyKey(key, config)
}
