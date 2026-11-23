import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { afterEach } from 'vitest'
import { handle, type Env } from '../src/index'

export const SYNC_KEY = 'clave-de-prueba'
export const ALLOWED_ORIGIN = 'https://ilancueto.github.io'

const schema = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../schema.sql'), 'utf8')
const open: Miniflare[] = []

afterEach(async () => {
  await Promise.all(open.splice(0).map((mf) => mf.dispose()))
})

export async function setup(): Promise<{
  env: Env
  call: (
    method: string,
    path: string,
    init?: { body?: unknown; key?: string; origin?: string },
  ) => Promise<Response>
}> {
  // Miniflare 5 (el que usa wrangler 4.166) cambió el formato de opciones; se convierten
  // las opciones al estilo v4 que describe el plan.
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response("") } }',
      d1Databases: { DB: 'test' },
    }),
  )
  open.push(mf)
  const DB = (await mf.getD1Database('DB')) as unknown as Env['DB']
  const statements = schema
    .split(';')
    .map((sql) => sql.trim())
    .filter(Boolean)
    .map((sql) => DB.prepare(sql))
  await DB.batch(statements)
  const env: Env = { DB, SYNC_KEY, ALLOWED_ORIGIN }
  const call = (
    method: string,
    path: string,
    init: { body?: unknown; key?: string; origin?: string } = {},
  ) => {
    const headers = new Headers()
    const key = 'key' in init ? init.key : SYNC_KEY
    if (key !== undefined) headers.set('authorization', `Bearer ${key}`)
    if (init.origin) headers.set('origin', init.origin)
    let body: string | undefined
    if (init.body !== undefined) {
      headers.set('content-type', 'application/json')
      body = JSON.stringify(init.body)
    }
    return handle(new Request(`https://sync.test${path}`, { method, headers, body }), env)
  }
  return { env, call }
}
