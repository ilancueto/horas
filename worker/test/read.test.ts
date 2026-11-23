import { describe, expect, it } from 'vitest'
import { handle } from '../src/index'
import { ALLOWED_ORIGIN, SYNC_KEY, setup } from './helpers'

const ids = [
  '10000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002',
  '30000000-0000-4000-8000-000000000003',
]

describe('autenticación', () => {
  for (const path of ['/v1/records', '/v1/profile']) {
    it(`rechaza ${path} sin encabezado`, async () => {
      const { call } = await setup()
      expect((await call('GET', path, { key: undefined })).status).toBe(401)
    })

    it(`rechaza ${path} con clave incorrecta`, async () => {
      const { call } = await setup()
      expect((await call('GET', path, { key: 'clave-de-pruebX' })).status).toBe(401)
    })

    it(`rechaza ${path} con clave de otro largo`, async () => {
      const { call } = await setup()
      expect((await call('GET', path, { key: `${SYNC_KEY}-extra` })).status).toBe(401)
      expect((await call('GET', path, { key: '' })).status).toBe(401)
    })

    it(`rechaza ${path} con esquema distinto de Bearer`, async () => {
      const { env } = await setup()
      const request = new Request(`https://sync.test${path}`, {
        headers: { authorization: `Basic ${SYNC_KEY}` },
      })
      expect((await handle(request, env)).status).toBe(401)
    })
  }

  it('responde 401 sin tocar la base', async () => {
    const { env } = await setup()
    const touched = {
      DB: new Proxy(env.DB, {
        get: () => {
          throw new Error('DB tocada')
        },
      }),
    }
    const response = await handle(
      new Request('https://sync.test/v1/records', { headers: { authorization: 'Bearer mala' } }),
      { ...env, ...touched },
    )
    expect(response.status).toBe(401)
  })
})

describe('lecturas', () => {
  it('devuelve vacío con la base vacía', async () => {
    const { call } = await setup()
    const records = await call('GET', '/v1/records')
    expect(records.status).toBe(200)
    expect(records.headers.get('content-type')).toContain('application/json')
    expect(await records.json()).toEqual({ rows: [] })
    const profile = await call('GET', '/v1/profile')
    expect(profile.status).toBe(200)
    expect(profile.headers.get('content-type')).toContain('application/json')
    expect(await profile.json()).toEqual({ encryption: null })
  })

  it('devuelve el perfil de cifrado guardado', async () => {
    const { env, call } = await setup()
    await env.DB.prepare('insert into profile(id, encryption) values (1, ?)')
      .bind(JSON.stringify({ salt: 's', check: { iv: 'i', ciphertext: 'c' } }))
      .run()
    expect(await (await call('GET', '/v1/profile')).json()).toEqual({
      encryption: { salt: 's', check: { iv: 'i', ciphertext: 'c' } },
    })
  })

  it('devuelve las filas ordenadas por id y pagina con after/limit', async () => {
    const { env, call } = await setup()
    const insert = env.DB.prepare(
      'insert into records(id, collection, data, revision, updated_at, deleted_at) values (?, ?, ?, ?, ?, ?)',
    )
    await env.DB.batch([
      insert.bind(
        ids[2],
        'entries',
        JSON.stringify({ n: 3 }),
        ids[0],
        '2026-11-23T12:00:00.000003Z',
        null,
      ),
      insert.bind(
        ids[0],
        'periods',
        JSON.stringify({ n: 1 }),
        ids[1],
        '2026-11-23T12:00:00.000001Z',
        null,
      ),
      insert.bind(
        ids[1],
        'rules',
        null,
        ids[2],
        '2026-11-23T12:00:00.000002Z',
        '2026-11-23T12:00:00.000002Z',
      ),
    ])

    const all = (await (await call('GET', '/v1/records')).json()) as { rows: unknown[] }
    expect(all.rows).toEqual([
      {
        id: ids[0],
        collection: 'periods',
        data: { n: 1 },
        revision: ids[1],
        updated_at: '2026-11-23T12:00:00.000001Z',
        deleted_at: null,
      },
      {
        id: ids[1],
        collection: 'rules',
        data: null,
        revision: ids[2],
        updated_at: '2026-11-23T12:00:00.000002Z',
        deleted_at: '2026-11-23T12:00:00.000002Z',
      },
      {
        id: ids[2],
        collection: 'entries',
        data: { n: 3 },
        revision: ids[0],
        updated_at: '2026-11-23T12:00:00.000003Z',
        deleted_at: null,
      },
    ])

    const page = (await (await call('GET', `/v1/records?after=${ids[0]}&limit=2`)).json()) as {
      rows: { id: string }[]
    }
    expect(page.rows.map((row) => row.id)).toEqual([ids[1], ids[2]])

    const first = (await (await call('GET', '/v1/records?limit=1')).json()) as {
      rows: { id: string }[]
    }
    expect(first.rows.map((row) => row.id)).toEqual([ids[0]])
  })

  it('limita a 500 filas por página', async () => {
    const { env, call } = await setup()
    const insert = env.DB.prepare(
      'insert into records(id, collection, data, revision, updated_at) values (?, ?, ?, ?, ?)',
    )
    const statements = Array.from({ length: 501 }, (_, i) => {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
      return insert.bind(id, 'entries', '{}', id, '2026-11-23T12:00:00.000000Z')
    })
    await env.DB.batch(statements)
    const big = (await (await call('GET', '/v1/records?limit=10000')).json()) as { rows: unknown[] }
    expect(big.rows).toHaveLength(500)
    const plain = (await (await call('GET', '/v1/records')).json()) as { rows: unknown[] }
    expect(plain.rows).toHaveLength(500)
  })
})

describe('CORS y rutas', () => {
  it('responde OPTIONS al origen permitido', async () => {
    const { call } = await setup()
    const response = await call('OPTIONS', '/v1/records', {
      key: undefined,
      origin: ALLOWED_ORIGIN,
    })
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN)
    expect(response.headers.get('access-control-allow-headers')?.toLowerCase()).toContain(
      'authorization',
    )
  })

  it('no habilita CORS para otro origen', async () => {
    const { call } = await setup()
    const response = await call('OPTIONS', '/v1/records', {
      key: undefined,
      origin: 'https://otro.example',
    })
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
    expect(response.headers.get('access-control-allow-headers')).toBeNull()
  })

  it('acepta una lista de orígenes separada por comas', async () => {
    const { env } = await setup()
    const multi = { ...env, ALLOWED_ORIGIN: `${ALLOWED_ORIGIN}, http://localhost:5173` }
    const response = await handle(
      new Request('https://sync.test/v1/profile', {
        headers: { authorization: `Bearer ${SYNC_KEY}`, origin: 'http://localhost:5173' },
      }),
      multi,
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')
  })

  it('agrega CORS a respuestas 401 del origen permitido', async () => {
    const { call } = await setup()
    const response = await call('GET', '/v1/records', { key: 'mala', origin: ALLOWED_ORIGIN })
    expect(response.status).toBe(401)
    expect(response.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN)
  })

  it('devuelve 404 en rutas desconocidas', async () => {
    const { call } = await setup()
    expect((await call('GET', '/v1/otra')).status).toBe(404)
    expect((await call('POST', '/v1/records')).status).toBe(404)
  })
})
