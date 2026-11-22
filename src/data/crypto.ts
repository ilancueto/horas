import { z } from 'zod'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const base64 = (bytes: Uint8Array) =>
  btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))
const unbase64 = (value: string) => Uint8Array.from(atob(value), (letter) => letter.charCodeAt(0))
const envelopeSchema = z.object({ iv: z.string().length(16), ciphertext: z.string().min(24) })
export const encryptionSchema = z.object({ salt: z.string().length(24), check: envelopeSchema })
export type Encryption = z.infer<typeof encryptionSchema>
async function derive(phrase: string, salt: string) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(phrase), 'PBKDF2', false, [
    'deriveKey',
  ])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: unbase64(salt), iterations: 600000 },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
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
export async function unlockEncryption(phrase: string, config: Encryption) {
  const key = await derive(phrase, config.salt)
  if ((await unseal(key, config.check, 'horas-profile')) !== 'horas-v1')
    throw new Error('Invalid phrase')
  return key
}
