import Dexie, { type EntityTable } from 'dexie'
import { create } from 'zustand'
import { z } from 'zod'
import { nationalHolidays } from '../domain/holidays'
import { collections, emptyLedger, emptyPrivate, defaults, privateSchema, settingsSchema, type Collection, type Item, type Ledger, type PrivateData, type Settings } from '../domain/model'

export type Row = { id: string; collection: Collection; data: Item; deleted: boolean; revision: string; updatedAt?: string }
class HoursDB extends Dexie {
  records!: EntityTable<Row, 'id'>
  queue!: EntityTable<Row, 'id'>
  meta!: EntityTable<{ key: string; value: unknown }, 'key'>
  constructor() {
    super('horas')
    this.version(1).stores({ records: 'id,collection', meta: 'key' })
    this.version(2).stores({ records: 'id,collection', meta: 'key', queue: 'id' })
  }
}
export const db = new HoursDB()
export async function getMeta<T>(key: string, schema: z.ZodType<T>, fallback: T): Promise<T> {
  const parsed = schema.safeParse((await db.meta.get(key))?.value)
  return parsed.success ? parsed.data : fallback
}
export const putMeta = (key: string, value: unknown) => db.meta.put({ key, value })

export async function readLedger() {
  const ledger: Ledger = structuredClone(emptyLedger)
  for (const row of await db.records.toArray()) {
    if (row.deleted || !Object.hasOwn(collections, row.collection)) continue
    const result = collections[row.collection].safeParse(row.data)
    if (result.success) (ledger[row.collection] as Item[]).push(result.data)
  }
  return ledger
}
export type Change = { collection: Collection; item: Item; deleted?: boolean }
type History = { before: Change[]; after: Change[] }
type Store = {
  ledger: Ledger; settings: Settings; privateData: PrivateData; ready: boolean; error: string;
  past: History[]; future: History[]; notice: string; backupAt: string;
}
export const useHours = create<Store>(() => ({
  ledger: emptyLedger, settings: defaults, privateData: emptyPrivate, ready: false,
  error: '', past: [], future: [], notice: '', backupAt: '',
}))
export function notify(notice: string) { useHours.setState({ notice }) }
export async function reload() { useHours.setState({ ledger: await readLedger() }) }
export async function initialize() {
  try {
    await db.transaction('rw',db.records,db.meta,async()=>{
      if(await db.meta.get('holidaysSeeded')) return
      const dates=new Set((await db.records.where('collection').equals('holidays').toArray()).map(row=>('date' in row.data)?row.data.date:''))
      await db.records.bulkPut(nationalHolidays().filter(h=>!dates.has(h.date)).map(data=>({id:data.id,collection:'holidays',data,deleted:false,revision:crypto.randomUUID()})))
      await putMeta('holidaysSeeded',true)
    })
    const [ledger, settings, privateData, backupAt] = await Promise.all([
      readLedger(), getMeta('settings', settingsSchema, defaults),
      getMeta('private', privateSchema, emptyPrivate), getMeta('backupAt', z.string(), ''),
    ])
    useHours.setState({ ledger, settings, privateData, backupAt, ready: true, error: '' })
  } catch { useHours.setState({ error: 'No pudimos abrir tus datos. Revisá que el navegador permita el almacenamiento local.', ready: true }) }
}
let changesPending: Promise<unknown> = Promise.resolve()
function serial<T>(operation: () => Promise<T>) {
  const next = changesPending.then(operation)
  changesPending = next.catch(() => undefined)
  return next
}
export function apply(changes: Change[] | (() => Change[]), message = 'Cambios guardados', history = true) {
  return serial(async () => {
    try {
      const after = (typeof changes === 'function' ? changes() : changes).map(c => ({ ...c, item: collections[c.collection].parse(c.item) }))
      const before = await db.transaction('rw', db.records, db.queue, async () => {
        const old = await db.records.bulkGet(after.map(c => c.item.id))
        const rows = after.map(c => ({ id: c.item.id, collection: c.collection, data: c.item, deleted: c.deleted ?? false, revision: crypto.randomUUID() }))
        await db.records.bulkPut(rows)
        await db.queue.bulkPut(rows)
        return after.map((c, index) => ({ collection: c.collection, item: old[index]?.data ?? c.item, deleted: old[index]?.deleted ?? !old[index] }))
      })
      await reload()
      useHours.setState(s => ({
        notice: message, past: history ? [...s.past.slice(-39), { before, after }] : s.past,
        future: history ? [] : s.future,
      }))
      return true
    } catch { notify('No se pudo guardar el cambio. Volvé a intentar.'); return false }
  })
}
export async function undo(redo = false) {
  const { past, future } = useHours.getState()
  const action = (redo ? future : past).at(-1)
  if (!action) return
  if (await apply(redo ? action.after : action.before, redo ? 'Cambio rehecho' : 'Cambio deshecho', false)) {
    useHours.setState({ past: redo ? [...past, action] : past.slice(0, -1), future: redo ? future.slice(0, -1) : [...future, action] })
  }
}
export async function saveSettings(patch: Partial<Settings>) {
  const settings = settingsSchema.parse({ ...useHours.getState().settings, ...patch })
  if (settings.start >= settings.end) { notify('La salida habitual tiene que ser posterior a la entrada.'); return false }
  await putMeta('settings', settings)
  useHours.setState({ settings })
  return true
}
export async function savePrivate(privateData: PrivateData) {
  await putMeta('private', privateSchema.parse(privateData))
  useHours.setState({ privateData })
}
export function diffLedger(current: Ledger, next: Ledger): Change[] {
  return (Object.keys(collections) as Collection[]).flatMap(collection => {
    const ids = new Set(next[collection].map(item => item.id))
    const previous = new Map(current[collection].map(item => [item.id, item]))
    const changed = (next[collection] as Item[]).filter(item => JSON.stringify(item) !== JSON.stringify(previous.get(item.id)))
    return [...changed.map(item => ({ collection, item })), ...current[collection].filter(item => !ids.has(item.id)).map(item => ({ collection, item, deleted: true }))]
  })
}
