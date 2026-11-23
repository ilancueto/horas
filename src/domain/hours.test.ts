import { describe, expect, it } from 'vitest'
import { addDays, decimal, monthEnd } from './dates'
import {
  calculate,
  chain,
  compBalance,
  dayRows,
  leaveBalance,
  overlapsLeave,
  summarize,
  yearStats,
} from './hours'
import {
  blankEntry,
  defaults,
  emptyLedger,
  leaveSchema,
  rulesId,
  rulesRecordSchema,
  settingsSchema,
  type Holiday,
  type LeaveKind,
  type Period,
} from './model'

describe('horas por franja', () => {
  const fri = '2026-10-16',
    sat = '2026-10-17',
    sun = '2026-10-18'
  const holiday: Holiday = {
    id: crypto.randomUUID(),
    date: '2026-10-20',
    name: 'Prueba',
    kind: 'feriado',
  }
  it.each([
    [fri, 465, 1005, 60, 8, 0, 0],
    [fri, 465, 1040, 60, 8, 0.58, 0],
    ['2026-10-19', 465, 1125, 60, 8, 2, 0],
    [sat, 465, 900, 60, 0, 4.25, 2],
    [sat, 450, 1020, 60, 0, 4.5, 4],
    [sun, 480, 720, 60, 0, 0, 3],
    [sun, 480, 840, 60, 0, 0, 5],
    [holiday.date, 480, 720, 60, 0, 0, 3],
    [sat, 1320, 360, 60, 0, 0, 7],
    [fri, 1320, 360, 60, 0, 7, 0],
    [fri, 465, 510, 60, 0, 0, 0],
    [fri, 960, 1080, 90, 0, 0.5, 0],
  ])('%s %i–%i, descanso %i', (date, start, end, breakMinutes, normal, extra, double) => {
    const h = calculate(
      { ...blankEntry(date, defaults), start, end, breakMinutes },
      defaults,
      new Map([[holiday.date, holiday]]),
    )
    expect([decimal(h.normal), decimal(h.extra), decimal(h.double)]).toEqual([
      normal,
      extra,
      double,
    ])
    expect(h.total).toBe(h.normal + h.extra + h.double)
  })
  it('no suma un turno incompleto', () => {
    expect(calculate({ ...blankEntry(fri, defaults), start: 465 }, defaults, new Map()).total).toBe(
      0,
    )
  })
})
it('encadena los períodos y determina la fecha de pago', () => {
  const periods: Period[] = [
    ['2026-10-15', '2026-11-12'],
    ['2026-11-13', '2026-12-14'],
    ['2026-12-15', '2027-01-14'],
  ].map(([from, to]) => ({ id: crypto.randomUUID(), from, to, status: 'Abierto' }))
  expect(monthEnd(periods[0].to)).toBe('2026-11-30')
  periods[0].to = '2026-11-15'
  periods[1].to = '2026-12-17'
  expect(chain(periods).map((p) => p.from)).toEqual(['2026-10-15', '2026-11-16', '2026-12-18'])
})
it('marca ausencias, calcula saldo y agrupa guardias consecutivas', () => {
  const from = '2026-10-15',
    to = '2026-10-20'
  const leaves = [
    {
      id: crypto.randomUUID(),
      kind: 'vacaciones' as const,
      from: addDays(from, 2),
      to: addDays(from, 3),
      notes: '',
    },
  ]
  const entries = [0, 1, 4].map((i) => ({ ...blankEntry(addDays(from, i), defaults), guard: true }))
  const comps = [{ id: crypto.randomUUID(), earned: from, reason: '', taken: to }]
  const rows = dayRows({ from, to }, { ...emptyLedger, leaves, entries, comps }, defaults, to)
  expect(rows[2].tone).toBe('vac')
  expect(rows.at(-1)?.tone).toBe('comp')
  expect(summarize(rows).blocks).toBe(2)
  expect(overlapsLeave(leaves, { ...leaves[0], id: crypto.randomUUID() })).toBe(true)
  expect(leaveBalance(leaves, '2026', 14)).toEqual({ used: 2, remaining: 12 })
})
it('lee licencias sin tipo como vacaciones', () => {
  const leave = leaveSchema.parse({
    id: crypto.randomUUID(),
    from: '2026-11-02',
    to: '2026-11-03',
    notes: '',
  })
  expect(leave.kind).toBe('vacaciones')
})
it('el saldo de vacaciones ignora otras licencias', () => {
  const leaves = [
    {
      id: crypto.randomUUID(),
      kind: 'vacaciones' as const,
      from: '2026-11-02',
      to: '2026-11-03',
      notes: '',
    },
    {
      id: crypto.randomUUID(),
      kind: 'enfermedad' as const,
      from: '2026-11-09',
      to: '2026-11-11',
      notes: '',
    },
  ]
  expect(leaveBalance(leaves, '2026', 14)).toEqual({ used: 2, remaining: 12 })
})
it('una licencia marca el día y no lo deja pendiente', () => {
  const leaves = [
    {
      id: crypto.randomUUID(),
      kind: 'mudanza' as const,
      from: '2026-11-10',
      to: '2026-11-10',
      notes: '',
    },
    {
      id: crypto.randomUUID(),
      kind: 'vacaciones' as const,
      from: '2026-11-12',
      to: '2026-11-12',
      notes: '',
    },
  ]
  const rows = dayRows(
    { from: '2026-11-01', to: '2026-11-30' },
    { ...emptyLedger, leaves },
    defaults,
    '2026-11-20',
  )
  const mud = rows.find((r) => r.date === '2026-11-10')!
  expect(mud.leave).toBe('mudanza')
  expect(mud.vac).toBe(false)
  expect(mud.tone).toBe('lic')
  expect(mud.pending).toBe(false)
  const vac = rows.find((r) => r.date === '2026-11-12')!
  expect(vac.tone).toBe('vac')
  expect(vac.vac).toBe(true)
})

