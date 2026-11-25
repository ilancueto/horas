import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import {
  createEncryption,
  seal,
  unlockEncryption,
  unseal,
  type Encryption,
} from '../src/data/crypto'

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
async function onboard(page: Page, closing?: number) {
  await page.clock.setFixedTime(new Date(date + 'T15:00:00Z'))
  await page.goto(address)
  await page.getByRole('button', { name: 'Empezar de cero' }).click()
  if (closing) await page.getByLabel('Día típico de cierre').fill(String(closing))
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

/**
 * Simula el Worker de Cloudflare: CORS, clave Bearer, lecturas paginadas, push con revisiones y
 * conversión de la nube cifrada (mismo contrato que el Worker).
 */
function createWorker() {
  const remote = new Map<string, Remote>()
  const revisions = new Set<string>()
  let version = 0
  let authorized = 0
  let rejected = 0
  let leaked = 0
  let pushes = 0
  let profiles = 0
  let encryption: Encryption | null = null
  // Mientras hay una retención, las respuestas autorizadas esperan (para probar concurrencia).
  let gate: Promise<void> | null = null
  const stamp = () =>
    new Date(Date.UTC(2026, 10, 24, 0, 0, ++version)).toISOString().replace('Z', '000Z')
  function hold() {
    let release = () => {}
    gate = new Promise<void>((resolve) => (release = resolve))
    return () => {
      gate = null
      release()
    }
  }
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
      if (gate) await gate
      if (req.method() === 'GET' && url.pathname === '/v1/profile') {
        profiles++
        await route.fulfill({ json: { encryption }, headers })
        return
      }
      if (req.method() === 'POST' && url.pathname === '/v1/decryption') {
        if (encryption) {
          let key: CryptoKey
          try {
            key = await unlockEncryption(req.postDataJSON().phrase, encryption)
          } catch {
            await route.fulfill({ status: 422, headers })
            return
          }
          for (const [id, row] of remote) {
            if (row.deleted_at) continue
            const data = await unseal(
              key,
              row.data,
              [row.collection, row.id, row.revision].join('|'),
            )
            remote.set(id, { ...row, data })
          }
          encryption = null
        }
        await route.fulfill({ status: 204, headers })
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
        pushes++
        const { changes } = req.postDataJSON() as { changes: RecordPacket[] }
        for (const change of changes) {
          if (revisions.has(change.revision)) continue
          revisions.add(change.revision)
          const updated_at = stamp()
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
    pushes: () => pushes,
    profiles: () => profiles,
    encrypted: () => encryption !== null,
    async seedEncryption(phrase: string) {
      const { key, config } = await createEncryption(phrase)
      for (const [id, row] of remote) {
        if (row.deleted_at) continue
        const data = await seal(key, row.data, [row.collection, row.id, row.revision].join('|'))
        remote.set(id, { ...row, data })
      }
      encryption = config
    },
    hold,
  }
}

/** Escribe un valor en el meta de IndexedDB (`horas`) sin pasar por la app. */
async function seedMeta(page: Page, key: string, value: unknown) {
  await page.evaluate(
    ([key, value]) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('horas')
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
          const idb = open.result
          const tx = idb.transaction('meta', 'readwrite')
          tx.objectStore('meta').put({ key, value })
          tx.oncomplete = () => {
            idb.close()
            resolve()
          }
          tx.onerror = () => reject(tx.error)
        }
      }),
    [key, value] as const,
  )
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
      await expect(
        p.locator('.topbar').getByText('Sincronizado', { exact: true }).filter({ visible: true }),
      ).toHaveCount(1)
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

test('sincroniza: datos vinculados a otro servidor no se suben', async ({ browser }) => {
  const server = createWorker()
  const context = await browser.newContext()
  try {
    await server.stub(context)
    const page = await context.newPage()
    await onboard(page)
    await seedMeta(page, 'syncOwner', 'https://otro.example')
    await more(page)
    await expect(status(page, 'Solo local')).toBeVisible()
    await connect(page, secret)
    await expect(
      page
        .getByText('Estos datos locales están vinculados a otro servidor de sincronización.')
        .filter({ visible: true }),
    ).toBeVisible()
    await expect(status(page, 'Error')).toBeVisible()
    // Sin reintentos en segundo plano que suban algo.
    await page.waitForTimeout(1500)
    expect(server.pushes()).toBe(0)
    expect(server.remote.size).toBe(0)
    expect(server.leaked()).toBe(0)
  } finally {
    await context.close()
  }
})

