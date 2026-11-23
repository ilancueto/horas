import { expect, test, type BrowserContext, type Page } from '@playwright/test'

const supabase = 'https://horas-test.supabase.co'
const uid = '00100000-0000-4000-a000-000000000001'
const user = {
  id: uid,
  aud: 'authenticated',
  role: 'authenticated',
  email: 'prueba@example.invalid',
  app_metadata: {},
  user_metadata: {},
  created_at: '2026-01-01T00:00:00Z',
}
const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
const expires = Math.floor(Date.parse('2026-11-24T15:00:00Z') / 1000) + 3600
const session = {
  access_token:
    encode({ alg: 'HS256', typ: 'JWT' }) +
    '.' +
    encode({ sub: uid, role: 'authenticated', exp: expires }) +
    '.c2ln',
  token_type: 'bearer',
  expires_at: expires,
  expires_in: 3600,
  refresh_token: 'mock-refresh-token',
  user,
}
type RecordPacket = {
  id: string
  collection: string
  data: unknown
  revision: string
  deleted: boolean
}
type Remote = Omit<RecordPacket, 'deleted'> & { updated_at: string; deleted_at: string | null }
const date = '2026-11-24'
const address = 'http://127.0.0.1:47684'
async function onboard(page: Page) {
  await page.clock.setFixedTime(new Date(date + 'T15:00:00Z'))
  await page.goto(address)
  await page.getByRole('button', { name: 'Empezar de cero' }).click()
  await page.getByRole('button', { name: 'Continuar' }).click()
  await page.getByRole('button', { name: 'Guardar período' }).click()
  await expect(page.getByRole('heading', { name: 'Jornadas' })).toBeVisible()
}
const more = (page: Page) =>
  page
    .getByRole('navigation')
    .filter({ visible: true })
    .getByRole('button', { name: 'Más', exact: true })
    .click()
const period = (page: Page) =>
  page
    .getByRole('navigation')
    .filter({ visible: true })
    .getByRole('button', { name: 'Período', exact: true })
    .click()

test('fusiona y sincroniza dos perfiles de navegador con Supabase simulado', async ({
  browser,
}) => {
  const remote = new Map<string, Remote>()
  const revisions = new Set<string>()
  const sockets = new Set<(packet: Remote) => void>()
  let version = 0
  let tokenInstalled = false
  async function stub(context: BrowserContext) {
    await context.addInitScript(
      ({ key, session }) => {
        if (localStorage.getItem('activate-mock-session'))
          localStorage.setItem(key, JSON.stringify(session))
      },
      { key: 'sb-horas-test-auth-token', session },
    )
    await context.route(supabase + '/**', async (route) => {
      const req = route.request()
      const path = new URL(req.url()).pathname
      const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }
      if (req.method() === 'OPTIONS') {
        await route.fulfill({ status: 204, headers })
        return
      }
      if (path.endsWith('/user')) {
        await route.fulfill({ json: user, headers })
        return
      }
      if (path.endsWith('/horas_profiles')) {
        await route.fulfill({ json: [], headers })
        return
      }
      if (path.endsWith('/records')) {
        await route.fulfill({
          json: [...remote.values()].sort((a, b) => a.id.localeCompare(b.id)),
          headers,
        })
        return
      }
      if (path.endsWith('/horas_push')) {
        const { changes } = req.postDataJSON() as { changes: RecordPacket[] }
        for (const change of changes) {
          if (revisions.has(change.revision)) continue
          revisions.add(change.revision)
          const updated_at = new Date(Date.UTC(2026, 10, 24, 0, 0, ++version)).toISOString()
          const row = {
            id: change.id,
            collection: change.collection,
            revision: change.revision,
            data: change.data,
            updated_at,
            deleted_at: change.deleted ? updated_at : null,
          }
          remote.set(change.id, row)
          for (const send of sockets) send(row)
        }
        await route.fulfill({ status: 204, headers })
        return
      }
      await route.fulfill({ status: 404, headers, json: { message: 'Mock route unavailable' } })
    })
    await context.routeWebSocket(/wss:\/\/horas-test\.supabase\.co\//, (socket) => {
      let subscribe: (packet: Remote) => void
      socket.onMessage((raw) => {
        const parsed = JSON.parse(String(raw))
        if (!Array.isArray(parsed)) return
        const [join, ref, topic, event, body] = parsed
        if (event === 'phx_join') {
          const specs = (body.config.postgres_changes as Record<string, string>[]).map(
            (spec, id) => ({ ...spec, id: id + 1 }),
          )
          socket.send(
            JSON.stringify([
              join,
              ref,
              topic,
              'phx_reply',
              { status: 'ok', response: { postgres_changes: specs } },
            ]),
          )
          subscribe = (packet) =>
            socket.send(
              JSON.stringify([
                join,
                null,
                topic,
                'postgres_changes',
                {
                  ids: [1],
                  data: {
                    schema: 'public',
                    table: 'records',
                    commit_timestamp: packet.updated_at,
                    type: 'UPDATE',
                    columns: [],
                    record: packet,
                    old_record: {},
                    errors: null,
                  },
                },
              ]),
            )
          sockets.add(subscribe)
        } else if (event === 'heartbeat')
          socket.send(
            JSON.stringify([join, ref, topic, 'phx_reply', { status: 'ok', response: {} }]),
          )
      })
      socket.onClose(() => sockets.delete(subscribe))
    })
  }
  const first = await browser.newContext(),
    second = await browser.newContext()
  try {
    await stub(first)
    await stub(second)
    const a = await first.newPage(),
      b = await second.newPage()
    await onboard(a)
    await onboard(b)
    for (const p of [a, b]) {
      await p.evaluate(() => localStorage.setItem('activate-mock-session', '1'))
      await p.reload()
      if (tokenInstalled) {
        await expect(p.getByRole('dialog', { name: 'Fusionar datos' })).toBeVisible()
        await p.getByRole('button', { name: 'Fusionar y sincronizar' }).click()
      }
      await more(p)
      await expect(
        p.getByText('Sincronizado', { exact: true }).filter({ visible: true }).last(),
      ).toBeVisible()
      tokenInstalled = true
    }
    await first.setOffline(true)
    await period(a)
    await a.getByRole('button', { name: 'Cargar hoy' }).click()
    await a.getByRole('button', { name: 'Horario estándar' }).click()
    await a.getByRole('button', { name: 'Guardar jornada' }).click()
    await expect(a.getByRole('region', { name: 'Totales del período' })).toContainText('1 día trabajado')
    expect([...remote.values()].filter((r) => r.collection === 'entries')).toHaveLength(0)
    await first.setOffline(false)
    await expect
      .poll(() => [...remote.values()].filter((r) => r.collection === 'entries').length)
      .toBe(1)
    await period(b)
    await expect(b.getByRole('region', { name: 'Totales del período' })).toContainText('1 día trabajado', {
      timeout: 10000,
    })
  } finally {
    await first.close()
    await second.close()
  }
})
