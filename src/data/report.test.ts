import { expect, it } from 'vitest'
import { dayRows } from '../domain/hours'
import { defaults, emptyLedger, type Period } from '../domain/model'
import { reportText } from './report'

it('el informe marca las licencias y las incluye en el detalle de jornadas', () => {
  const period: Period = {
    id: crypto.randomUUID(),
    from: '2026-11-01',
    to: '2026-11-30',
    status: 'Abierto',
  }
  const leaves = (
    [
      ['enfermedad', '2026-11-10'],
      ['mudanza', '2026-11-11'],
      ['otra', '2026-11-12'],
    ] as const
  ).map(([kind, date]) => ({
    id: crypto.randomUUID(),
    kind,
    from: date,
    to: date,
    notes: kind === 'otra' ? 'Trámite' : '',
  }))
  const rows = dayRows(period, { ...emptyLedger, leaves }, defaults, '2026-11-20')
  const text = reportText(period, rows, 'all')
  expect(text).toContain('  |  Lic. enfermedad')
  expect(text).toContain('  |  Lic. mudanza')
  expect(text).toContain('  |  Otra licencia')
  expect(text).not.toContain('  |  Vac')
  expect(reportText(period, rows, 'extra')).not.toContain('Lic. enfermedad')
})