const welcome = (page: Page) => page.getByRole('heading', { name: 'Tus horas, en orden.' })
async function axe(page: Page) {
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze()
    expect(result.violations.map((v) => [v.id, v.nodes.map((n) => n.target)])).toEqual([])
  }
  await page.emulateMedia({ colorScheme: null })
}
/** Abre la app en un perfil nuevo y conecta desde la bienvenida con "Ya tengo mis datos en la nube". */
async function join(page: Page, key: string) {
  await page.clock.setFixedTime(new Date(date + 'T15:00:00Z'))
  await page.goto(address)
  await page.getByRole('button', { name: 'Ya tengo mis datos en la nube' }).click()
  const dialog = page.getByRole('dialog', { name: 'Conectar con mi nube' })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('Clave de sincronización').fill(key)
  await dialog.getByRole('button', { name: 'Conectar', exact: true }).click()
  return dialog
}
const storedKey = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<unknown>((resolve, reject) => {
        const open = indexedDB.open('horas')
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
          const idb = open.result
          const get = idb.transaction('meta').objectStore('meta').get('syncKey')
          get.onsuccess = () => {
            idb.close()
            resolve((get.result as { value?: unknown } | undefined)?.value ?? null)
          }
          get.onerror = () => reject(get.error)
        }
      }),
  )

