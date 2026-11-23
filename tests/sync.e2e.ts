import { expect, test, type BrowserContext, type Page } from '@playwright/test'

const worker = 'https://horas-test.workers.dev'
const secret = 'clave-de-prueba'
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
const status = (page: Page, text: string) =>
  page.getByText(text, { exact: true }).filter({ visible: true }).last()
async function connect(page: Page, key: string) {
  await page.getByLabel('Clave de sincronización').fill(key)
  await page.getByRole('button', { name: 'Guardar y conectar' }).click()
}

/** Simula el Worker de Cloudflare: CORS, clave Bearer, lecturas paginadas y push con revisiones. */
function createWorker() {
  const remote = new Map<string, Remote>()
  const revisions = new Set<string>()
  let version = 0
  let authorized = 0
  let rejected = 0
  let leaked = 0
  async function stub(context: BrowserContext) {
    // La clave solo puede viajar en el encabezado Authorization, nunca en una URL.
    context.on('request', (req) => {
      if (req.url().includes(secret) || req.url().includes('incorrecta')) leaked++
    })
    await context.route(worker + '/**', async (route) => {
      const req = route.request()
      const url = new URL(req.url())
      const headers = {
        'access-control-allow-origin': address,
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'authorization, content-type',
        vary: 'Origin',
      }
      if (req.method() === 'OPTIONS') {
        await route.fulfill({ status: 204, headers })
        return
      }
      if ((await req.headerValue('authorization')) !== 'Bearer ' + secret) {
        rejected++
        await route.fulfill({ status: 401, headers, json: { error: 'Unauthorized' } })
        return
      }
      authorized++
      if (req.method() === 'GET' && url.pathname === '/v1/profile') {
        await route.fulfill({ json: { encryption: null }, headers })
        return
      }
      if (req.method() === 'GET' && url.pathname === '/v1/records') {
        const after = url.searchParams.get('after') ?? ''
        const limit = Number(url.searchParams.get('limit') ?? 500)
        const rows = [...remote.values()]
          .sort((a, b) => a.id.localeCompare(b.id))
          .filter((r) => r.id > after)
          .slice(0, limit)
        await route.fulfill({ json: { rows }, headers })
        return
      }
      if (req.method() === 'POST' && url.pathname === '/v1/push') {
        const { changes } = req.postDataJSON() as { changes: RecordPacket[] }
        for (const change of changes) {
          if (revisions.has(change.revision)) continue
          revisions.add(change.revision)
          const updated_at = new Date(Date.UTC(2026, 10, 24, 0, 0, ++version))
            .toISOString()
            .replace('Z', '000Z')
          remote.set(change.id, {
            id: change.id,
            collection: change.collection,
            revision: change.revision,
            data: change.deleted ? null : change.data,
            updated_at,
            deleted_at: change.deleted ? updated_at : null,
          })
        }
        await route.fulfill({ status: 204, headers })
        return
      }
      await route.fulfill({ status: 404, headers, json: { error: 'Not found' } })
    })
  }
  return {
    remote,
    stub,
    authorized: () => authorized,
    rejected: () => rejected,
    leaked: () => leaked,
  }
}

test('sincroniza y fusiona dos perfiles de navegador con el Worker simulado', async ({
  browser,
}) => {
  const server = createWorker()
  const first = await browser.newContext(),
    second = await browser.newContext()
  try {
    await server.stub(first)
    await server.stub(second)
    const a = await first.newPage(),
      b = await second.newPage()
    await onboard(a)
    await onboard(b)
    for (const p of [a, b]) {
      await more(p)
      await expect(status(p, 'Solo local')).toBeVisible()
      await connect(p, secret)
      if (p === b) {
        await expect(p.getByRole('dialog', { name: 'Fusionar datos' })).toBeVisible()
        await p.getByRole('button', { name: 'Fusionar y sincronizar' }).click()
      }
      await expect(status(p, 'Sincronizado')).toBeVisible()
      await expect(p.getByText('Conectado a horas-test.workers.dev')).toBeVisible()
    }
    await first.setOffline(true)
    await period(a)
    await a.getByRole('button', { name: 'Cargar hoy' }).click()
    await a.getByRole('button', { name: 'Horario estándar' }).click()
    await a.getByRole('button', { name: 'Guardar jornada' }).click()
    await expect(a.getByRole('region', { name: 'Totales del período' })).toContainText(
      '1 día trabajado',
    )
    expect([...server.remote.values()].filter((r) => r.collection === 'entries')).toHaveLength(0)
    await first.setOffline(false)
    await expect
      .poll(() => [...server.remote.values()].filter((r) => r.collection === 'entries').length)
      .toBe(1)
    await b.getByRole('button', { name: 'Sincronizar ahora' }).click()
    await expect(status(b, 'Sincronizado')).toBeVisible()
    await period(b)
    await expect(b.getByRole('region', { name: 'Totales del período' })).toContainText(
      '1 día trabajado',
    )
    expect(server.leaked()).toBe(0)
  } finally {
    await first.close()
    await second.close()
  }
})

test('sincroniza: una clave incorrecta no se reintenta y se puede quitar', async ({ browser }) => {
  const server = createWorker()
  const context = await browser.newContext()
  try {
    await server.stub(context)
    const page = await context.newPage()
    await onboard(page)
    await more(page)
    await connect(page, '   ')
    await expect(
      page.getByRole('status').filter({ hasText: 'Escribí la clave de sincronización.' }),
    ).toBeVisible()
    expect(server.rejected() + server.authorized()).toBe(0)
    await connect(page, 'incorrecta')
    await expect(page.getByRole('alert')).toHaveText('La clave de sincronización no es válida.')
    await expect(status(page, 'Error')).toBeVisible()
    const attempts = server.rejected()
    expect(attempts).toBeGreaterThan(0)
    // Sin reintentos automáticos: el primer reintento con espera sería a 1 s.
    await page.waitForTimeout(2500)
    expect(server.rejected()).toBe(attempts)
    expect(server.authorized()).toBe(0)
    await page.getByRole('button', { name: 'Quitar clave' }).click()
    await expect(status(page, 'Solo local')).toBeVisible()
    await expect(page.getByLabel('Clave de sincronización')).toHaveValue('')
    await expect(page.getByRole('alert')).toHaveCount(0)
    expect(server.leaked()).toBe(0)
  } finally {
    await context.close()
  }
})
