import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { handle, type Env } from '../src/index'
import { MAX_RECORD, push } from '../src/push'
import { ALLOWED_ORIGIN, SYNC_KEY, setup } from './helpers'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const rev = (n: number) => `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`

type Row = {
  id: string
  collection: string
  data: unknown
  revision: string
  updated_at: string
  deleted_at: string | null
}

const timestamp = z.iso.datetime({ offset: true })

function change(n: number, revision: number, extra: Record<string, unknown> = {}) {
  return {
    id: id(n),
    collection: 'entries',
    revision: rev(revision),
    deleted: false,
    data: { n },
    ...extra,
  }
}

async function rows(call: Awaited<ReturnType<typeof setup>>['call']): Promise<Row[]> {
  const response = await call('GET', '/v1/records')
  return ((await response.json()) as { rows: Row[] }).rows
}

async function count(env: Env, table: string): Promise<number> {
  const row = await env.DB.prepare(`select count(*) as n from ${table}`).first<{ n: number }>()
  return row?.n ?? 0
}

async function expectEmpty(env: Env) {
  expect(await count(env, 'records')).toBe(0)
  expect(await count(env, 'mutations')).toBe(0)
  expect(await count(env, 'profile')).toBe(0)
}

async function encryptProfile(env: Env) {
  await env.DB.prepare('insert into profile(id, encryption) values (1, ?)')
    .bind(JSON.stringify({ salt: 's', check: { iv: 'i', ciphertext: 'c' } }))
    .run()
}