test('vincula: un perfil nuevo entra con la clave o con el enlace y baja los datos', async ({
  browser,
}) => {
  const server = createWorker()
  const first = await browser.newContext(),
    second = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] }),
    third = await browser.newContext(),
    fourth = await browser.newContext()
  try {
    for (const context of [first, second, third, fourth]) await server.stub(context)
    const a = await first.newPage()
    // A configura un cierre distinto del de fábrica: las reglas viajan a la nube.
    await onboard(a, 20)
    await more(a)
    await connect(a, secret)
    await expect(status(a, 'Sincronizado')).toBeVisible()
    await period(a)
    await a.getByRole('button', { name: 'Cargar hoy' }).click()
    await a.getByRole('button', { name: 'Horario estándar' }).click()
    await a.getByRole('button', { name: 'Guardar jornada' }).click()
    await expect
      .poll(() => [...server.remote.values()].filter((r) => r.collection === 'entries').length)
      .toBe(1)
    const remotePeriods = () =>
      [...server.remote.values()].filter((r) => r.collection === 'periods' && !r.deleted_at)
    const rules = () =>
      [...server.remote.values()].find((r) => r.collection === 'rules')?.data as
        { closing: number } | undefined
    expect(remotePeriods()).toHaveLength(1)
    expect(rules()?.closing).toBe(20)
    const pushes = server.pushes()

    // (1) Bienvenida → "Ya tengo mis datos en la nube" → clave → entra con los datos de A.
    const b = await second.newPage()
    await b.clock.setFixedTime(new Date(date + 'T15:00:00Z'))
    await b.goto(address)
    await b.getByRole('button', { name: 'Ya tengo mis datos en la nube' }).click()
    const dialog = b.getByRole('dialog', { name: 'Conectar con mi nube' })
    await expect(dialog).toBeVisible()
    await axe(b)
    await dialog.getByRole('button', { name: 'Conectar', exact: true }).click()
    await expect(dialog.getByRole('alert')).toHaveText('Escribí la clave de sincronización.')
    await dialog.getByLabel('Clave de sincronización').fill('  ' + secret + '  ')
    await dialog.getByRole('button', { name: 'Conectar', exact: true }).click()
    await expect(b.getByRole('heading', { name: 'Jornadas' })).toBeVisible()
    await expect(b.getByRole('region', { name: 'Totales del período' })).toContainText(
      '1 día trabajado',
    )
    await more(b)
    await expect(status(b, 'Sincronizado')).toBeVisible()
    // B no subió nada: ni un período vacío ni las reglas de fábrica.
    expect(server.pushes()).toBe(pushes)
    expect(remotePeriods()).toHaveLength(1)
    expect(rules()?.closing).toBe(20)
    await b.getByRole('button', { name: 'Ajustes', exact: true }).click()
    await expect(b.getByLabel('Día típico de cierre')).toHaveValue('20')
    await b.getByRole('dialog').getByRole('button', { name: 'Cerrar', exact: true }).click()

    // (4) Panel: el enlace contiene la clave y el QR se muestra; al ocultarlo desaparece.
    expect(await b.content()).not.toContain(secret)
    await b.getByRole('button', { name: 'Vincular otro dispositivo' }).click()
    await expect(b.getByRole('heading', { name: 'Vincular otro dispositivo' })).toBeFocused()
    const link = b.getByLabel('Enlace para vincular')
    await expect(link).toHaveValue(address + '/#clave=' + secret)
    const qr = b.getByRole('img', { name: 'Código QR para vincular otro dispositivo' })
    await expect(qr).toBeVisible()
    await expect(
      b.getByText(
        'Este enlace contiene tu clave. Usalo solo en tus dispositivos y borrá el mensaje y la entrada del historial después.',
      ),
    ).toBeVisible()
    await axe(b)
    await b.getByRole('button', { name: 'Copiar enlace' }).click()
    await expect(b.getByText('Enlace copiado.')).toBeVisible()
    expect(await b.evaluate(() => navigator.clipboard.readText())).toBe(
      address + '/#clave=' + secret,
    )
    await b.getByRole('button', { name: 'Ocultar enlace' }).click()
    await expect(b.getByRole('button', { name: 'Vincular otro dispositivo' })).toBeFocused()
    await expect(link).toHaveCount(0)
    await expect(qr).toHaveCount(0)
    expect(await b.content()).not.toContain(secret)

    // (3) Perfil nuevo abierto con #clave=… entra solo y el fragmento desaparece.
    const c = await third.newPage()
    await c.clock.setFixedTime(new Date(date + 'T15:00:00Z'))
    await c.goto(address + '/#clave=' + encodeURIComponent(secret))
    await expect(c.getByRole('heading', { name: 'Jornadas' })).toBeVisible()
    await expect(c.getByText('Dispositivo conectado.', { exact: true })).toBeVisible()
    expect(await c.evaluate(() => location.hash)).toBe('')
    expect(c.url()).toBe(address + '/')
    await expect(c.getByRole('region', { name: 'Totales del período' })).toContainText(
      '1 día trabajado',
    )
    expect(server.pushes()).toBe(pushes)
    expect(remotePeriods()).toHaveLength(1)

    // Con PIN: el fragmento se borra antes de desbloquear y la clave se aplica después.
    const d = await fourth.newPage()
    await onboard(d)
    await more(d)
    await d.getByRole('button', { name: 'Ajustes', exact: true }).click()
    await d.getByLabel('Activar PIN (4 a 8 dígitos)').fill('2468')
    await d.getByRole('button', { name: 'Guardar ajustes' }).click()
    await expect(d.getByRole('dialog')).toHaveCount(0)
    await d.goto('about:blank')
    const calls = server.authorized() + server.rejected()
    await d.goto(address + '/#clave=' + encodeURIComponent(secret))
    await expect(d.getByRole('heading', { name: 'Ingresá tu PIN' })).toBeVisible()
    expect(await d.evaluate(() => location.hash)).toBe('')
    await d.waitForTimeout(500)
    expect(server.authorized() + server.rejected()).toBe(calls)
    await d.getByLabel('PIN', { exact: true }).fill('2468')
    await d.getByRole('button', { name: 'Desbloquear' }).click()
    await expect(d.getByText('Dispositivo conectado. Revisá la fusión de datos.')).toBeVisible()
    // Ya tenía datos propios: se ofrece fusionar como siempre.
    await expect(d.getByRole('dialog', { name: 'Fusionar datos' })).toBeVisible()
    expect(await storedKey(d)).toBe(secret)

    // Un dispositivo que ya tiene clave ignora el enlace.
    await a.goto(address + '/#clave=otra-clave')
    await expect(a.getByText('Este dispositivo ya está conectado.')).toBeVisible()
    expect(await a.evaluate(() => location.hash)).toBe('')
    expect(await storedKey(a)).toBe(secret)
    expect(server.leaked()).toBe(0)
  } finally {
    await first.close()
    await second.close()
    await third.close()
    await fourth.close()
  }
})

