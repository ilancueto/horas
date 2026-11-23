import { addDays, dateRange, decimal, daysBetween, monthOffset, weekday } from './dates'
import {
  leaveKinds,
  periodId,
  type Entry,
  type Holiday,
  type LeaveKind,
  type Ledger,
  type Period,
  type Settings,
} from './model'

export const zero = { normal: 0, extra: 0, double: 0, total: 0 }
export const isHoliday = (holiday: Holiday | undefined, settings: Settings) =>
  Boolean(holiday && (holiday.kind === 'feriado' || settings.nonWorking))
const overlap = (from: number, to: number, a: number, b: number) =>
  Math.max(0, Math.min(to, b) - Math.max(from, a))

export function calculate(
  entry: Entry | undefined,
  settings: Settings,
  holidays: Map<string, Holiday>,
) {
  if (!entry || entry.start === null || entry.end === null) return { ...zero }
  const { start, end, date, breakMinutes } = entry
  const overnight = end <= start
  const result = { ...zero }
  function segment(day: string, from: number, to: number) {
    const dow = weekday(day)
    const length = to - from
    if (dow === 0 || isHoliday(holidays.get(day), settings)) result.double += length
    else if (dow === 6) {
      const first = overlap(from, to, 0, settings.saturday)
      result.extra += first
      result.double += length - first
    } else {
      const early = overlap(from, to, 0, settings.start)
      const normal = overlap(from, to, settings.start, settings.end)
      result.normal += normal
      result.extra += length - early - normal
      result[settings.early] += early
    }
  }
  segment(date, start, overnight ? 1440 : end)
  if (overnight && end) segment(addDays(date, 1), 0, end)
  let remaining = breakMinutes
  const dayOfWeek = weekday(date)
  const dayType =
    dayOfWeek === 0 || isHoliday(holidays.get(date), settings)
      ? 'double'
      : dayOfWeek === 6
        ? 'extra'
        : 'normal'
  const order = {
    normal: ['normal', 'extra', 'double'],
    extra: ['extra', 'double', 'normal'],
    double: ['double', 'extra', 'normal'],
  } as const
  for (const key of order[dayType]) {
    const deduction = Math.min(remaining, result[key])
    result[key] -= deduction
    remaining -= deduction
  }
  result.total = result.normal + result.extra + result.double
  return result
}

export function entryWarnings(entry: Entry, period: Period, entries: Entry[]) {
  const warnings: string[] = []
  if (entry.date < period.from || entry.date > period.to)
    warnings.push('La fecha queda fuera del período.')
  if (entry.start === null || entry.end === null) return warnings
  const length = entry.end - entry.start + (entry.end <= entry.start ? 1440 : 0)
  if (length > 960) warnings.push('La jornada supera las 16 horas. Revisá el horario.')
  if (entry.breakMinutes > length) warnings.push('El descanso supera la duración de la jornada.')
  if (entry.end <= entry.start && (entry.start < 18 * 60 || entry.end > 12 * 60))
    warnings.push('La salida es anterior a la entrada. Revisá si corresponde al día siguiente.')
  const prev = entries.find((e) => e.date === addDays(entry.date, -1))
  const next = entries.find((e) => e.date === addDays(entry.date, 1))
  if (
    (prev?.start != null &&
      prev.end !== null &&
      prev.end <= prev.start &&
      prev.end > entry.start) ||
    (next?.start != null && entry.end <= entry.start && entry.end > next.start)
  )
    warnings.push('El turno se superpone con otra jornada.')
  return warnings
}

export const holidayMap = (ledger: Ledger) => new Map(ledger.holidays.map((h) => [h.date, h]))
export function dayRows(
  period: Pick<Period, 'from' | 'to'>,
  ledger: Ledger,
  settings: Settings,
  now: string,
) {
  const entries = new Map(ledger.entries.map((e) => [e.date, e]))
  const holidays = holidayMap(ledger)
  const comps = new Set(ledger.comps.map((c) => c.taken))
  return dateRange(period.from, period.to).map((date) => {
    const entry = entries.get(date)
    const holiday = holidays.get(date)
    const dow = weekday(date)
    const comp = comps.has(date)
    const leave = ledger.leaves.find((l) => l.from <= date && l.to >= date)?.kind ?? null
    const vac = leave === 'vacaciones'
    const hours = calculate(entry, settings, holidays)
    const fullHoliday = isHoliday(holiday, settings)
    return {
      date,
      entry,
      comp,
      vac,
      leave,
      holiday,
      hours,
      tone: vac
        ? 'vac'
        : leave
          ? 'lic'
          : comp
            ? 'comp'
            : entry?.guard
              ? 'guard'
              : holiday || dow === 0 || dow === 6
                ? 'week'
                : '',
      pending:
        date < now && dow > 0 && dow < 6 && !fullHoliday && !comp && !leave && hours.total === 0,
    }
  })
}
export type DayRow = ReturnType<typeof dayRows>[number]
export function summarize(rows: DayRow[]) {
  const totals = { ...zero, worked: 0, guards: 0, blocks: 0, pending: 0, comp: 0 }
  let previousGuard = ''
  for (const row of rows) {
    for (const key of ['normal', 'extra', 'double', 'total'] as const) totals[key] += row.hours[key]
    if (row.hours.total > 0) totals.worked++
    if (row.entry?.guard) {
      totals.guards++
      if (!previousGuard || daysBetween(previousGuard, row.date) !== 1) totals.blocks++
      previousGuard = row.date
    }
    if (row.comp) totals.comp++
    if (row.pending) totals.pending++
  }
  return totals
}
export function decimalTotals(rows: DayRow[], roundPerDay: boolean) {
  const reported = { ...zero }
  for (const key of ['normal', 'extra', 'double', 'total'] as const) {
    reported[key] = roundPerDay
      ? rows.reduce((sum, row) => sum + Math.round((row.hours[key] * 100) / 60), 0) / 100
      : decimal(rows.reduce((sum, row) => sum + row.hours[key], 0))
  }
  return reported
}

