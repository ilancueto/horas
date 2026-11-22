const ms = 86_400_000
const zone = 'America/Argentina/Buenos_Aires'
export function ordinal(value: string) {
  const [year, month, date] = value.split('-').map(Number)
  return Date.UTC(year, month - 1, date) / ms
}
export const civil = (index: number) => new Date(index * ms).toISOString().slice(0, 10)
export const addDays = (value: string, days: number) => civil(ordinal(value) + days)
export const daysBetween = (from: string, to: string) => ordinal(to) - ordinal(from)
export const weekday = (value: string) => ((ordinal(value) + 4) % 7 + 7) % 7
export function dateRange(from: string, to: string) {
  return Array.from({ length: Math.max(0, daysBetween(from, to) + 1) }, (_, i) => addDays(from, i))
}
export function today() {
  const parts = new Intl.DateTimeFormat('es-AR', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts()
  const part = (type: string) => parts.find(p => p.type === type)!.value
  return [part('year'), part('month'), part('day')].join('-')
}
export function localMinute() {
  const parts = new Intl.DateTimeFormat('es-AR', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts()
  return Number(parts.find(p => p.type === 'hour')?.value) * 60 + Number(parts.find(p => p.type === 'minute')?.value)
}
export function monthOffset(month: string, offset: number) {
  const [year, number] = month.split('-').map(Number)
  const index = year * 12 + number - 1 + offset
  return Math.floor(index / 12) + '-' + String(index % 12 + 1).padStart(2, '0')
}
export const monthEnd = (date: string) => addDays(monthOffset(date.slice(0, 7), 1) + '-01', -1)
export const fmtDate = (value: string, options: Intl.DateTimeFormatOptions = { day: '2-digit', month: '2-digit', year: 'numeric' }) =>
  new Intl.DateTimeFormat('es-AR', { ...options, timeZone: 'UTC' }).format(ordinal(value) * ms)
export const clock = (minutes: number) => Math.floor(minutes / 60) + ':' + String(minutes % 60).padStart(2, '0')
export const clockInput = (minutes: number | null) => minutes === null ? '' : clock(minutes).padStart(5, '0')
export function parseClock(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return null
  const match = trimmed.match(/^(\d{1,2}):(\d{2})$/) ?? trimmed.match(/^(\d{1,2})(\d{2})$/)
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return undefined
  return Number(match[1]) * 60 + Number(match[2])
}
export const decimal = (minutes: number) => Math.round(minutes * 100 / 60) / 100
export const number = (value: number) => new Intl.NumberFormat('es-AR', { maximumFractionDigits: 2 }).format(value)