test('vincula: clave incorrecta o nube vacía no configuran el dispositivo', async ({ browser }) => {
  const server = createWorker()
  const context = await browser.newContext()
  try {
    await server.stub(context)
    const page = await context.newPage()
    const dialog = await join(page, 'incorrecta')
    await expect(dialog.getByRole('alert')).toHaveText('La clave de sincronización no es válida.')
    expect(await storedKey(page)).toBeNull()
    await dialog.getByRole('button', { name: 'Cerrar' }).click()
    await expect(welcome(page)).toBeVisible()
    await page.reload()
    await expect(welcome(page)).toBeVisible()

    // Nube vacía: avisa, no marca nada y no deja la clave guardada.
    const empty = await join(page, secret)
    await expect(empty.getByRole('alert')).toHaveText(
      'No encontramos datos en la nube con esa clave. Podés empezar de cero.',
    )
    expect(await storedKey(page)).toBeNull()
    expect(server.pushes()).toBe(0)
    expect(server.remote.size).toBe(0)
    await page.reload()
    await expect(welcome(page)).toBeVisible()

    // Enlace con clave incorrecta: avisa y sigue en la bienvenida, sin la clave en la URL.
    await page.goto(address + '/#clave=incorrecta')
    await expect(page.getByText('La clave de sincronización no es válida.')).toBeVisible()
    expect(await page.evaluate(() => location.hash)).toBe('')
    await expect(welcome(page)).toBeVisible()
    expect(await storedKey(page)).toBeNull()
    expect(server.leaked()).toBe(0)
  } finally {
    await context.close()
  }
})

/** A se conecta con la clave, carga una jornada y espera a que la nube la tenga. */
async function seedCloud(page: Page, server: ReturnType<typeof createWorker>) {
  await onboard(page)
  await more(page)
  await connect(page, secret)
  await expect(status(page, 'Sincronizado')).toBeVisible()
  await period(page)
  await page.getByRole('button', { name: 'Cargar hoy' }).click()
  await page.getByRole('button', { name: 'Horario estándar' }).click()
  await page.getByRole('button', { name: 'Guardar jornada' }).click()
  await expect
    .poll(() => [...server.remote.values()].filter((r) => r.collection === 'entries').length)
    .toBe(1)
}
const periodsIn = (server: ReturnType<typeof createWorker>) =>
  [...server.remote.values()].filter((r) => r.collection === 'periods' && !r.deleted_at).length

test('vincula: una sola conexión a la vez (enlace con el diálogo abierto y doble envío)', async ({
  browser,
}) => {
  const server = createWorker()
  const seed = await browser.newContext()
  const contexts = [
    await browser.newContext(),
    await browser.newContext(),
    await browser.newContext(),
  ]
  try {
    await server.stub(seed)
    for (const context of contexts) await server.stub(context)
    await seedCloud(await seed.newPage(), server)
    // Sin A en línea, cada pedido de perfil es de la conexión que se prueba.
    await seed.close()
    const pushes = server.pushes()

    // Un enlace llega con el diálogo abierto: comparten la misma conexión.
    const page = await contexts[0].newPage()
    await page.clock.setFixedTime(new Date(date + 'T15:00:00Z'))
    await page.goto(address)
    await page.getByRole('button', { name: 'Ya tengo mis datos en la nube' }).click()
    const dialog = page.getByRole('dialog', { name: 'Conectar con mi nube' })
    await dialog.getByLabel('Clave de sincronización').fill(secret)
    let release = server.hold()
    let before = server.profiles()
    await page.evaluate((key) => {
      location.hash = '#clave=' + encodeURIComponent(key)
    }, secret)
    await expect(dialog.getByRole('status')).toHaveText('Conectando con tu nube…')
    await expect(dialog.getByRole('button', { name: 'Conectar', exact: true })).toBeDisabled()
    await expect(dialog.getByRole('button', { name: 'Cerrar' })).toBeDisabled()
    expect(await page.evaluate(() => location.hash)).toBe('')
    // Enviar el formulario igual (por ejemplo, con Enter) comparte la conexión en curso.
    await dialog.locator('form').evaluate((form: HTMLFormElement) => form.requestSubmit())
    release()
    await expect(page.getByRole('heading', { name: 'Jornadas' })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Totales del período' })).toContainText(
      '1 día trabajado',
    )
    expect(server.profiles() - before).toBe(1)

    // Doble envío del diálogo: un solo ciclo.
    const twice = await contexts[1].newPage()
    await twice.clock.setFixedTime(new Date(date + 'T15:00:00Z'))
    await twice.goto(address)
    await twice.getByRole('button', { name: 'Ya tengo mis datos en la nube' }).click()
    const form = twice.getByRole('dialog', { name: 'Conectar con mi nube' })
    await form.getByLabel('Clave de sincronización').fill(secret)
    release = server.hold()
    before = server.profiles()
    await form.locator('form').evaluate((element: HTMLFormElement) => {
      element.requestSubmit()
      element.requestSubmit()
    })
    await expect(form.getByRole('status')).toHaveText('Conectando con tu nube…')
    release()
    await expect(twice.getByRole('heading', { name: 'Jornadas' })).toBeVisible()
    expect(server.profiles() - before).toBe(1)

    // Enlace en la bienvenida: el aviso "Conectando…" queda fijo mientras dura la conexión.
    const linked = await contexts[2].newPage()
    await linked.clock.setFixedTime(new Date(date + 'T15:00:00Z'))
    release = server.hold()
    await linked.goto(address + '/#clave=' + encodeURIComponent(secret))
    const progress = linked.getByRole('status').filter({ hasText: 'Conectando con tu nube…' })
    await expect(progress).toBeVisible()
    await expect(
      linked.getByRole('button', { name: 'Ya tengo mis datos en la nube' }),
    ).toBeDisabled()
    await linked.waitForTimeout(6500)
    await expect(progress).toBeVisible()
    release()
    await expect(linked.getByRole('heading', { name: 'Jornadas' })).toBeVisible()
    expect(server.pushes()).toBe(pushes)
    expect(periodsIn(server)).toBe(1)
    expect(server.leaked()).toBe(0)
  } finally {
    for (const context of contexts) await context.close()
    await seed.close().catch(() => undefined)
  }
})

