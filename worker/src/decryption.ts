import { z } from 'zod'
import {
  encryptionSchema,
  importMigrationKey,
  InvalidEncryptionKey,
  unseal,
} from '../../src/data/crypto'
import { empty, json } from './http'
import type { Env } from './index'
import { byteLength, MAX_RECORD } from './push'

const requestSchema = z.object({
  decryptionKey: z
    .string()
    .length(44)
    .regex(/^[A-Za-z0-9+/]{43}=$/),
})
const recordSchema = z.looseObject({ id: z.string() })

type EncryptedRecord = { id: string; collection: string; revision: string; data: string }

export async function disableEncryption(env: Env, body: unknown): Promise<Response> {
  const request = requestSchema.safeParse(body)
  if (!request.success) return json({ error: 'Invalid decryption key' }, 400)

  const profile = await env.DB.prepare('select encryption from profile where id = 1').first<{
    encryption: string | null
  }>()
  if (!profile?.encryption) return empty()

  const config = encryptionSchema.parse(JSON.parse(profile.encryption))
  let key: CryptoKey
  try {
    key = await importMigrationKey(request.data.decryptionKey, config)
  } catch (error) {
    if (!(error instanceof InvalidEncryptionKey))
      return json({ error: 'Could not verify key' }, 500)
    return json({ error: 'Invalid decryption key' }, 422)
  }

  const { results } = await env.DB.prepare(
    'select id, collection, revision, data from records where deleted_at is null',
  ).all<EncryptedRecord>()
  const plaintext = await Promise.all(
    results.map(async ({ id, collection, revision, data }) => {
      try {
        const context = [collection, id, revision].join('|')
        const record = recordSchema.parse(await unseal(key, JSON.parse(data), context))
        const payload = JSON.stringify(record)
        return record.id === id && byteLength(payload) <= MAX_RECORD ? payload : null
      } catch {
        return null
      }
    }),
  )
  if (plaintext.some((payload) => payload === null)) {
    return json({ error: 'Could not decrypt all records' }, 409)
  }

  // Un push concurrente debe revertir la conversión completa, incluido el cambio de perfil.
  const versions = JSON.stringify(results.map(({ id, revision }) => [id, revision]))
  const guard = env.DB.prepare(
    `insert into profile(id) select 0
     where (select encryption from profile where id = 1) is not ?1
        or (select count(*) from records where deleted_at is null) <> ?2
        or (select count(*) from records r join json_each(?3) v
              on r.id = (v.value ->> 0) and r.revision = (v.value ->> 1)
              where r.deleted_at is null) <> ?2`,
  ).bind(profile.encryption, results.length, versions)

  const update = env.DB.prepare(
    'update records set data = ? where id = ? and revision = ? and deleted_at is null',
  )
  await env.DB.batch([
    guard,
    ...results.map(({ id, revision }, index) => update.bind(plaintext[index], id, revision)),
    env.DB.prepare('update profile set encryption = null where id = 1'),
  ])
  return empty()
}
