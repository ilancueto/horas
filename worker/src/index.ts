import { authorized } from './auth'

export type Env = { DB: D1Database; SYNC_KEY: string; ALLOWED_ORIGIN: string }

type Route = (request: Request, env: Env, url: URL) => Promise<Response>

const PAGE_SIZE = 500

type RecordRow = {
  id: string
  collection: string
  data: string | null
  revision: string
  updated_at: string
  deleted_at: string | null
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

export function empty(status = 204): Response {
  return new Response(null, { status })
}

function pageSize(value: string | null): number {
  const parsed = Number(value)
  if (value === null || !Number.isInteger(parsed) || parsed < 1) return PAGE_SIZE
  return Math.min(parsed, PAGE_SIZE)
}

async function readRecords(_request: Request, env: Env, url: URL): Promise<Response> {
  const after = url.searchParams.get('after') ?? ''
  const limit = pageSize(url.searchParams.get('limit'))
  const { results } = await env.DB.prepare(
    'select id, collection, data, revision, updated_at, deleted_at from records where id > ? order by id limit ?',
  )
    .bind(after, limit)
    .all<RecordRow>()
  const rows = results.map((row) => ({
    ...row,
    data: row.data === null ? null : (JSON.parse(row.data) as unknown),
  }))
  return json({ rows })
}

async function readProfile(_request: Request, env: Env): Promise<Response> {
  const row = await env.DB.prepare('select encryption from profile where id = 1').first<{
    encryption: string | null
  }>()
  const encryption = row?.encryption ? (JSON.parse(row.encryption) as unknown) : null
  return json({ encryption })
}

/** Rutas autenticadas, por `MÉTODO /ruta`. Las tareas siguientes agregan entradas aquí. */
const routes: Record<string, Route> = {
  'GET /v1/records': readRecords,
  'GET /v1/profile': readProfile,
}

function allowedOrigin(request: Request, env: Env): string | null {
  const origin = request.headers.get('origin')
  if (!origin) return null
  const allowed = env.ALLOWED_ORIGIN.split(',').map((value) => value.trim())
  return allowed.includes(origin) ? origin : null
}

function withCors(response: Response, origin: string | null): Response {
  if (!origin) return response
  const headers = new Headers(response.headers)
  headers.set('access-control-allow-origin', origin)
  headers.set('access-control-allow-methods', 'GET, POST, OPTIONS')
  headers.set('access-control-allow-headers', 'authorization, content-type')
  headers.set('access-control-max-age', '86400')
  headers.append('vary', 'Origin')
  return new Response(response.body, { status: response.status, headers })
}

export async function handle(request: Request, env: Env): Promise<Response> {
  const origin = allowedOrigin(request, env)
  if (request.method === 'OPTIONS') return withCors(empty(), origin)
  if (!(await authorized(request, env.SYNC_KEY))) {
    return withCors(json({ error: 'Unauthorized' }, 401), origin)
  }
  const url = new URL(request.url)
  const route = routes[`${request.method} ${url.pathname}`]
  if (!route) return withCors(json({ error: 'Not found' }, 404), origin)
  try {
    return withCors(await route(request, env, url), origin)
  } catch {
    return withCors(json({ error: 'Internal error' }, 500), origin)
  }
}

export default { fetch: handle }
