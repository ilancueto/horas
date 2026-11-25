import { describe, expect, it, vi } from 'vitest'
import { CloudError, createCloud, linkedOwner, parseCloudUrl } from './cloud'
import type { ChangePacket } from './syncEngine'

const KEY = 'secret-key'
const row = (n: number) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  collection: 'entries' as const,
  data: { n },
  revision: '11111111-1111-4111-8111-111111111111',
  updated_at: '2026-01-01T00:00:00.000Z',
  deleted_at: null,
})
const reply = (body: unknown, status = 200) =>
  Promise.resolve(
    status === 204
      ? new Response(null, { status })
      : new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
  )
const encryption = {
  salt: 'A'.repeat(24),
  check: { iv: 'B'.repeat(16), ciphertext: 'C'.repeat(24) },
}
const changes: ChangePacket[] = [
  {
    id: row(1).id,
    collection: 'entries',
    revision: row(1).revision,
    deleted: false,
    data: { a: 1 },
  },
]

describe('createCloud', () => {
  it('pagina hasta recibir menos de 500 filas y las concatena', async () => {
    const first = Array.from({ length: 500 }, (_, i) => row(i))
    const second = [row(500), row(501), row(502)]
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => reply({ rows: first }))
      .mockImplementationOnce(() => reply({ rows: second }))
    const rows = await createCloud('https://w.test', KEY, fetcher).pull()
    expect(rows).toHaveLength(503)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[0]![0]).toBe('https://w.test/v1/records?limit=500')
    expect(fetcher.mock.calls[1]![0]).toBe(
      `https://w.test/v1/records?after=${first.at(-1)!.id}&limit=500`,
    )
  })

  it('envía solo el encabezado Authorization con la clave, sin ponerla en la URL', async () => {
    const fetcher = vi.fn().mockImplementation(() => reply({ rows: [] }))
    await createCloud('https://w.test', KEY, fetcher).pull()
    const [url, init] = fetcher.mock.calls[0]!
    expect(String(url)).not.toContain(KEY)
    expect(init.method).toBe('GET')
    expect(init.headers).toEqual({ Authorization: `Bearer ${KEY}` })
  })

  it('push envía { changes, encrypted } por POST /v1/push', async () => {
    const fetcher = vi.fn().mockImplementation(() => reply(null, 204))
    await createCloud('https://w.test', KEY, fetcher).push(changes, true)
    const [url, init] = fetcher.mock.calls[0]!
    expect(url).toBe('https://w.test/v1/push')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
    })
    expect(JSON.parse(init.body)).toEqual({ changes, encrypted: true })
  })

  it('401 lanza CloudError con status 401', async () => {
    const fetcher = vi.fn().mockImplementation(() => reply({ error: 'Unauthorized' }, 401))
    const error = await createCloud('https://w.test', KEY, fetcher)
      .pull()
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CloudError)
    expect((error as CloudError).status).toBe(401)
  })

  it('5xx lanza CloudError conservando el status', async () => {
    const fetcher = vi.fn().mockImplementation(() => reply({ error: 'Internal error' }, 500))
    const error = await createCloud('https://w.test', KEY, fetcher)
      .push(changes, false)
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CloudError)
    expect((error as CloudError).status).toBe(500)
  })

  it('un fallo de red propaga el error original', async () => {
    const boom = new TypeError('Failed to fetch')
    const fetcher = vi.fn().mockRejectedValue(boom)
    await expect(createCloud('https://w.test', KEY, fetcher).pull()).rejects.toBe(boom)
  })

  it('encryption devuelve null cuando no hay configuración', async () => {
    const fetcher = vi.fn().mockImplementation(() => reply({ encryption: null }))
    const cloud = createCloud('https://w.test', KEY, fetcher)
    expect(await cloud.encryption()).toBeNull()
    expect(fetcher.mock.calls[0]![0]).toBe('https://w.test/v1/profile')
  })

  it('encryption devuelve una configuración válida', async () => {
    const fetcher = vi.fn().mockImplementation(() => reply({ encryption }))
    expect(await createCloud('https://w.test', KEY, fetcher).encryption()).toEqual(encryption)
  })

  it('encryption rechaza una configuración inválida', async () => {
    const fetcher = vi.fn().mockImplementation(() => reply({ encryption: { salt: 'x' } }))
    await expect(createCloud('https://w.test', KEY, fetcher).encryption()).rejects.toThrow()
  })

  it('acepta el formato real del Worker: updated_at con 6 decimales', async () => {
    // Fila tal como la devuelve el Worker (ISO zulú con microsegundos, `deleted_at` igual).
    const worker = {
      ...row(1),
      updated_at: '2026-11-01T00:00:00.123456Z',
    }
    const deleted = {
      ...row(2),
      data: null,
      updated_at: '2026-11-01T00:00:00.123457Z',
      deleted_at: '2026-11-01T00:00:00.123457Z',
    }
    const fetcher = vi.fn().mockImplementation(() => reply({ rows: [worker, deleted] }))
    const rows = await createCloud('https://w.test', KEY, fetcher).pull()
    expect(rows).toHaveLength(2)
    expect(rows[0]!.updated_at).toBe('2026-11-01T00:00:00.123456Z')
    expect(rows[1]!.deleted_at).toBe('2026-11-01T00:00:00.123457Z')
  })

  it('rechaza una respuesta malformada de pull', async () => {
    const fetcher = vi.fn().mockImplementation(() => reply({ rows: [{ id: 'no-uuid' }] }))
    await expect(createCloud('https://w.test', KEY, fetcher).pull()).rejects.toThrow()
    const nothing = vi.fn().mockImplementation(() => reply({ nope: true }))
    await expect(createCloud('https://w.test', KEY, nothing).pull()).rejects.toThrow()
  })

  it('falla si el cursor no avanza (mismas 500 filas siempre)', async () => {
    const page = Array.from({ length: 500 }, (_, i) => row(i))
    const fetcher = vi.fn().mockImplementation(() => reply({ rows: page }))
    const error = await createCloud('https://w.test', KEY, fetcher)
      .pull()
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(CloudError)
    expect(fetcher.mock.calls.length).toBeLessThanOrEqual(3)
  })

  it('un 200 que no es JSON lanza un error claro', async () => {
    const fetcher = vi
      .fn()
      .mockImplementation(() => Promise.resolve(new Response('<html>404</html>', { status: 200 })))
    const error = await createCloud('https://w.test', KEY, fetcher)
      .pull()
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('Respuesta inválida del servidor de sincronización.')
  })

  it('una barra final en baseUrl no duplica /', async () => {
    const fetcher = vi.fn().mockImplementation(() => reply({ rows: [] }))
    await createCloud('https://w.test/', KEY, fetcher).pull()
    expect(fetcher.mock.calls[0]![0]).toBe('https://w.test/v1/records?limit=500')
  })

  it('disableEncryption envía la frase por POST /v1/decryption', async () => {
    const fetcher = vi.fn().mockImplementation(() => reply(null, 204))
    await createCloud('https://w.test', KEY, fetcher).disableEncryption('frase de prueba')
    const [url, init] = fetcher.mock.calls[0]!
    expect(url).toBe('https://w.test/v1/decryption')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ phrase: 'frase de prueba' })
  })
})

describe('parseCloudUrl', () => {
  it.each([
    undefined,
    '',
    '   ',
    'horas.workers.dev',
    '/relative',
    'ftp://x',
    'https://',
    'nota url',
  ])('descarta %j como no configurado', (raw) => {
    expect(parseCloudUrl(raw)).toBeUndefined()
  })
  it('acepta http(s) y quita las barras finales', () => {
    expect(parseCloudUrl('https://horas.example.workers.dev/')).toBe(
      'https://horas.example.workers.dev',
    )
    expect(parseCloudUrl(' https://horas.example.workers.dev/api// ')).toBe(
      'https://horas.example.workers.dev/api',
    )
    expect(parseCloudUrl('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787')
  })
})

describe('linkedOwner', () => {
  it('conserva un origen http(s)', () => {
    expect(linkedOwner('https://horas.example.workers.dev')).toBe(
      'https://horas.example.workers.dev',
    )
  })
  it.each(['', '00100000-0000-4000-a000-000000000001', 'ftp://x', 'https://x.dev/ruta', 42, null])(
    'trata %j (dueño heredado o inválido) como no vinculado',
    (stored) => {
      expect(linkedOwner(stored)).toBe('')
    },
  )
})
