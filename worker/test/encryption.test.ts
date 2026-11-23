import { describe, expect, it, vi } from 'vitest'
import { MAX_CONFIG, enableEncryption } from '../src/encryption'
import { handle, type Env } from '../src/index'
import { push } from '../src/push'
import { setup } from './helpers'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const rev = (n: number) => `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`

const config = { salt: 'ssssssssssssssssssssssss', check: { iv: 'iiii', ciphertext: 'cccc' } }
const sealed = (n: number) => ({ iv: `iv-${n}`, ciphertext: `ct-${n}` })

type Row = {
  id: string
  data: Record<string, unknown> | null
  revision: string
  updated_at: string
  deleted_at: string | null
}

type Call = Awaited<ReturnType<typeof setup>>['call']

function plain(n: number, revision = n, extra: Record<string, unknown> = {}) {
  return {
    id: id(n),
    collection: 'entries',
    revision: rev(revision),
    deleted: false,
    data: { n },
    ...extra,
  }
}

function sealedChange(n: number, revision = n) {
  return { id: id(n), revision: rev(revision), data: sealed(n) }
}

async function rows(call: Call): Promise<Row[]> {
  const response = await call('GET', '/v1/records')
  return ((await response.json()) as { rows: Row[] }).rows
}

async function profile(call: Call): Promise<unknown> {
  const response = await call('GET', '/v1/profile')
  return ((await response.json()) as { encryption: unknown }).encryption
}

async function count(env: Env, table: string): Promise<number> {
  const row = await env.DB.prepare(`select count(*) as n from ${table}`).first<{ n: number }>()
  return row?.n ?? 0
}

/** Siembra dos registros sin cifrar (revisiones 1 y 2) por `/v1/push`. */
async function seed(call: Call) {
  const response = await call('POST', '/v1/push', {
    body: { changes: [plain(1), plain(2)], encrypted: false },
  })
  expect(response.status).toBe(204)
}