test('vincula: con la nube cifrada pide la frase de paso antes de entrar', async ({ browser }) => {
  const server = createWorker()
  const phrase = 'una frase de paso larga'
  const first = await browser.newContext(),
    second = await browser.newContext(),
    third = await browser.newContext()
  try {
    for (const context of [first, second, third]) await server.stub(context)
    const a = await first.newPage()
    await seedCloud(a, server)
    await server.seedEncryption(phrase)
    await a.reload()
    await more(a)
    await expect(status(a, 'Nube bloqueada')).toBeVisible()
    const pushes = server.pushes()

    // Bienvenida: la clave abre el paso de la frase de paso sin marcar nada.
    const b = await second.newPage()
    const dialog = await join(b, secret)
    await expect(
      dialog.getByText('Tu nube tiene cifrado. Escribí tu frase de paso para bajar tus datos.'),
    ).toBeVisible()
    await axe(b)
    expect(await storedKey(b)).toBe(secret)
    await dialog.getByLabel('Frase de paso').fill('otra frase que no es')
    await dialog.getByRole('button', { name: 'Desbloquear' }).click()
    await expect(dialog.getByRole('alert')).toHaveText('La frase no coincide. Probá de nuevo.')
    await expect(dialog).toBeVisible()
    await dialog.getByLabel('Frase de paso').fill(phrase)
    await dialog.getByRole('button', { name: 'Desbloquear' }).click()
    await expect(b.getByRole('heading', { name: 'Jornadas' })).toBeVisible()
    await expect(b.getByRole('region', { name: 'Totales del período' })).toContainText(
      '1 día trabajado',
    )
    expect(server.pushes()).toBe(pushes)
    expect(periodsIn(server)).toBe(1)

    // Enlace en un perfil nuevo: la bienvenida queda en el paso de la frase; cancelar limpia.
    const c = await third.newPage()
    await c.clock.setFixedTime(new Date(date + 'T15:00:00Z'))
    await c.goto(address + '/#clave=' + encodeURIComponent(secret))
    const locked = c.getByRole('dialog', { name: 'Conectar con mi nube' })
    await expect(
      locked.getByText('Tu nube tiene cifrado. Escribí tu frase de paso para bajar tus datos.'),
    ).toBeVisible()
    expect(await c.evaluate(() => location.hash)).toBe('')
    expect(await storedKey(c)).toBe(secret)
    await locked.getByRole('button', { name: 'Cancelar' }).click()
    await expect(locked).toHaveCount(0)
    await expect(welcome(c)).toBeVisible()
    expect(await storedKey(c)).toBeNull()
    await expect(c.getByRole('button', { name: 'Empezar de cero' })).toBeEnabled()

    // Una clave que quedó guardada sin terminar (se recargó en el paso de la frase).
    await c.goto(address + '/#clave=' + encodeURIComponent(secret))
    await expect(locked.getByLabel('Frase de paso')).toBeVisible()
    await c.reload()
    const leftover = c.getByText('Quedó una clave guardada que no terminó de conectar.')
    await expect(leftover).toBeVisible()
    for (const name of ['Importar mi Excel', 'Empezar de cero', 'Ya tengo mis datos en la nube'])
      await expect(c.getByRole('button', { name })).toBeDisabled()
    // Reintentar vuelve al paso de la frase de paso.
    await c.getByRole('button', { name: 'Reintentar' }).click()
    await expect(locked.getByLabel('Frase de paso')).toBeVisible()
    await c.reload()
    await expect(leftover).toBeVisible()
    await c.getByRole('button', { name: 'Cancelar' }).click()
    await expect(leftover).toHaveCount(0)
    expect(await storedKey(c)).toBeNull()
    for (const name of ['Importar mi Excel', 'Empezar de cero', 'Ya tengo mis datos en la nube'])
      await expect(c.getByRole('button', { name })).toBeEnabled()
    expect(server.pushes()).toBe(pushes)
    expect(server.leaked()).toBe(0)

    await a.getByLabel('Frase de paso', { exact: true }).fill('otra frase que no es')
    await a.getByRole('button', { name: 'Desactivar cifrado' }).click()
    await expect(a.getByText('La frase no coincide. Probá de nuevo.')).toBeVisible()
    expect(server.encrypted()).toBe(true)
    await a.getByLabel('Frase de paso', { exact: true }).fill(phrase)
    await a.getByRole('button', { name: 'Desactivar cifrado' }).click()
    await expect(status(a, 'Sincronizado')).toBeVisible()
    expect(server.encrypted()).toBe(false)
    await a.reload()
    await more(a)
    await expect(status(a, 'Sincronizado')).toBeVisible()
    await expect(a.getByLabel('Frase de paso', { exact: true })).toHaveCount(0)
    await period(a)
    await expect(a.getByRole('region', { name: 'Totales del período' })).toContainText(
      '1 día trabajado',
    )
  } finally {
    await first.close()
    await second.close()
    await third.close()
  }
})

