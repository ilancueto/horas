import * as XLSX from 'xlsx'
import {
  addDays,
  dateRange,
  daysBetween,
  decimal,
  fmtDate,
  monthEnd,
  parseClock,
} from '../domain/dates'
import { chain, dayRows, decimalTotals, summarize } from '../domain/hours'
import { holidayId } from '../domain/holidays'
import {
  blankEntry,
  day,
  emptyLedger,
  leaveKinds,
  leaveLabels,
  ledgerSchema,
  periodId,
  type Entry,
  type Item,
  type LeaveKind,
  type Ledger,
  type Period,
  type Settings,
} from '../domain/model'

const value = (sheet: XLSX.WorkSheet, key: string): unknown =>
  sheet[key]?.t === 'e' ? undefined : sheet[key]?.v
const text = (sheet: XLSX.WorkSheet, key: string) => String(value(sheet, key) ?? '').trim()
const numeric = (sheet: XLSX.WorkSheet, key: string) => {
  const v = value(sheet, key)
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}
function date(value: unknown, date1904: boolean) {
  let candidate = ''
  if (typeof value === 'number' && Number.isFinite(value)) {
    const parsed = XLSX.SSF.parse_date_code(value, { date1904 })
    if (parsed)
      candidate = [
        parsed.y,
        String(parsed.m).padStart(2, '0'),
        String(parsed.d).padStart(2, '0'),
      ].join('-')
  }
  if (typeof value === 'string') {
    const parts = value.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
    candidate = parts
      ? parts[3] + '-' + parts[2].padStart(2, '0') + '-' + parts[1].padStart(2, '0')
      : value.trim()
  }
  return day.safeParse(candidate).success ? candidate : undefined
}
function time(value: unknown) {
  if (typeof value === 'number' && value >= 0 && value < 1) return Math.round(value * 1440) % 1440
  return typeof value === 'string' ? parseClock(value) : null
}
function leaveKindFromLabel(label: string): LeaveKind {
  const wanted = label.toLowerCase()
  return leaveKinds.find((k) => leaveLabels[k].label.toLowerCase() === wanted) ?? 'vacaciones'
}
type Comparison = { sheet: string; id: string; excel: (number | undefined)[]; calculated: number[] }
export type ExcelPreview = {
  ledger: Ledger
  annualLeave?: number
  warnings: string[]
  comparisons: Comparison[]
  imported: Ledger
}

export function mergeLedger(base: Ledger, incoming: Ledger): Ledger {
  function merge<T extends Item>(a: T[], b: T[], key: (r: T) => string) {
    const rows = new Map(a.map((r) => [key(r), r]))
    for (const row of b) {
      const current = rows.get(key(row))
      // Conserva la edición local de registros ya importados.
      if (!current) rows.set(key(row), row)
    }
    return [...rows.values()]
  }
  return {
    periods: chain([
      ...base.periods,
      ...incoming.periods.filter(
        (p) =>
          !base.periods.some((old) => old.id === p.id || old.from === p.from || old.to === p.to),
      ),
    ]),
    entries: merge(base.entries, incoming.entries, (e) => e.date),
    comps: merge(base.comps, incoming.comps, (c) => [c.earned, c.reason, c.taken].join('|')),
    leaves: merge(base.leaves, incoming.leaves, (l) => l.from + '|' + l.to + '|' + l.kind),
    holidays: merge(base.holidays, incoming.holidays, (h) => h.date),
  }
}