async function expectUntouched(call: Call) {
  const all = await rows(call)
  for (const row of all) {
    if (row.data !== null) expect(row.data).not.toHaveProperty('ciphertext')
  }
  expect(await profile(call)).toBeNull()
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

describe('POST /v1/encryption', () => {
  it('cifra todos los registros vivos, guarda el perfil y exige pushes cifrados', async () => {
    const { call } = await setup()
    await seed(call)
    const before = await rows(call)
    const response = await call('POST', '/v1/encryption', {
      body: { config, changes: [sealedChange(1), sealedChange(2)] },
    })
    expect(response.status).toBe(204)
    const after = await rows(call)
    expect(after.map((row) => row.data)).toEqual([sealed(1), sealed(2)])
    expect(after.map((row) => row.revision)).toEqual([rev(1), rev(2)])
    for (const [index, row] of after.entries()) {
      expect(row.updated_at > before[index].updated_at).toBe(true)
      expect(row.updated_at).toMatch(/\.\d{6}Z$/)
    }
    expect(await profile(call)).toEqual(config)

    const plainPush = await call('POST', '/v1/push', {
      body: { changes: [plain(3)], encrypted: false },
    })
    expect(plainPush.status).toBe(409)
    const sealedPush = await call('POST', '/v1/push', {
      body: { changes: [plain(3, 3, { data: sealed(3) })], encrypted: true },
    })
    expect(sealedPush.status).toBe(204)
    expect((await rows(call)).find((row) => row.id === id(3))?.data).toEqual(sealed(3))
  })

  it('updated_at = max(ahora, previo + 1 µs) aunque el reloj vaya hacia atrás', async () => {
    const { env, call } = await setup()
    await push(
      env,
      { changes: [plain(1)], encrypted: false },
      () => new Date('2026-11-23T12:00:00.000Z'),
    )
    const response = await enableEncryption(
      env,
      { config, changes: [sealedChange(1)] },
      () => new Date('2020-01-01T00:00:00.000Z'),
    )
    expect(response.status).toBe(204)
    expect((await rows(call))[0].updated_at).toBe('2026-11-23T12:00:00.000001Z')
  })

  it('sin registros solo guarda el perfil', async () => {
    const { call } = await setup()
    const response = await call('POST', '/v1/encryption', { body: { config, changes: [] } })
    expect(response.status).toBe(204)
    expect(await profile(call)).toEqual(config)
  })

  it('ignora los registros borrados y normaliza id y revisión', async () => {
    const { call } = await setup()
    await seed(call)
    await call('POST', '/v1/push', {
      body: { changes: [plain(2, 3, { deleted: true, data: null })], encrypted: false },
    })
    const upper = { ...sealedChange(1), id: id(1).toUpperCase(), revision: rev(1).toUpperCase() }
    const response = await call('POST', '/v1/encryption', { body: { config, changes: [upper] } })
    expect(response.status).toBe(204)
    const all = await rows(call)
    expect(all.find((row) => row.id === id(1))?.data).toEqual(sealed(1))
    expect(all.find((row) => row.id === id(2))?.data).toBeNull()
  })

  it('escribe todo en una sola batch', async () => {
    const { env, call } = await setup()
    await seed(call)
    const calls: string[] = []
    // Envuelve también las sentencias para detectar `.run()` fuera de la batch.
    const originals = new WeakMap<object, D1PreparedStatement>()
    const spy = (statement: D1PreparedStatement): D1PreparedStatement => {
      const wrapped = new Proxy(statement, {
        get: (target, prop) => {
          const value = Reflect.get(target, prop) as unknown
          if (prop === 'run') calls.push('run')
          if (prop === 'bind') {
            return (...args: unknown[]) => spy(target.bind(...args))
          }
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
      originals.set(wrapped, statement)
      return wrapped
    }
    const DB = new Proxy(env.DB, {
      get: (target, prop) => {
        const value = Reflect.get(target, prop) as unknown
        if (prop === 'prepare') return (sql: string) => spy(target.prepare(sql))
        if (prop === 'batch') {
          return (statements: D1PreparedStatement[]) => {
            calls.push('batch')
            return target.batch(statements.map((s) => originals.get(s) ?? s))
          }
        }
        if (prop === 'exec') {
          return (...args: unknown[]) => {
            calls.push('exec')
            return (value as (...a: unknown[]) => unknown).apply(target, args)
          }
        }
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const response = await enableEncryption(
      { ...env, DB },
      { config, changes: [sealedChange(1), sealedChange(2)] },
    )
    expect(response.status).toBe(204)
    expect(calls).toEqual(['batch'])
  })

  describe('409 sin escribir nada', () => {
    it('una revisión que no coincide', async () => {
      const { call } = await setup()
      await seed(call)
      const response = await call('POST', '/v1/encryption', {
        body: { config, changes: [sealedChange(1), sealedChange(2, 9)] },
      })
      expect(response.status).toBe(409)
      expect(await response.json()).toEqual({ error: 'Records changed' })
      await expectUntouched(call)
    })

    it('menos cambios que registros vivos', async () => {
      const { call } = await setup()
      await seed(call)
      const response = await call('POST', '/v1/encryption', {
        body: { config, changes: [sealedChange(1)] },
      })
      expect(response.status).toBe(409)
      expect(await response.json()).toEqual({ error: 'Records changed' })
      await expectUntouched(call)
    })

    it('el mismo id repetido aunque el conteo coincida', async () => {
      const { call } = await setup()
      await seed(call)
      const response = await call('POST', '/v1/encryption', {
        body: { config, changes: [sealedChange(1), sealedChange(1)] },
      })
      expect(response.status).toBe(409)
      await expectUntouched(call)
    })

    it('un id que no existe o está borrado', async () => {
      const { call } = await setup()
      await seed(call)
      await call('POST', '/v1/push', {
        body: { changes: [plain(2, 3, { deleted: true, data: null })], encrypted: false },
      })
      const response = await call('POST', '/v1/encryption', {
        body: { config, changes: [sealedChange(2, 3)] },
      })
      expect(response.status).toBe(409)
      await expectUntouched(call)
    })

    it('una segunda activación', async () => {
      const { call } = await setup()
      await seed(call)
      const first = await call('POST', '/v1/encryption', {
        body: { config, changes: [sealedChange(1), sealedChange(2)] },
      })
      expect(first.status).toBe(204)
      const after = await rows(call)
      const other = { ...config, salt: 'otra-sal-otra-sal-otra-s' }
      const second = await call('POST', '/v1/encryption', {
        body: { config: other, changes: [sealedChange(1), sealedChange(2)] },
      })
      expect(second.status).toBe(409)
      expect(await second.json()).toEqual({ error: 'Encryption already enabled' })
      expect(await profile(call)).toEqual(config)
      expect(await rows(call)).toEqual(after)
    })
  })

  describe('400 de validación', () => {
    it('data sin ciphertext', async () => {
      const { call } = await setup()
      await seed(call)
      const response = await call('POST', '/v1/encryption', {
        body: {
          config,
          changes: [sealedChange(1), { ...sealedChange(2), data: { iv: 'iv-2' } }],
        },
      })
      expect(response.status).toBe(400)
      await expectUntouched(call)
    })

    it('config o changes inválidos', async () => {
      const { call } = await setup()
      await seed(call)
      const changes = [sealedChange(1), sealedChange(2)]
      const bad = [
        { changes },
        { config: { salt: config.salt }, changes },
        { config: { salt: 3, check: config.check }, changes },
        { config: { salt: config.salt, check: { iv: 'i' } }, changes },
        { config: 'x', changes },
        { config },
        { config, changes: 'x' },
        { config, changes: [{ ...sealedChange(1), id: 'no-uuid' }, sealedChange(2)] },
        { config, changes: [{ ...sealedChange(1), revision: 'no-uuid' }, sealedChange(2)] },
        { config, changes: [{ ...sealedChange(1), data: 'x' }, sealedChange(2)] },
        { config, changes: [{ ...sealedChange(1), data: null }, sealedChange(2)] },
      ]
      for (const body of bad) {
        expect((await call('POST', '/v1/encryption', { body })).status).toBe(400)
      }
      await expectUntouched(call)
    })

    it('salt que no mide 24 o config demasiado grande', async () => {
      const { call } = await setup()
      const bad = [
        { ...config, salt: 's'.repeat(23) },
        { ...config, salt: 's'.repeat(25) },
        { ...config, check: { ...config.check, ciphertext: 'c'.repeat(MAX_CONFIG) } },
      ]
      for (const other of bad) {
        const response = await call('POST', '/v1/encryption', {
          body: { config: other, changes: [] },
        })
        expect(response.status).toBe(400)
      }
      expect(await profile(call)).toBeNull()
    })

    it('JSON inválido', async () => {
      const { env, call } = await setup()
      const response = await handle(
        new Request('https://sync.test/v1/encryption', {
          method: 'POST',
          headers: { authorization: `Bearer ${env.SYNC_KEY}`, 'content-type': 'application/json' },
          body: '{',
        }),
        env,
      )
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'Invalid JSON' })
      expect(await profile(call)).toBeNull()
    })
  })

  it('rechaza sin clave con 401', async () => {
    const { env, call } = await setup()
    await seed(call)
    const response = await call('POST', '/v1/encryption', {
      key: undefined,
      body: { config, changes: [sealedChange(1), sealedChange(2)] },
    })
    expect(response.status).toBe(401)
    await expectUntouched(call)
    expect(await count(env, 'profile')).toBe(1)
  })

  describe('concurrencia entre la lectura y la batch', () => {
    const body = { config, changes: [sealedChange(1), sealedChange(2)] }

    async function expectRetry409(call: Call, error: string) {
      const retry = await call('POST', '/v1/encryption', { body })
      expect(retry.status).toBe(409)
      expect(await retry.json()).toEqual({ error })
    }

    it('un push que cambia un registro revierte todo; el reintento da 409', async () => {
      const { env, call } = await setup()
      await seed(call)
      const racing = beforeBatch(env, async () => {
        const response = await push(env, {
          changes: [plain(2, 5, { data: { n: 5 } })],
          encrypted: false,
        })
        expect(response.status).toBe(204)
      })
      await expect(enableEncryption(racing, body)).rejects.toThrow()
      await expectUntouched(call)
      expect((await rows(call)).find((row) => row.id === id(2))?.data).toEqual({ n: 5 })
      await expectRetry409(call, 'Records changed')
      await expectUntouched(call)
    })

    it('un push que agrega un registro revierte todo; el reintento da 409', async () => {
      const { env, call } = await setup()
      await seed(call)
      const racing = beforeBatch(env, () => push(env, { changes: [plain(3)], encrypted: false }))
      await expect(enableEncryption(racing, body)).rejects.toThrow()
      await expectUntouched(call)
      expect(await rows(call)).toHaveLength(3)
      await expectRetry409(call, 'Records changed')
    })

    it('un push que borra un registro revierte todo; el reintento da 409', async () => {
      const { env, call } = await setup()
      await seed(call)
      const racing = beforeBatch(env, () =>
        push(env, {
          changes: [plain(2, 5, { deleted: true, data: null })],
          encrypted: false,
        }),
      )
      await expect(enableEncryption(racing, body)).rejects.toThrow()
      await expectUntouched(call)
      await expectRetry409(call, 'Records changed')
    })

    it('un registro cifrado en el medio (misma revisión) revierte todo', async () => {
      const { env, call } = await setup()
      await seed(call)
      const racing = beforeBatch(env, () =>
        env.DB.prepare('update records set data = ? where id = ?')
          .bind(JSON.stringify(sealed(2)), id(2))
          .run(),
      )
      await expect(enableEncryption(racing, body)).rejects.toThrow()
      expect((await rows(call)).find((row) => row.id === id(1))?.data).toEqual({ n: 1 })
      expect(await profile(call)).toBeNull()
    })

    it('otra activación concurrente gana; esta revierte y el reintento da 409', async () => {
      const { env, call } = await setup()
      await seed(call)
      const winner = { ...config, salt: 'ganadora-ganadora-ganado' }
      const winnerChanges = [
        { ...sealedChange(1), data: { iv: 'w', ciphertext: 'w1' } },
        { ...sealedChange(2), data: { iv: 'w', ciphertext: 'w2' } },
      ]
      const racing = beforeBatch(env, async () => {
        const response = await enableEncryption(env, { config: winner, changes: winnerChanges })
        expect(response.status).toBe(204)
      })
      await expect(enableEncryption(racing, body)).rejects.toThrow()
      expect(await profile(call)).toEqual(winner)
      expect((await rows(call)).map((row) => row.data)).toEqual(
        winnerChanges.map((change) => change.data),
      )
      await expectRetry409(call, 'Encryption already enabled')
    })

    it('sin registros, otra activación concurrente gana solo por el perfil', async () => {
      // Sin registros, la única defensa es la cláusula del perfil ya cifrado.
      const { env, call } = await setup()
      const winner = { ...config, salt: 'ganadora-ganadora-ganado' }
      const racing = beforeBatch(env, async () => {
        const response = await enableEncryption(env, { config: winner, changes: [] })
        expect(response.status).toBe(204)
      })
      await expect(enableEncryption(racing, { config, changes: [] })).rejects.toThrow()
      expect(await profile(call)).toEqual(winner)
      const retry = await call('POST', '/v1/encryption', { body: { config, changes: [] } })
      expect(retry.status).toBe(409)
      expect(await retry.json()).toEqual({ error: 'Encryption already enabled' })
    })

    it('un push sin cifrar que pierde la carrera revierte y su reintento da 409', async () => {
      const { env, call } = await setup()
      await seed(call)
      const racing = beforeBatch(env, () => enableEncryption(env, body))
      await expect(push(racing, { changes: [plain(3)], encrypted: false })).rejects.toThrow()
      const all = await rows(call)
      expect(all).toHaveLength(2)
      expect(all.map((row) => row.data)).toEqual([sealed(1), sealed(2)])
      const retry = await call('POST', '/v1/push', {
        body: { changes: [plain(3)], encrypted: false },
      })
      expect(retry.status).toBe(409)
    })

    it('el 500 por la carrera no registra la clave', async () => {
      const { env } = await setup()
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      await env.DB.prepare(
        `insert into records(id, collection, data, revision, updated_at)
         values (?, 'entries', '{"n":1}', ?, '2026-11-23T12:00:00.000000Z')`,
      )
        .bind(id(1), rev(1))
        .run()
      const racing = beforeBatch(env, () => push(env, { changes: [plain(1, 7)], encrypted: false }))
      const response = await handle(
        new Request('https://sync.test/v1/encryption', {
          method: 'POST',
          headers: { authorization: `Bearer ${env.SYNC_KEY}`, 'content-type': 'application/json' },
          body: JSON.stringify({ config, changes: [sealedChange(1)] }),
        }),
        racing,
      )
      expect(response.status).toBe(500)
      const logged = error.mock.calls.flat().map(String).join(' ')
      expect(logged).not.toContain(env.SYNC_KEY)
      error.mockRestore()
    })
  })
})