test('vincula: si la nube no responde a tiempo, deshace y vuelve a la bienvenida', async ({
  browser,
}) => {
  const server = createWorker()
  const context = await browser.newContext()
  let release = () => {}
  try {
    await server.stub(context)
    const page = await context.newPage()
    // Espera corta solo para la prueba (la app espera 60 s).
    await page.addInitScript(() => {
      ;(window as { __horasConnectTimeout?: number }).__horasConnectTimeout = 1500
    })
    await page.clock.setFixedTime(new Date(date + 'T15:00:00Z'))
    release = server.hold()
    await page.goto(address + '/#clave=' + encodeURIComponent(secret))
    await expect(
      page.getByRole('status').filter({ hasText: 'Conectando con tu nube…' }),
    ).toBeVisible()
    for (const name of ['Importar mi Excel', 'Empezar de cero', 'Ya tengo mis datos en la nube'])
      await expect(page.getByRole('button', { name })).toBeDisabled()
    await expect(
      page.getByText('No pudimos conectar. Revisá la conexión y probá de nuevo.'),
    ).toBeVisible()
    expect(await storedKey(page)).toBeNull()
    for (const name of ['Importar mi Excel', 'Empezar de cero', 'Ya tengo mis datos en la nube'])
      await expect(page.getByRole('button', { name })).toBeEnabled()
    // Lo que estaba retenido termina tarde: no vuelve a vincular ni sube nada.
    release()
    await page.waitForTimeout(1000)
    expect(await storedKey(page)).toBeNull()
    expect(
      await page.evaluate(
        () =>
          new Promise<unknown>((resolve, reject) => {
            const open = indexedDB.open('horas')
            open.onerror = () => reject(open.error)
            open.onsuccess = () => {
              const get = open.result.transaction('meta').objectStore('meta').get('syncOwner')
              get.onsuccess = () => {
                open.result.close()
                resolve((get.result as { value?: unknown } | undefined)?.value ?? '')
              }
            }
          }),
      ),
    ).not.toBe(worker)
    await expect(welcome(page)).toBeVisible()
    expect(server.pushes()).toBe(0)
    expect(server.leaked()).toBe(0)
  } finally {
    release()
    await context.close()
  }
})