/** Ejecuta `before` justo antes de la `batch` de escritura, simulando un pedido concurrente. */
function beforeBatch(env: Env, before: () => Promise<unknown>): Env {
  const DB = new Proxy(env.DB, {
    get: (target, prop) => {
      const value = Reflect.get(target, prop) as unknown
      if (prop === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          await before()
          return target.batch(statements)
        }
      }
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return { ...env, DB }
}

describe('POST /v1/push', () => {
  it('guarda un cambio nuevo y lo devuelve con updated_at válido', async () => {
    const { env, call } = await setup()
    const response = await call('POST', '/v1/push', {
      body: { changes: [change(1, 1)], encrypted: false },
    })
    expect(response.status).toBe(204)
    const [row] = await rows(call)
    expect(row).toMatchObject({
      id: id(1),
      collection: 'entries',
      data: { n: 1 },
      revision: rev(1),
      deleted_at: null,
    })
    expect(timestamp.safeParse(row.updated_at).success).toBe(true)
    expect(row.updated_at).toMatch(/\.\d{6}Z$/)
    expect(await count(env, 'mutations')).toBe(1)
    expect(await count(env, 'profile')).toBe(1)
  })

  it('ignora un lote repetido con la misma revisión', async () => {
    const { call } = await setup()
    const body = { changes: [change(1, 1)], encrypted: false }
    expect((await call('POST', '/v1/push', { body })).status).toBe(204)
    const before = await rows(call)
    expect((await call('POST', '/v1/push', { body })).status).toBe(204)
    expect(await rows(call)).toEqual(before)
  })

  it('updated_at crece aunque el reloj vaya hacia atrás', async () => {
    const { env, call } = await setup()
    await push(
      env,
      { changes: [change(1, 1)], encrypted: false },
      () => new Date('2026-11-23T12:00:00.000Z'),
    )
    const [first] = await rows(call)
    expect(first.updated_at).toBe('2026-11-23T12:00:00.000000Z')
    const response = await push(
      env,
      { changes: [change(1, 2, { data: { n: 2 } })], encrypted: false },
      () => new Date('2020-01-01T00:00:00.000Z'),
    )
    expect(response.status).toBe(204)
    const [second] = await rows(call)
    expect(second.revision).toBe(rev(2))
    expect(second.data).toEqual({ n: 2 })
    expect(second.updated_at).toBe('2026-11-23T12:00:00.000001Z')
    expect(second.updated_at > first.updated_at).toBe(true)
  })

  it('encadena updated_at para dos cambios del mismo id en un lote', async () => {
    const { env, call } = await setup()
    const now = () => new Date('2026-11-23T12:00:00.000Z')
    const response = await push(
      env,
      { changes: [change(1, 1), change(1, 2, { data: { n: 2 } })], encrypted: false },
      now,
    )
    expect(response.status).toBe(204)
    const all = await rows(call)
    expect(all).toHaveLength(1)
    expect(all[0].revision).toBe(rev(2))
    expect(all[0].data).toEqual({ n: 2 })
    expect(all[0].updated_at).toBe('2026-11-23T12:00:00.000001Z')
    expect(await count(env, 'mutations')).toBe(2)
  })

  it('ignora una revisión repetida dentro del mismo lote', async () => {
    const { call } = await setup()
    const response = await call('POST', '/v1/push', {
      body: { changes: [change(1, 1), change(1, 1, { data: { n: 9 } })], encrypted: false },
    })
    expect(response.status).toBe(204)
    expect((await rows(call))[0].data).toEqual({ n: 1 })
  })

  it('borra con data null y deleted_at = updated_at; ignora una revisión vieja reenviada', async () => {
    const { call } = await setup()
    await call('POST', '/v1/push', { body: { changes: [change(1, 1)], encrypted: false } })
    const deletion = await call('POST', '/v1/push', {
      body: { changes: [change(1, 2, { deleted: true, data: { n: 1 } })], encrypted: false },
    })
    expect(deletion.status).toBe(204)
    const [deleted] = await rows(call)
    expect(deleted.data).toBeNull()
    expect(deleted.deleted_at).toBe(deleted.updated_at)
    expect(deleted.revision).toBe(rev(2))

    const replay = await call('POST', '/v1/push', {
      body: { changes: [change(1, 1)], encrypted: false },
    })
    expect(replay.status).toBe(204)
    expect(await rows(call)).toEqual([deleted])
  })

  it('rechaza un lote de 101 sin escribir', async () => {
    const { env, call } = await setup()
    const changes = Array.from({ length: 101 }, (_, i) => change(i, i))
    expect((await call('POST', '/v1/push', { body: { changes, encrypted: false } })).status).toBe(
      400,
    )
    await expectEmpty(env)
  })

  it('acepta un lote de 100', async () => {
    const { env, call } = await setup()
    const changes = Array.from({ length: 100 }, (_, i) => change(i, i))
    expect((await call('POST', '/v1/push', { body: { changes, encrypted: false } })).status).toBe(
      204,
    )
    expect(await count(env, 'records')).toBe(100)
  })

  it('atómico: no escribe nada si el último cambio tiene una colección desconocida', async () => {
    const { env, call } = await setup()
    const changes = [change(1, 1), change(2, 2), change(3, 3, { collection: 'otra' })]
    const response = await call('POST', '/v1/push', { body: { changes, encrypted: false } })
    expect(response.status).toBe(400)
    await expectEmpty(env)
  })

  it('rechaza data que no es objeto', async () => {
    const { env, call } = await setup()
    for (const data of [null, 'texto', 3, [1, 2]]) {
      const response = await call('POST', '/v1/push', {
        body: { changes: [change(1, 1, { data })], encrypted: false },
      })
      expect(response.status).toBe(400)
    }
    await expectEmpty(env)
  })

  it('rechaza ids, revisiones o cuerpos inválidos', async () => {
    const { env, call } = await setup()
    const bad = [
      { changes: [change(1, 1, { id: 'no-uuid' })], encrypted: false },
      { changes: [change(1, 1, { revision: 'no-uuid' })], encrypted: false },
      { changes: [change(1, 1, { deleted: 'no' })], encrypted: false },
      { changes: [change(1, 1)] },
      { changes: 'x', encrypted: false },
    ]
    for (const body of bad) {
      expect((await call('POST', '/v1/push', { body })).status).toBe(400)
    }
    const raw = await handle(
      new Request('https://sync.test/v1/push', {
        method: 'POST',
        headers: { authorization: `Bearer ${SYNC_KEY}`, 'content-type': 'application/json' },
        body: '{no es json',
      }),
      env,
    )
    expect(raw.status).toBe(400)
    await expectEmpty(env)
  })

  it('escribe todo en una sola batch', async () => {
    const { env, call } = await setup()
    const calls: string[] = []
    const DB = new Proxy(env.DB, {
      get: (target, prop) => {
        const value = Reflect.get(target, prop) as unknown
        if (prop === 'batch' || prop === 'exec') {
          return (...args: unknown[]) => {
            calls.push(prop)
            return (value as (...a: unknown[]) => unknown).apply(target, args)
          }
        }
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const response = await push(
      { ...env, DB },
      {
        changes: [change(1, 1), change(2, 2), change(1, 3, { deleted: true, data: null })],
        encrypted: false,
      },
    )
    expect(response.status).toBe(204)
    expect(calls.filter((name) => name === 'batch')).toHaveLength(1)
    expect(calls).not.toContain('exec')
    expect(await rows(call)).toHaveLength(2)
  })

  it('rechaza un registro de más de 1 MB', async () => {
    const { env, call } = await setup()
    const big = { s: 'x'.repeat(MAX_RECORD) }
    const response = await call('POST', '/v1/push', {
      body: { changes: [change(1, 1), change(2, 2, { data: big })], encrypted: false },
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Invalid record' })
    await expectEmpty(env)
  })

  it('normaliza id y revisión a minúsculas', async () => {
    const { env, call } = await setup()
    const upper = change(10, 10, {
      id: 'ABCDEF00-0000-4000-8000-0000000000AA',
      revision: 'ABCDEF00-0000-4000-9000-0000000000BB',
    })
    expect(
      (await call('POST', '/v1/push', { body: { changes: [upper], encrypted: false } })).status,
    ).toBe(204)
    const [row] = await rows(call)
    expect(row.id).toBe('abcdef00-0000-4000-8000-0000000000aa')
    expect(row.revision).toBe('abcdef00-0000-4000-9000-0000000000bb')
    const lower = change(10, 10, {
      id: 'abcdef00-0000-4000-8000-0000000000aa',
      revision: 'abcdef00-0000-4000-9000-0000000000bb',
      data: { n: 99 },
    })
    await call('POST', '/v1/push', { body: { changes: [lower], encrypted: false } })
    expect(await rows(call)).toEqual([row])
    expect(await count(env, 'mutations')).toBe(1)
  })

  describe('concurrencia entre la lectura y la batch', () => {
    it('un push concurrente más nuevo no se pisa y updated_at no retrocede', async () => {
      const { env, call } = await setup()
      const at = (s: number) => () => new Date(`2026-11-23T12:00:0${s}.000Z`)
      await push(env, { changes: [change(1, 1)], encrypted: false }, at(0))
      const competing = beforeBatch(env, async () => {
        const response = await push(
          env,
          { changes: [change(1, 3, { data: { n: 3 } })], encrypted: false },
          at(5),
        )
        expect(response.status).toBe(204)
      })
      const response = await push(
        competing,
        { changes: [change(1, 2, { data: { n: 2 } })], encrypted: false },
        at(1),
      )
      expect(response.status).toBe(204)
      const [row] = await rows(call)
      expect(row.revision).toBe(rev(3))
      expect(row.data).toEqual({ n: 3 })
      expect(row.updated_at).toBe('2026-11-23T12:00:05.000000Z')
    })

    it('si el cifrado se activa en el medio, revierte todo y el reintento recibe 409', async () => {
      const { env, call } = await setup()
      const racing = beforeBatch(env, () => encryptProfile(env))
      await expect(
        push(racing, { changes: [change(1, 1), change(2, 2)], encrypted: false }),
      ).rejects.toThrow()
      expect(await count(env, 'records')).toBe(0)
      expect(await count(env, 'mutations')).toBe(0)
      const retry = await call('POST', '/v1/push', {
        body: { changes: [change(1, 1), change(2, 2)], encrypted: false },
      })
      expect(retry.status).toBe(409)
      expect(await count(env, 'records')).toBe(0)
    })

    it('la misma revisión en carrera revierte la batch entera y el reintento da 204', async () => {
      const { env, call } = await setup()
      const racing = beforeBatch(env, async () => {
        await env.DB.prepare('insert into mutations(revision) values (?)').bind(rev(1)).run()
      })
      // La fila de id 2 se escribe antes de la mutación repetida: prueba el rollback a mitad de batch.
      const body = { changes: [change(2, 2), change(1, 1)], encrypted: false }
      await expect(push(racing, body)).rejects.toThrow()
      expect(await count(env, 'records')).toBe(0)
      expect(await count(env, 'mutations')).toBe(1)
      expect(await count(env, 'profile')).toBe(0)
      const retry = await call('POST', '/v1/push', { body })
      expect(retry.status).toBe(204)
      const all = await rows(call)
      expect(all.map((row) => row.id)).toEqual([id(2)])
      expect(await count(env, 'mutations')).toBe(2)
    })
  })

  describe('modo cifrado', () => {
    const sealed = { iv: 'aaaaaaaaaaaaaaaa', ciphertext: 'bbbbbbbbbbbbbbbbbbbbbbbb' }

    it('con perfil cifrado rechaza encrypted: false con 409', async () => {
      const { env, call } = await setup()
      await encryptProfile(env)
      const response = await call('POST', '/v1/push', {
        body: { changes: [change(1, 1)], encrypted: false },
      })
      expect(response.status).toBe(409)
      expect(await response.json()).toEqual({ error: 'Encryption mode changed' })
      expect(await count(env, 'records')).toBe(0)
      expect(await count(env, 'mutations')).toBe(0)
    })

    it('con perfil cifrado exige iv y ciphertext', async () => {
      const { env, call } = await setup()
      await encryptProfile(env)
      const missing = await call('POST', '/v1/push', {
        body: { changes: [change(1, 1, { data: { iv: 'aaaaaaaaaaaaaaaa' } })], encrypted: true },
      })
      expect(missing.status).toBe(400)
      expect(await count(env, 'records')).toBe(0)
      const ok = await call('POST', '/v1/push', {
        body: { changes: [change(1, 1, { data: sealed })], encrypted: true },
      })
      expect(ok.status).toBe(204)
      expect((await rows(call))[0].data).toEqual(sealed)
    })

    it('un borrado cifrado no necesita ciphertext', async () => {
      const { env, call } = await setup()
      await encryptProfile(env)
      const response = await call('POST', '/v1/push', {
        body: { changes: [change(1, 1, { deleted: true, data: null })], encrypted: true },
      })
      expect(response.status).toBe(204)
    })

    it('sin perfil rechaza encrypted: true con 409', async () => {
      const { env, call } = await setup()
      const response = await call('POST', '/v1/push', {
        body: { changes: [change(1, 1, { data: sealed })], encrypted: true },
      })
      expect(response.status).toBe(409)
      await expectEmpty(env)
    })
  })

  it('rechaza sin clave con 401', async () => {
    const { env, call } = await setup()
    const response = await call('POST', '/v1/push', {
      key: undefined,
      body: { changes: [change(1, 1)], encrypted: false },
    })
    expect(response.status).toBe(401)
    await expectEmpty(env)
  })
})

describe('encabezados y errores', () => {
  it('envía Vary: Origin también a orígenes no permitidos y sin origen', async () => {
    const { call } = await setup()
    for (const origin of [ALLOWED_ORIGIN, 'https://otro.example', undefined]) {
      const response = await call('GET', '/v1/profile', { origin })
      expect(response.headers.get('vary')).toContain('Origin')
    }
    const preflight = await call('OPTIONS', '/v1/push', {
      key: undefined,
      origin: 'https://otro.example',
    })
    expect(preflight.headers.get('vary')).toContain('Origin')
  })

  it('en un 500 registra solo el mensaje del error', async () => {
    const { env } = await setup()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const broken: Env = {
      ...env,
      DB: new Proxy(env.DB, {
        get: (target, prop, receiver) => {
          if (prop === 'prepare') throw new Error('fallo de base')
          return Reflect.get(target, prop, receiver) as unknown
        },
      }),
    }
    const response = await handle(
      new Request('https://sync.test/v1/profile', {
        headers: { authorization: `Bearer ${SYNC_KEY}` },
      }),
      broken,
    )
    expect(response.status).toBe(500)
    expect(error).toHaveBeenCalledTimes(1)
    const logged = error.mock.calls[0].map(String).join(' ')
    expect(logged).toContain('fallo de base')
    expect(logged).not.toContain(SYNC_KEY)
    expect(error.mock.calls[0].every((arg) => typeof arg === 'string')).toBe(true)
    error.mockRestore()
  })
})
