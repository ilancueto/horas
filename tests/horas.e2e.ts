import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import AxeBuilder from '@axe-core/playwright'

const workbook = 'Registro_de_horas_actualizado.xlsx'
const date = '2026-11-24'
async function setClock(page: Page) {
  await page.clock.setFixedTime(new Date(date + 'T15:00:00Z'))
}
async function start(page: Page) {
  await setClock(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Empezar de cero' }).click()
  await page.getByRole('button', { name: 'Continuar' }).click()
  await page.getByRole('button', { name: 'Guardar período' }).click()
  await expect(page.getByRole('heading', { name: 'Jornadas' })).toBeVisible()
}
const nav = (page: Page, name: string) =>
  page.getByRole('navigation').filter({ visible: true }).getByRole('button', { name, exact: true })
const close = (page: Page) =>
  page.getByRole('dialog').getByRole('button', { name: 'Cerrar', exact: true }).click()
const download = async (page: Page, label: string) => {
  const pending = page.waitForEvent('download')
  await page.getByRole('button', { name: label, exact: true }).click()
  return pending
}
async function capture(page: Page, info: TestInfo, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  )
  await page.screenshot({ path: info.outputPath(name + '.png'), animations: 'disabled' })
}
test('importa el Excel de referencia y lo vuelve a importar sin duplicar', async ({ page }) => {
  test.skip(!existsSync(workbook), 'La planilla original se guarda fuera de Git.')
  await setClock(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Importar mi Excel' }).click()
  await page.getByLabel('Planilla de registro').setInputFiles(workbook)
  await expect(page.getByText(/2 períodos · 49 jornadas con datos/)).toBeVisible()
  await expect(page.getByRole('row', { name: /Pago nov 26/ })).toContainText(
    '160 / 10,42 / 1 / 171,42',
  )
  await expect(page.getByRole('row', { name: /Pago dic 26/ })).toContainText(
    '40 / 9,66 / 13 / 62,66',
  )
  await page.getByRole('button', { name: 'Confirmar importación' }).click()
  await expect(page.getByRole('region', { name: 'Totales del período' })).toContainText('22,66 h')
  await expect(
    page.getByRole('combobox', { name: 'Seleccionar período' }).locator('option'),
  ).toHaveCount(2)
  await nav(page, 'Más').click()
  await page.getByRole('button', { name: 'Importar mi Excel' }).click()
  await page.getByLabel('Planilla de registro').setInputFiles(workbook)
  await page.getByRole('button', { name: 'Confirmar importación' }).click()
  await expect(
    page.getByRole('combobox', { name: 'Seleccionar período' }).locator('option'),
  ).toHaveCount(2)
})
test('carga jornadas, guardia y ausencias, descarga XLSX/PDF/JSON y restaura', async ({
  page,
}, info) => {
  const mobile = info.project.name === 'celular'
  await start(page)
  await page.getByRole('button', { name: 'Cargar hoy' }).click()
  await page.getByRole('button', { name: 'Horario estándar' }).click()
  await page.getByRole('dialog').getByLabel('Guardia').check()
  await page.getByRole('button', { name: 'Guardar jornada' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  if (mobile) {
    await page.getByRole('button', { name: 'Editar jornada ' + date }).click()
    await page.getByLabel('Salida', { exact: true }).fill('1720')
    await page.getByLabel('Notas', { exact: true }).fill('Prueba de jornada')
    await page.getByRole('button', { name: 'Guardar jornada' }).click()
  } else {
    await page.getByLabel('Salida ' + date).fill('1720')
    await page.getByLabel('Salida ' + date).press('Tab')
    await page.getByLabel('Notas ' + date).fill('Prueba de jornada')
    await page.getByLabel('Notas ' + date).press('Tab')
  }
  const totals = page.getByRole('region', { name: 'Totales del período' })
  await expect(totals).toContainText('Horas extra')
  await expect(totals).toContainText('0:35')
  await expect(totals).not.toContainText('Normales')
  await expect(totals).toContainText(/días? trabajados?/)
  await nav(page, 'Más').click()
  await page.getByRole('button', { name: 'Compensatorio', exact: true }).click()
  await page.getByRole('button', { name: 'Agregar compensatorio' }).click()
  await page.getByLabel('Fecha ganada').fill('2026-11-23')
  await page.getByLabel('Motivo').fill('Prueba de compensatorio')
  await page.getByLabel('Tomado', { exact: true }).check()
  await page.getByLabel('Fecha tomado').fill(date)
  await page.getByRole('button', { name: 'Guardar', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('ya tiene horas')
  await page.getByLabel('Fecha tomado').fill('2026-11-25')
  await page.getByRole('button', { name: 'Guardar', exact: true }).click()
  await expect(page.getByText('Prueba de compensatorio')).toBeVisible()
  await nav(page, 'Período').click()
  await expect(page.getByText('Comp', { exact: true }).filter({ visible: true })).toHaveCount(1)
  await nav(page, 'Más').click()
  await page.getByRole('button', { name: 'Vacaciones', exact: true }).click()
  await page.getByRole('button', { name: 'Agregar vacaciones' }).click()
  await page.getByLabel('Desde', { exact: true }).fill('2026-11-26')
  await page.getByLabel('Hasta', { exact: true }).fill('2026-11-27')
  await page.getByRole('button', { name: 'Guardar', exact: true }).click()
  await nav(page, 'Período').click()
  await expect(page.getByText('Vac', { exact: true }).filter({ visible: true })).toHaveCount(2)
  await page.getByRole('button', { name: 'Conciliar recibo' }).click()
  await page.getByLabel('Horas al 50% pagadas').fill('2')
  await expect(page.getByRole('dialog').getByRole('status')).toContainText('1,42')
  await page.getByRole('button', { name: 'Guardar conciliación' }).click()
  await page.getByRole('button', { name: 'Resumen para RRHH' }).click()
  const pdf = await download(page, 'PDF de extras')
  expect(
    readFileSync((await pdf.path())!)
      .subarray(0, 4)
      .toString(),
  ).toBe('%PDF')
  await close(page)
  await nav(page, 'Más').click()
  const xlsx = await download(page, 'Exportar XLSX')
  expect(
    readFileSync((await xlsx.path())!)
      .subarray(0, 2)
      .toString(),
  ).toBe('PK')
  const json = await download(page, 'Backup JSON')
  const path = (await json.path())!
  const snapshot = JSON.parse(readFileSync(path, 'utf8'))
  expect(snapshot.ledger.entries[0].guard).toBe(true)
  expect(snapshot.privateData).toBeUndefined()
  await page.getByLabel('Restaurar backup').setInputFiles({
    name: 'backup.json',
    mimeType: 'application/json',
    buffer: readFileSync(path),
  })
  await expect(page.getByRole('dialog', { name: 'Restaurar backup' })).toBeVisible()
  await download(page, 'Descargar backup y restaurar')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await nav(page, 'Período').click()
  await expect(page.getByRole('region', { name: 'Totales del período' })).toContainText(
    /días? trabajados?/,
  )
})
test('carga licencias por tipo', async ({ page }) => {
  await start(page)
  await nav(page, 'Más').click()
  await page.getByRole('button', { name: 'Licencias', exact: true }).click()
  await page.getByRole('button', { name: 'Agregar licencia' }).click()
  await page.getByLabel('Tipo', { exact: true }).selectOption({ label: 'Otra licencia' })
  await page.getByLabel('Desde', { exact: true }).fill('2026-11-26')
  await page.getByLabel('Hasta', { exact: true }).fill('2026-11-26')
  await page.getByLabel('Notas', { exact: true }).fill('')
  await page.getByRole('button', { name: 'Guardar', exact: true }).click()
  await expect(page.getByText('Contá el motivo en las notas.')).toBeVisible()
  await page.getByLabel('Notas', { exact: true }).fill('Trámite')
  await page.getByRole('button', { name: 'Guardar', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByText('Otra licencia', { exact: true })).toBeVisible()
  for (const theme of ['light', 'dark'] as const) {
    await nav(page, 'Más').click()
    await page.getByRole('button', { name: 'Ajustes', exact: true }).click()
    await page.getByLabel('Tema').selectOption(theme)
    await page.getByRole('button', { name: 'Guardar ajustes' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    await nav(page, 'Período').click()
    await expect(page.getByText('Lic', { exact: true }).filter({ visible: true })).toHaveCount(1)
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze()
    expect(result.violations.map((v) => [v.id, v.nodes.map((n) => n.target)])).toEqual([])
  }
})
test('muestra saldos de francos y vacaciones', async ({ page }) => {
  await start(page)
  await nav(page, 'Más').click()
  await page.getByRole('button', { name: 'Ajustes', exact: true }).click()
  await page.getByLabel('Fecha del saldo inicial').fill('2026-11-01')
  await page.getByLabel('Francos disponibles').fill('2')
  await page.getByLabel('Horas sobrantes al 100%').fill('08:00')
  await page.getByLabel('Horas sobrantes al 100%').press('Tab')
  await expect(page.getByText('Las horas sobrantes tienen que ser menos de 8:00.')).toBeVisible()
  await page.getByLabel('Horas sobrantes al 100%').fill('07:00')
  await page.getByLabel('Horas sobrantes al 100%').press('Tab')
  await page.getByRole('button', { name: 'Guardar ajustes' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await nav(page, 'Calendario').click()
  await page.getByRole('button', { name: '22/11/2026', exact: true }).click()
  await page.getByLabel('Entrada', { exact: true }).fill('0800')
  await page.getByLabel('Salida', { exact: true }).fill('1000')
  await page.getByLabel('Salida', { exact: true }).press('Tab')
  await page.getByLabel('Descanso (min)').fill('0')
  await page.getByRole('button', { name: 'Guardar jornada' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await nav(page, 'Saldos').click()
  const comps = page.getByRole('region', { name: 'Francos compensatorios' })
  await expect(comps).toContainText('3 disponibles')
  await expect(comps).toContainText('Ganados 1 · Tomados 0 · Saldo inicial 2')
  await expect(comps).toContainText('faltan 7:00')
  await expect(
    page.getByRole('progressbar', { name: 'Progreso hacia el próximo franco' }),
  ).toHaveAttribute('value', '60')
  await page.getByRole('button', { name: 'Registrar franco tomado' }).click()
  await expect(page.getByLabel('Tomado', { exact: true })).toBeChecked()
  await expect(page.getByLabel('Fecha ganada')).toHaveValue('2026-11-01')
  await page.getByLabel('Fecha tomado').fill('2026-11-23')
  await page.getByRole('button', { name: 'Guardar', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(comps).toContainText('2 disponibles')
  const leaves = page.getByRole('region', { name: 'Vacaciones 2026' })
  await expect(leaves.getByLabel('Año de vacaciones')).toHaveValue('2026')
  await expect(leaves.locator('.tile', { hasText: 'Saldo' })).toContainText('14')
  await page.getByRole('button', { name: 'Cargar saldo inicial' }).click()
  await expect(page.getByLabel('Francos disponibles')).toHaveValue('2')
  await close(page)
  await nav(page, 'Más').click()
  await page.getByRole('button', { name: 'Compensatorio', exact: true }).click()
  await page.getByRole('button', { name: 'Ver saldo' }).click()
  await expect(page.getByRole('heading', { name: 'Saldos', level: 1 })).toBeVisible()
})
test('instalabilidad, acceso directo y recarga de producción sin conexión', async ({
  page,
  context,
}) => {
  await start(page)
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready
    if (!navigator.serviceWorker.controller)
      await new Promise<void>((resolve) =>
        navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), {
          once: true,
        }),
      )
  })
  const manifest = await page.request.get('/manifest.webmanifest')
  expect((await manifest.json()).shortcuts[0].url).toBe('/?hoy=1')
  const cdp = await context.newCDPSession(page)
  const install = await cdp.send('Page.getInstallabilityErrors')
  expect(install.installabilityErrors).toEqual([])
  await context.setOffline(true)
  await page.goto('/?hoy=1')
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByRole('button', { name: 'Horario estándar' }).click()
  await page.getByRole('button', { name: 'Guardar jornada' }).click()
  await page.reload()
  await expect(page.getByRole('region', { name: 'Totales del período' })).toContainText(
    '1 día trabajado',
  )
  await nav(page, 'Más').click()
  expect((await download(page, 'Exportar XLSX')).suggestedFilename()).toBe('Horas.xlsx')
})
test('revisa pantallas a su ancho real en ambos temas y detecta problemas de accesibilidad', async ({
  page,
}, info) => {
  await setClock(page)
  await page.goto('/')
  await capture(page, info, 'bienvenida-claro')
  await page.getByRole('button', { name: 'Empezar de cero' }).click()
  await page.getByRole('button', { name: 'Continuar' }).click()
  await page.getByRole('button', { name: 'Guardar período' }).click()
  for (const theme of ['light', 'dark'] as const) {
    await nav(page, 'Más').click()
    await page.getByRole('button', { name: 'Ajustes', exact: true }).click()
    await page.getByLabel('Tema').selectOption(theme)
    await page.getByRole('button', { name: 'Guardar ajustes' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    await capture(page, info, 'mas-' + theme)
    await nav(page, 'Período').click()
    await capture(page, info, 'periodo-' + theme)
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze()
    expect(result.violations.map((v) => [v.id, v.nodes.map((n) => n.target)])).toEqual([])
    await page.getByRole('button', { name: 'Cargar hoy' }).click()
    await capture(page, info, 'hoy-' + theme)
    await close(page)
    await nav(page, 'Calendario').click()
    await capture(page, info, 'calendario-' + theme)
    await nav(page, info.project.name === 'celular' ? 'Resumen' : 'Resumen anual').click()
    await capture(page, info, 'anual-' + theme)
    await nav(page, 'Saldos').click()
    await expect(page.getByRole('heading', { name: 'Saldos', level: 1 })).toBeVisible()
    await expect(page.getByRole('progressbar')).toBeVisible()
    await capture(page, info, 'saldos-' + theme)
    const balances = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze()
    expect(balances.violations.map((v) => [v.id, v.nodes.map((n) => n.target)])).toEqual([])
    for (const [label, name] of [
      ['Compensatorio', 'comp'],
      ['Vacaciones', 'vac'],
      ['Licencias', 'licencias'],
      ['Feriados', 'feriados'],
    ]) {
      await nav(page, 'Más').click()
      await page.getByRole('button', { name: label, exact: true }).click()
      await capture(page, info, name + '-' + theme)
    }
  }
})