describe('saldo de francos', () => {
  const rules = { ...defaults, breakMinutes: 0 }
  const shift = (date: string, start: number, end: number) => ({
    ...blankEntry(date, rules),
    start,
    end,
  })
  const comp = (taken: string | null) => ({
    id: crypto.randomUUID(),
    earned: '2026-10-01',
    reason: '',
    taken,
  })
  const now = '2026-11-22'
  it('cuenta francos por cada 8 h al 100% sin saldo inicial', () => {
    const entries = [
      shift('2026-11-15', 480, 960),
      shift('2026-11-01', 480, 960),
      shift('2026-11-08', 480, 960),
      shift('2026-11-22', 480, 590),
    ]
    expect(compBalance({ ...emptyLedger, entries }, rules, now)).toEqual({
      opening: 0,
      accumulated: 1550,
      earned: 3,
      remainder: 110,
      missing: 370,
      taken: 0,
      available: 3,
      earnedDates: ['2026-11-01', '2026-11-08', '2026-11-15'],
    })
  })
  it('parte del saldo inicial e ignora jornadas anteriores o del mismo día', () => {
    const settings = {
      ...rules,
      compSince: '2026-11-07',
      compOpeningDays: 2,
      compOpeningMinutes: 420,
    }
    const entries = [
      shift('2026-11-01', 480, 960),
      shift('2026-11-07', 480, 960),
      shift('2026-11-08', 480, 540),
    ]
    const balance = compBalance({ ...emptyLedger, entries }, settings, now)
    expect(balance).toMatchObject({
      opening: 2,
      accumulated: 480,
      earned: 1,
      remainder: 0,
      missing: 480,
      available: 3,
      earnedDates: ['2026-11-08'],
    })
  })
  it('la jornada del mismo día del saldo inicial no cuenta', () => {
    const settings = { ...rules, compSince: '2026-11-08' }
    const entries = [shift('2026-11-08', 480, 960)]
    expect(compBalance({ ...emptyLedger, entries }, settings, now)).toMatchObject({
      accumulated: 0,
      earned: 0,
    })
  })
  it('resta solo los francos tomados después del saldo inicial y hasta hoy', () => {
    const settings = { ...rules, compSince: '2026-11-07', compOpeningDays: 2 }
    const comps = [comp('2026-11-05'), comp('2026-11-20'), comp(null), comp('2026-11-30')]
    expect(compBalance({ ...emptyLedger, comps }, settings, now)).toMatchObject({
      taken: 1,
      available: 1,
    })
  })
  it('no suma jornadas futuras', () => {
    const entries = [shift('2026-11-29', 480, 960)]
    expect(compBalance({ ...emptyLedger, entries }, rules, now)).toMatchObject({
      accumulated: 0,
      earned: 0,
      earnedDates: [],
    })
  })
  it('un turno nocturno de sábado a domingo suma su parte al 100%', () => {
    const night = shift('2026-11-21', 1320, 360)
    const expected = calculate(night, rules, new Map()).double
    expect(expected).toBeGreaterThan(360)
    expect(compBalance({ ...emptyLedger, entries: [night] }, rules, now).accumulated).toBe(expected)
  })
  it('un franco nunca se cuenta dos veces aunque una jornada cruce varios múltiplos', () => {
    const settings = { ...rules, compOpeningMinutes: 470 }
    // 0 → 0 es un turno de 24 h (la salida <= entrada cruza la medianoche): 1440 min al 100%.
    const entries = [shift('2026-11-01', 0, 0), shift('2026-11-08', 480, 490)]
    const balance = compBalance({ ...emptyLedger, entries }, settings, now)
    expect(balance.earnedDates).toEqual(['2026-11-01', '2026-11-01', '2026-11-01', '2026-11-08'])
    expect(balance).toMatchObject({ accumulated: 1920, earned: 4, remainder: 0 })
  })
  it('puede quedar negativo si se tomaron más francos de los ganados', () => {
    const comps = [comp('2026-11-10')]
    expect(compBalance({ ...emptyLedger, comps }, rules, now).available).toBe(-1)
  })
  it('las reglas viejas sin saldo inicial toman valores por defecto', () => {
    const { compSince, compOpeningDays, compOpeningMinutes, ...old } = defaults
    void compSince
    void compOpeningDays
    void compOpeningMinutes
    const empty = { compSince: null, compOpeningDays: 0, compOpeningMinutes: 0 }
    expect(settingsSchema.parse(old)).toMatchObject(empty)
    const oldRules = {
      start: 480,
      end: 1020,
      breakMinutes: 60,
      saturday: 780,
      early: 'extra',
      nonWorking: false,
      closing: 14,
      annualLeave: 14,
      lockClosed: true,
    }
    const parsed = rulesRecordSchema.parse({ id: rulesId, ...oldRules })
    expect(parsed).toEqual({ id: rulesId, ...oldRules })
    expect(settingsSchema.parse({ ...old, ...parsed })).toMatchObject(empty)
    expect(
      rulesRecordSchema.parse({ id: rulesId, ...oldRules, compSince: '2026-11-07' }).compSince,
    ).toBe('2026-11-07')
    expect(rulesRecordSchema.safeParse({ id: rulesId, ...oldRules, start: 1100 }).success).toBe(
      false,
    )
  })
})

