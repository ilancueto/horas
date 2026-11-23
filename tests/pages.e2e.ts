import { expect, test } from '@playwright/test'

// Prueba de humo del build de GitHub Pages (`npm run build:pages`, base `/horas/`), servido por
// `vite preview` en el proyecto `pages` de Playwright.
const base = '/horas/'

test('la app funciona bajo /horas/: service worker, manifest, sin conexión y atajo', async ({
  page,
  context,
}) => {
  await page.clock.setFixedTime(new Date('2026-11-24T15:00:00Z'))
  await page.goto(base)
  await page.getByRole('button', { name: 'Empezar de cero' }).click()
  await page.getByRole('button', { name: 'Continuar' }).click()
  await page.getByRole('button', { name: 'Guardar período' }).click()
  await expect(page.getByRole('heading', { name: 'Jornadas' })).toBeVisible()

  const scope = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready
    if (!navigator.serviceWorker.controller)
      await new Promise<void>((resolve) =>
        navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), {
          once: true,
        }),
      )
    return { scope: registration.scope, state: registration.active?.state }
  })
  expect(scope.state).toBe('activated')
  expect(new URL(scope.scope).pathname).toBe(base)

  const href = await page.locator('link[rel="manifest"]').getAttribute('href')
  expect(href).toBeTruthy()
  const manifestUrl = new URL(href!, page.url())
  expect(manifestUrl.pathname.startsWith(base)).toBe(true)
  const manifest = await page.request.get(manifestUrl.href)
  expect(manifest.ok()).toBe(true)
  const json = (await manifest.json()) as { scope: string; start_url: string; id: string }
  expect(json.scope).toBe(base)
  expect(json.start_url).toBe(base)
  expect(json.id).toBe(base)

  await context.setOffline(true)
  expect(new URL(page.url()).pathname).toBe(base)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Jornadas' })).toBeVisible()

  await page.goto(base + '?hoy=1')
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Horario estándar' })).toBeVisible()
  await context.setOffline(false)
})
