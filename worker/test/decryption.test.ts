import { expect, it } from 'vitest'
import { createEncryption, exportMigrationKey, seal } from '../../src/data/crypto'
import { setup } from './helpers'

const phrase = 'frase de paso de prueba'
const id = '00000000-0000-4000-8000-000000000001'
const revision = '00000000-0000-4000-8000-000000000002'
const deletedId = '00000000-0000-4000-8000-000000000003'
const deletedRevision = '00000000-0000-4000-8000-000000000004'
const data = { id, notes: 'Jornada existente' }

it('retira el cifrado con la frase correcta y conserva las revisiones y los borrados', async () => {
  const { env, call } = await setup()
  const { key, config } = await createEncryption(phrase)
  await env.DB.prepare('insert into profile(id, encryption) values (1, ?)')
    .bind(JSON.stringify(config))
    .run()
  const encrypted = await seal(key, data, ['entries', id, revision].join('|'))
  const pushed = await call('POST', '/v1/push', {
    body: {
      encrypted: true,
      changes: [
        { id, revision, collection: 'entries', deleted: false, data: encrypted },
        {
          id: deletedId,
          revision: deletedRevision,
          collection: 'entries',
          deleted: true,
          data: null,
        },
      ],
    },
  })
  expect(pushed.status).toBe(204)

  const decryptionKey = await exportMigrationKey(phrase, config)
  const wrongKey = Buffer.alloc(32).toString('base64')
  const before = await (await call('GET', '/v1/records')).json()
  expect((await call('POST', '/v1/decryption', { body: { decryptionKey: wrongKey } })).status).toBe(
    422,
  )
  expect(await (await call('GET', '/v1/records')).json()).toEqual(before)
  expect((await call('POST', '/v1/decryption', { body: { decryptionKey } })).status).toBe(204)
  expect(await (await call('GET', '/v1/profile')).json()).toEqual({ encryption: null })
  expect(await (await call('GET', '/v1/records')).json()).toEqual({
    rows: [
      expect.objectContaining({ id, revision, data }),
      expect.objectContaining({
        id: deletedId,
        revision: deletedRevision,
        data: null,
        deleted_at: expect.any(String),
      }),
    ],
  })
  expect((await call('POST', '/v1/decryption', { body: { decryptionKey } })).status).toBe(204)
})