export function chain(periods: Period[]) {
  const ordered = [...periods]
    .sort((a, b) => a.to.localeCompare(b.to) || a.from.localeCompare(b.from))
    .filter((p, index, list) => list[index - 1]?.to !== p.to)
  return ordered.map((p, i) => ({ ...p, from: i ? addDays(ordered[i - 1].to, 1) : p.from }))
}
export function suggestPeriod(periods: Period[], settings: Settings, now: string): Period {
  const last = chain(periods).at(-1)
  const close = String(settings.closing).padStart(2, '0')
  const todayClose = now.slice(0, 7) + '-' + close
  const from = last
    ? addDays(last.to, 1)
    : addDays(now <= todayClose ? monthOffset(now.slice(0, 7), -1) + '-' + close : todayClose, 1)
  const candidate = from.slice(0, 7) + '-' + close
  const to =
    candidate >= from && daysBetween(from, candidate) >= 13
      ? candidate
      : monthOffset(from.slice(0, 7), 1) + '-' + close
  return { id: periodId(from), from, to, status: 'Abierto' }
}
const leaveDaysIn = (leave: Ledger['leaves'][number], year: string) => {
  const start = year + '-01-01'
  const end = year + '-12-31'
  return Math.max(
    0,
    daysBetween(leave.from > start ? leave.from : start, leave.to < end ? leave.to : end) + 1,
  )
}
export function leaveBalance(leaves: Ledger['leaves'], year: string, available: number) {
  const used = leaves
    .filter((leave) => leave.kind === 'vacaciones')
    .reduce((sum, leave) => sum + leaveDaysIn(leave, year), 0)
  return { used, remaining: available - used }
}
export const overlapsLeave = (leaves: Ledger['leaves'], range: Ledger['leaves'][number]) =>
  leaves.some((l) => l.id !== range.id && l.from <= range.to && l.to >= range.from)

export const compMinutes = 480
export type CompBalance = {
  opening: number
  accumulated: number
  earned: number
  remainder: number
  missing: number
  taken: number
  available: number
  earnedDates: string[]
}
export function compBalance(ledger: Ledger, settings: Settings, now: string): CompBalance {
  const { compSince, compOpeningDays, compOpeningMinutes } = settings
  const after = (date: string) => compSince === null || date > compSince
  const holidays = holidayMap(ledger)
  const entries = ledger.entries
    .filter((entry) => after(entry.date) && entry.date <= now)
    .sort((a, b) => a.date.localeCompare(b.date))
  let accumulated = compOpeningMinutes
  const earnedDates: string[] = []
  for (const entry of entries) {
    const before = Math.floor(accumulated / compMinutes)
    accumulated += calculate(entry, settings, holidays).double
    for (let k = before; k < Math.floor(accumulated / compMinutes); k++)
      earnedDates.push(entry.date)
  }
  const remainder = accumulated % compMinutes
  const taken = ledger.comps.filter(
    (comp) => comp.taken !== null && comp.taken <= now && after(comp.taken),
  ).length
  return {
    opening: compOpeningDays,
    accumulated,
    earned: earnedDates.length,
    remainder,
    missing: compMinutes - remainder,
    taken,
    available: compOpeningDays + earnedDates.length - taken,
    earnedDates,
  }
}

export function yearStats(ledger: Ledger, settings: Settings, year: string, now: string) {
  const start = year + '-01-01'
  const end = year + '-12-31'
  const inYear = (date: string | null) => date !== null && date >= start && date <= end
  const holidays = holidayMap(ledger)
  const extra = ledger.entries
    .filter((entry) => inYear(entry.date) && entry.date <= now)
    .reduce((sum, entry) => {
      const hours = calculate(entry, settings, holidays)
      return sum + hours.extra + hours.double
    }, 0)
  const elapsed = daysBetween(start, now < end ? now : end) + 1
  const leaveDays = Object.fromEntries(leaveKinds.map((kind) => [kind, 0])) as Record<
    LeaveKind,
    number
  >
  for (const leave of ledger.leaves) leaveDays[leave.kind] += leaveDaysIn(leave, year)
  return {
    extra,
    weeklyExtra: Math.round(extra / Math.max(1, elapsed / 7)),
    leaveDays,
    compsEarned: compBalance(ledger, settings, now).earnedDates.filter(inYear).length,
    compsTaken: ledger.comps.filter(
      (comp) => comp.taken !== null && inYear(comp.taken) && comp.taken <= now,
    ).length,
  }
}
