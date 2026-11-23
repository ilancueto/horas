import { existsSync, readFileSync } from 'node:fs'
import * as XLSX from 'xlsx'
import { expect, it } from 'vitest'
import { defaults, emptyLedger, type LeaveKind, type Ledger } from '../domain/model'
import { buildWorkbook, parseExcel } from './excel'

const reference = 'Registro_de_horas_actualizado.xlsx'
it.skipIf(!existsSync(reference))(
  'lee las jornadas del libro real y reimporta sin duplicados',
  () => {
    const bytes = readFileSync(reference)
    const first = parseExcel(bytes, emptyLedger, defaults)
    expect(first.ledger.periods).toHaveLength(2)
    expect(first.ledger.entries).toHaveLength(49)
    expect(first.comparisons[0].excel.map((v) => Math.round((v ?? 0) * 100) / 100)).toEqual([
      160, 10.42, 1, 171.42,
    ])
    expect(first.comparisons[0].calculated).toEqual([160, 10.42, 1, 171.42])
    expect(first.comparisons[1].excel).toEqual([40, 9.66, 13, 62.66])
    expect(first.comparisons[1].calculated).toEqual([40, 9.66, 13, 62.66])
    const second = parseExcel(bytes, first.ledger, defaults)
    expect(second.ledger).toEqual(first.ledger)
  },
)

const leaves = (kinds: LeaveKind[]): Ledger => ({
  ...emptyLedger,
  leaves: kinds.map((kind, i) => ({
    id: crypto.randomUUID(),
    kind,
    from: '2026-03-0' + (i + 1),
    to: '2026-03-0' + (i + 1),
    notes: '',
  })),
})

it('exporta e importa el tipo de licencia', () => {
  const kinds: LeaveKind[] = ['vacaciones', 'enfermedad', 'otra']
  const book = buildWorkbook(leaves(kinds), defaults, '2026-04-01')
  const bytes = XLSX.write(book, { type: 'array', bookType: 'xlsx' })
  const out = parseExcel(bytes, emptyLedger, defaults)
  expect(out.ledger.leaves.map((l) => l.kind)).toEqual(kinds)
})

it('una planilla sin columna Tipo importa vacaciones', () => {
  const book = buildWorkbook(leaves(['enfermedad', 'otra']), defaults, '2026-04-01')
  const sheet = book.Sheets['Vacaciones']
  for (const key of Object.keys(sheet)) if (/^E\d+$/.test(key)) delete sheet[key]
  const bytes = XLSX.write(book, { type: 'array', bookType: 'xlsx' })
  const out = parseExcel(bytes, emptyLedger, defaults)
  expect(out.ledger.leaves.map((l) => l.kind)).toEqual(['vacaciones', 'vacaciones'])
})
