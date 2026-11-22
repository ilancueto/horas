import { z } from 'zod'

export const day = z.iso.date()
const id = z.uuid()
const minute = z.number().int().min(0).max(1439)
const duration = z.number().int().min(0).max(1440)
export const settingsSchema = z.object({
  start: minute, end: minute, breakMinutes: duration, saturday: minute,
  early: z.enum(['extra', 'normal', 'double']), nonWorking: z.boolean(),
  closing: z.number().int().min(1).max(28), annualLeave: z.number().int().min(0).max(366),
  lockClosed: z.boolean(), theme: z.enum(['auto', 'light', 'dark']),
  format: z.enum(['clock', 'decimal', 'both']), onboarded: z.boolean(),
  dailyReminder: z.boolean(), reminderTime: minute, closingReminder: z.number().int().min(0).max(14),
})
export const defaults: Settings = {
  start: 465, end: 1005, breakMinutes: 60, saturday: 780, early: 'extra',
  nonWorking: false, closing: 14, annualLeave: 14, lockClosed: true,
  theme: 'auto', format: 'clock', onboarded: false,
  dailyReminder: false, reminderTime: 1080, closingReminder: 0,
}
export type Settings = z.infer<typeof settingsSchema>
export const periodSchema = z.object({
  id, from: day, to: day, status: z.enum(['Abierto', 'Enviado a RRHH', 'Pagado']),
}).refine(p => p.from <= p.to).refine(p => p.from.slice(0, 4) >= '1900' && p.to.slice(0, 4) <= '2199')
export const entrySchema = z.object({
  id, date: day, start: minute.nullable(), end: minute.nullable(),
  breakMinutes: duration, guard: z.boolean(), notes: z.string(),
})
export const compSchema = z.object({ id, earned: day, reason: z.string(), taken: day.nullable() })
export const leaveSchema = z.object({ id, from: day, to: day, notes: z.string() }).refine(p => p.from <= p.to)
export const holidaySchema = z.object({ id, date: day, name: z.string().min(1), kind: z.enum(['feriado', 'no laborable', 'puente']) })
export const collections = {
  periods: periodSchema, entries: entrySchema, comps: compSchema, leaves: leaveSchema, holidays: holidaySchema,
}
export type Collection = keyof typeof collections
export type Item<C extends Collection = Collection> = z.infer<(typeof collections)[C]>
export type Period = Item<'periods'>
export type Entry = Item<'entries'>
export type Holiday = Item<'holidays'>
export const ledgerSchema = z.object({
  periods: z.array(periodSchema), entries: z.array(entrySchema), comps: z.array(compSchema),
  leaves: z.array(leaveSchema), holidays: z.array(holidaySchema),
})
export type Ledger = z.infer<typeof ledgerSchema>
export const emptyLedger: Ledger = { periods: [], entries: [], comps: [], leaves: [], holidays: [] }
export const privateSchema = z.object({
  rate: z.number().nonnegative().nullable(),
  receipt: z.record(z.string(), z.object({ extra: z.number().nonnegative().nullable(), double: z.number().nonnegative().nullable() })),
})
export type PrivateData = z.infer<typeof privateSchema>
export const emptyPrivate: PrivateData = { rate: null, receipt: {} }
export function blankEntry(date: string, settings: Settings): Entry {
  return { id: crypto.randomUUID(), date, start: null, end: null, notes: '', guard: false, breakMinutes: settings.breakMinutes }
}