export function parseExcel(
  bytes: ArrayBuffer | Uint8Array,
  base: Ledger,
  settings: Settings,
): ExcelPreview {
  const book = XLSX.read(bytes, { sheetStubs: true })
  const date1904 = Boolean(book.Workbook?.WBProps?.date1904)
  const imported: Ledger = structuredClone(emptyLedger)
  const warnings: string[] = []
  const comparisons: Comparison[] = []
  if (!book.SheetNames.some((n) => /^Pago\b|^Compensatorio$|^Vacaciones$|^Feriados$/i.test(n)))
    throw new Error('No encontramos hojas de períodos, compensatorios, vacaciones ni feriados.')
  for (const name of book.SheetNames.filter((n) => /^Pago\b/i.test(n))) {
    const sheet = book.Sheets[name]
    const dateAt = (key: string) => date(value(sheet, key), date1904)
    const from = dateAt('B1')
    let to = dateAt('B2')
    if (!from) {
      if (to || text(sheet, 'B1')) warnings.push(name + ': no tiene una fecha Desde válida.')
      continue
    }
    const entries: Entry[] = []
    const limit =
      text(sheet, 'M1') === 'Horas v1' && sheet['!ref']
        ? Math.min(375, XLSX.utils.decode_range(sheet['!ref']).e.r + 1)
        : 39
    for (let i = 8; i <= limit; i++) {
      if (text(sheet, 'M1') === 'Horas v1' && value(sheet, 'L' + i) === false) continue
      const rawStart = value(sheet, 'C' + i),
        rawEnd = value(sheet, 'D' + i)
      const start = time(rawStart),
        end = time(rawEnd),
        notes = text(sheet, 'K' + i)
      const rawGuard = value(sheet, 'F' + i)
      const guard =
        rawGuard === true || rawGuard === 1 || /^(sí|si|true|x|verdadero)$/i.test(String(rawGuard))
      const customBreak = sheet['E' + i] && !sheet['E' + i].f ? numeric(sheet, 'E' + i) : undefined
      if (rawStart == null && rawEnd == null && !guard && !notes && customBreak === undefined)
        continue
      const entryDate = dateAt('A' + i) ?? addDays(from, i - 8)
      if (
        (rawStart != null && rawStart !== '' && start == null) ||
        (rawEnd != null && rawEnd !== '' && end == null)
      )
        warnings.push(name + ' fila ' + i + ': revisá el horario.')
      if (entryDate < from || (to && entryDate > to))
        warnings.push(name + ' fila ' + i + ': la carga queda fuera de las fechas originales.')
      const rawBreak = numeric(sheet, 'E' + i) ?? settings.breakMinutes
      entries.push({
        ...blankEntry(entryDate, settings),
        start: start ?? null,
        end: end ?? null,
        guard,
        notes,
        breakMinutes: Math.min(1440, Math.max(0, Math.round(rawBreak))),
      })
    }
    if (!to) {
      const expected = monthEnd(from).slice(0, 7) + '-' + String(settings.closing).padStart(2, '0')
      const suggested =
        expected >= addDays(from, 13) ? expected : addDays(monthEnd(from), settings.closing)
      const latest = entries
        .map((e) => e.date)
        .sort()
        .at(-1)
      to = latest && latest > suggested ? latest : suggested
      warnings.push(name + ': se propuso el cierre ' + fmtDate(to) + '. Podés editarlo después.')
    }
    if (to < from) {
      warnings.push(name + ': el cierre precede al inicio.')
      continue
    }
    const savedStatus = text(sheet, 'M2')
    const status: Period['status'] =
      savedStatus === 'Pagado' || savedStatus === 'Enviado a RRHH' ? savedStatus : 'Abierto'
    const stored = [1, 2, 3, 4].map((i) => numeric(sheet, 'E' + i))
    const [normal, extra, double, total] = stored
    const excel =
      normal !== undefined && extra !== undefined && double !== undefined && total !== undefined
        ? { normal, extra, double, total }
        : undefined
    const period: Period = { id: periodId(from), from, to, status, excel }
    imported.periods.push(period)
    imported.entries.push(...entries)
    comparisons.push({ sheet: name, id: period.id, excel: stored, calculated: [] })
  }
  for (const [type, start, end, col] of [
    ['comps', 6, 65, 'Motivo'],
    ['leaves', 6, 35, 'Notas'],
    ['holidays', 2, 301, 'Nombre'],
  ] as const) {
    const name = { comps: 'Compensatorio', leaves: 'Vacaciones', holidays: 'Feriados' }[type]
    const actual = book.SheetNames.find((n) => n.toLowerCase() === name.toLowerCase())
    if (!actual) continue
    const sheet = book.Sheets[actual]
    const limit =
      text(sheet, 'M1') === 'Horas v1' && sheet['!ref']
        ? XLSX.utils.decode_range(sheet['!ref']).e.r + 1
        : end
    for (let i = start; i <= limit; i++) {
      const a = date(value(sheet, 'A' + i), date1904)
      if (!a) {
        if (text(sheet, 'A' + i)) warnings.push(name + ' fila ' + i + ': fecha inválida.')
        continue
      }
      const id = crypto.randomUUID()
      if (type === 'comps') {
        const taken = date(value(sheet, 'D' + i), date1904) ?? null
        if (!taken && /^tomado$/i.test(text(sheet, 'C' + i)))
          warnings.push(name + ' fila ' + i + ': figura tomado sin fecha.')
        imported.comps.push({ id, earned: a, reason: text(sheet, 'B' + i), taken })
      } else if (type === 'leaves') {
        const to = date(value(sheet, 'B' + i), date1904)
        if (to && to >= a)
          imported.leaves.push({
            id,
            kind: leaveKindFromLabel(text(sheet, 'E' + i)),
            from: a,
            to,
            notes: text(sheet, 'D' + i),
          })
        else warnings.push(name + ' fila ' + i + ': revisá el fin del rango.')
      } else {
        const name = text(sheet, 'B' + i) || col
        const kind = text(sheet, 'C' + i)
        imported.holidays.push({
          id: holidayId(a),
          date: a,
          name,
          kind: kind === 'puente' || kind === 'no laborable' ? kind : 'feriado',
        })
      }
    }
  }
  const leaveSheet = book.SheetNames.find((n) => n.toLowerCase() === 'vacaciones')
  const raw = leaveSheet ? numeric(book.Sheets[leaveSheet], 'B1') : undefined
  const annualLeave = raw !== undefined && raw >= 0 && raw <= 366 ? Math.floor(raw) : undefined
  const ledger = ledgerSchema.parse(mergeLedger(base, imported))
  // El Excel redondea cada fila primero; se compara con su lista de feriados.
  const excelLedger = mergeLedger({ ...emptyLedger, holidays: imported.holidays }, imported)
  for (const comparison of comparisons) {
    const p = imported.periods.find((p) => p.id === comparison.id)!
    const rows = dayRows(p, excelLedger, settings, p.to)
    const reported = decimalTotals(rows, true)
    comparison.calculated = [reported.normal, reported.extra, reported.double, reported.total]
  }
  return { ledger, annualLeave, warnings, comparisons, imported }
}