describe('estadísticas anuales', () => {
  const rules = { ...defaults, breakMinutes: 0, start: 480, end: 1020 }
  const shift = (date: string, start: number, end: number) => ({
    ...blankEntry(date, rules),
    start,
    end,
  })
  const leave = (kind: LeaveKind, from: string, to: string) => ({
    id: crypto.randomUUID(),
    kind,
    from,
    to,
    notes: '',
  })
  const comp = (taken: string | null) => ({
    id: crypto.randomUUID(),
    earned: '2026-01-01',
    reason: '',
    taken,
  })
  const now = '2026-11-22'
  it('cuenta días calendario de cada licencia dentro del año', () => {
    const leaves = [
      leave('vacaciones', '2026-12-30', '2027-01-02'),
      leave('enfermedad', '2026-03-02', '2026-03-04'),
      leave('otra', '2025-12-31', '2026-01-01'),
    ]
    const ledger = { ...emptyLedger, leaves }
    expect(yearStats(ledger, rules, '2026', now).leaveDays).toEqual({
      vacaciones: 2,
      enfermedad: 3,
      mudanza: 0,
      otra: 1,
    })
    expect(yearStats(ledger, rules, '2027', now).leaveDays).toEqual({
      vacaciones: 2,
      enfermedad: 0,
      mudanza: 0,
      otra: 0,
    })
  })
  it('suma extras al 50% y 100% del año hasta hoy y calcula el promedio semanal', () => {
    const entries = [
      shift('2026-11-02', 480, 1140), // lunes: 2 h al 50%
      shift('2026-11-01', 480, 960), // domingo: 8 h al 100%
      shift('2025-12-31', 480, 1140), // otro año
      shift('2026-11-29', 480, 960), // futura
    ]
    const ledger = { ...emptyLedger, entries }
    const stats = yearStats(ledger, rules, '2026', now)
    expect(stats.extra).toBe(600)
    // 2026-01-01 → 2026-11-22: 326 días
    expect(stats.weeklyExtra).toBe(Math.round(600 / (326 / 7)))
    expect(stats.weeklyExtra).toBe(13)
    const past = yearStats(ledger, rules, '2025', now)
    expect(past.extra).toBe(120)
    expect(past.weeklyExtra).toBe(Math.round(120 / (365 / 7)))
    expect(yearStats(ledger, rules, '2027', now)).toMatchObject({ extra: 0, weeklyExtra: 0 })
  })
  it('el promedio semanal usa al menos una semana', () => {
    const entries = [shift('2026-01-03', 480, 960)] // sábado
    const stats = yearStats({ ...emptyLedger, entries }, rules, '2026', '2026-01-03')
    expect(stats.extra).toBe(480)
    expect(stats.weeklyExtra).toBe(480)
  })
  it('cuenta francos ganados y tomados dentro del año', () => {
    const entries = [
      shift('2025-12-28', 480, 960),
      shift('2026-11-01', 480, 960),
      shift('2026-11-08', 480, 960),
    ]
    const comps = [comp('2026-03-10'), comp('2025-12-01'), comp(null), comp('2026-12-20')]
    const ledger = { ...emptyLedger, entries, comps }
    // el franco del 2026-12-20 es posterior a hoy: todavía no se tomó
    expect(yearStats(ledger, rules, '2026', now)).toMatchObject({ compsEarned: 2, compsTaken: 1 })
    expect(yearStats(ledger, rules, '2025', now)).toMatchObject({ compsEarned: 1, compsTaken: 1 })
  })
})