export function buildWorkbook(ledger: Ledger, settings: Settings, now: string): XLSX.WorkBook {
  const book = XLSX.utils.book_new()
  const serial = (date: string) => daysBetween('1899-12-30', date)
  const make = (name: string, data: unknown[][]) => {
    const sheet = XLSX.utils.aoa_to_sheet(data)
    XLSX.utils.sheet_add_aoa(sheet, [['Horas v1']], { origin: 'M1' })
    sheet['!cols'] = [
      { wch: 15 },
      { wch: 15 },
      { wch: 12 },
      { wch: 14 },
      { wch: 12 },
      { wch: 11 },
      { wch: 12 },
      { wch: 12 },
      { wch: 12 },
      { wch: 12 },
      { wch: 34 },
    ]
    XLSX.utils.book_append_sheet(book, sheet, name, true)
    return sheet
  }
  for (const p of chain(ledger.periods)) {
    const rows = dayRows(p, ledger, settings, now)
    const totals = summarize(rows)
    const reported = decimalTotals(rows, true)
    const sheet = make(
      'Pago ' + fmtDate(p.to, { month: 'short', year: '2-digit' }).replaceAll('.', ''),
      [
        ['Desde', serial(p.from), null, 'Normales', reported.normal],
        ['Hasta', serial(p.to), null, '50%', reported.extra],
        ['Pago', serial(monthEnd(p.to)), null, '100%', reported.double],
        ['Días trabajados', totals.worked, null, 'Total', reported.total],
        ['Guardias', totals.guards],
        [],
        [
          'Fecha',
          'Día',
          'Entrada',
          'Salida',
          'Descanso',
          'Guardia',
          'Horas',
          'Normales',
          '50%',
          '100%',
          'Notas',
        ],
        ...rows.map((r) => [
          serial(r.date),
          r.vac
            ? 'Vac'
            : r.comp
              ? 'Comp'
              : r.holiday
                ? 'Fer'
                : fmtDate(r.date, { weekday: 'short' }),
          r.entry?.start != null ? r.entry.start / 1440 : null,
          r.entry?.end != null ? r.entry.end / 1440 : null,
          r.entry?.breakMinutes ?? settings.breakMinutes,
          r.entry?.guard ?? false,
          r.entry?.start != null && r.entry.end != null ? decimal(r.hours.total) : null,
          r.hours.normal ? decimal(r.hours.normal) : null,
          r.hours.extra ? decimal(r.hours.extra) : null,
          r.hours.double ? decimal(r.hours.double) : null,
          r.entry?.notes ?? '',
        ]),
      ],
    )
    XLSX.utils.sheet_add_aoa(sheet, [[p.status]], { origin: 'M2' })
    for (const address of ['B1', 'B2', 'B3']) sheet[address].z = 'dd/mm/yyyy'
    rows.forEach((_, index) => {
      const row = index + 8
      sheet['A' + row].z = 'dd/mm/yyyy'
      for (const col of ['C', 'D']) {
        const c = sheet[col + row]
        if (c) c.z = 'hh:mm'
      }
    })
    // Las filas sin actividad conservan el descanso de plantilla al reimportar.
    XLSX.utils.sheet_add_aoa(
      sheet,
      rows.map((r) => [Boolean(r.entry)]),
      { origin: 'L8' },
    )
  }
  make('Compensatorio', [
    ['Pendientes', ledger.comps.filter((c) => !c.taken).length],
    ['Tomados', ledger.comps.filter((c) => c.taken).length],
    [],
    [],
    ['Fecha', 'Motivo', 'Estado', 'Fecha tomado'],
    ...ledger.comps.map((c) => [
      fmtDate(c.earned),
      c.reason,
      c.taken ? 'Tomado' : 'Pendiente',
      c.taken ? fmtDate(c.taken) : null,
    ]),
  ])
  make('Vacaciones', [
    ['Días disponibles', settings.annualLeave],
    [],
    [],
    [],
    ['Desde', 'Hasta', 'Días', 'Notas', 'Tipo'],
    ...ledger.leaves.map((l) => [
      fmtDate(l.from),
      fmtDate(l.to),
      dateRange(l.from, l.to).length,
      l.notes,
      leaveLabels[l.kind].label,
    ]),
  ])
  make('Feriados', [
    ['Fecha', 'Nombre', 'Tipo'],
    ...ledger.holidays.map((h) => [fmtDate(h.date), h.name, h.kind]),
  ])
  return book
}

export function downloadExcel(ledger: Ledger, settings: Settings, now: string) {
  XLSX.writeFile(buildWorkbook(ledger, settings, now), 'Horas.xlsx')
}
