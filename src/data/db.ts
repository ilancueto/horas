import Dexie, { type EntityTable } from 'dexie'
import { create } from 'zustand'
import { z } from 'zod'
import { nationalHolidays } from '../domain/holidays'
import {
  collections,
  emptyLedger,
  emptyPrivate,
  defaults,
  privateSchema,
  settingsSchema,
  rulesId,
  rulesSchema,
  rulesRecordSchema,
  type RulesRecord,
  type Collection,
  type Item,
  type Ledger,
  type PrivateData,
  type Settings,
} from '../domain/model'

export type Row = {
  id: string
  collection: Collection | 'rules'
  data: Item | RulesRecord
  deleted: boolean
  revision: string
  updatedAt?: string
}
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
    if (row.deleted || row.collection === 'rules' || !Object.hasOwn(collections, row.collection))
      continue
    const result = collections[row.collection].safeParse(row.data)
    if (result.success) (ledger[row.collection] as Item[]).push(result.data)
  }
  return ledger
}
export type Change = { collection: Collection; item: Item; deleted?: boolean }
type History = { before: Change[]; after: Change[] }
type Store = {
  ledger: Ledger
  settings: Settings
  privateData: PrivateData
  ready: boolean
  error: string
  past: History[]
  future: History[]
  notice: string
  undoNotice: boolean
  backupAt: string
}
export const useHours = create<Store>(() => ({
  ledger: emptyLedger,
  settings: defaults,
  privateData: emptyPrivate,
  ready: false,
  error: '',
  past: [],
  future: [],
  notice: '',
  undoNotice: false,
  backupAt: '',
}))
export function notify(notice: string) {
  useHours.setState({ notice, undoNotice: false })
}
async function readSettings() {
  const local = await getMeta('settings', settingsSchema, defaults)
  const stored = await db.records.get(rulesId)
  const rules = rulesRecordSchema.safeParse(stored?.deleted ? undefined : stored?.data)
  if (!rules.success) return local
  const { id, ...shared } = rules.data
  void id
  return { ...local, ...shared }
}
export async function reload() {
  const [ledger, settings] = await Promise.all([readLedger(), readSettings()])
  useHours.setState({ ledger, settings })
}
export async function initialize() {
  try {
    await db.transaction('rw', db.records, db.meta, async () => {
      if (await db.meta.get('holidaysSeeded')) return
      const dates = new Set(
        (await db.records.where('collection').equals('holidays').toArray()).map((row) =>
          'date' in row.data ? row.data.date : '',
        ),
      )
      await db.records.bulkPut(
        nationalHolidays()
          .filter((h) => !dates.has(h.date))
          .map((data) => ({
            id: data.id,
            collection: 'holidays',
            data,
            deleted: false,
            revision: crypto.randomUUID(),
          })),
      )
      await putMeta('holidaysSeeded', true)
    })
    const [ledger, settings, privateData, backupAt] = await Promise.all([
      readLedger(),
      readSettings(),
      getMeta('private', privateSchema, emptyPrivate),
      getMeta('backupAt', z.string(), ''),
    ])
    useHours.setState({ ledger, settings, privateData, backupAt, ready: true, error: '' })
  } catch {
    useHours.setState({
      error: 'No pudimos abrir tus datos. Revisá que el navegador permita el almacenamiento local.',
      ready: true,
    })
  }
}
let changesPending: Promise<unknown> = Promise.resolve()
function serial<T>(operation: () => Promise<T>) {
  const next = changesPending.then(operation)
  changesPending = next.catch(() => undefined)
  return next
}
type LocalUpdates = { settings?: Settings; privateData?: PrivateData; clearPin?: boolean }
export function apply(
  changes: Change[] | (() => Change[]),
  message = 'Cambios guardados',
  history = true,
  updates: LocalUpdates = {},
) {
  return serial(async () => {
    try {
      const after = (typeof changes === 'function' ? changes() : changes).map((c) => ({
        ...c,
        item: collections[c.collection].parse(c.item),
      }))
      const settings = updates.settings ? settingsSchema.parse(updates.settings) : undefined
      const privateData = updates.privateData ? privateSchema.parse(updates.privateData) : undefined
      const before = await db.transaction('rw', db.records, db.queue, db.meta, async () => {
        if (settings) await writeSettings(settings)
        if (privateData) await putMeta('private', privateData)
        if (updates.clearPin) await putMeta('pin', null)
        const old = await db.records.bulkGet(after.map((c) => c.item.id))
        const rows = after.map((c) => ({
          id: c.item.id,
          collection: c.collection,
          data: c.item,
          deleted: c.deleted ?? false,
          revision: crypto.randomUUID(),
        }))
        await db.records.bulkPut(rows)
        await db.queue.bulkPut(rows)
        return after.map((change, index) => {
          const previous = old[index]
          const stored = collections[change.collection].safeParse(previous?.data)
          return {
            collection: change.collection,
            item: stored.success ? stored.data : change.item,
            deleted: previous?.deleted ?? !previous,
          }
        })
      })
      await reload()
      useHours.setState((s) => ({
        ...(privateData ? { privateData } : {}),
        notice: message,
        undoNotice: history,
        past: history ? [...s.past.slice(-39), { before, after }] : s.past,
        future: history ? [] : s.future,
      }))
      return true
    } catch {
      notify('No se pudo guardar el cambio. Volvé a intentar.')
      return false
    }
  })
}
export async function undo(redo = false) {
  const { past, future } = useHours.getState()
  const action = (redo ? future : past).at(-1)
  if (!action) return
  if (
    await apply(
      redo ? action.after : action.before,
      redo ? 'Cambio rehecho' : 'Cambio deshecho',
      false,
    )
  ) {
    useHours.setState({
      past: redo ? [...past, action] : past.slice(0, -1),
      future: redo ? future.slice(0, -1) : [...future, action],
    })
  }
}
async function writeSettings(settings: Settings) {
  const previous = useHours.getState().settings
  const rules = rulesSchema.parse(settings)
  if (rules.start >= rules.end) throw new Error('Invalid work window')
  await putMeta('settings', settings)
  if (JSON.stringify(rules) === JSON.stringify(rulesSchema.parse(previous))) return
  const data = rulesRecordSchema.parse({ id: rulesId, ...rules })
  const row: Row = {
    id: rulesId,
    collection: 'rules',
    data,
    deleted: false,
    revision: crypto.randomUUID(),
  }
  await db.records.put(row)
  await db.queue.put(row)
}
export async function saveSettings(patch: Partial<Settings>) {
  return serial(async () => {
    const settings = settingsSchema.parse({ ...useHours.getState().settings, ...patch })
    if (settings.start >= settings.end) {
      notify('La salida habitual tiene que ser posterior a la entrada.')
      return false
    }
    await db.transaction('rw', db.meta, db.records, db.queue, () => writeSettings(settings))
    useHours.setState({ settings })
    return true
  })
}
/**
 * Marca este dispositivo como configurado. `onboarded` es local: se escribe directo en el
 * meta de ajustes, sin `saveSettings`, para no encolar ni subir reglas por defecto que
 * pisarían las de la nube.
 */
export function markOnboarded() {
  return serial(async () => {
    const local = await getMeta('settings', settingsSchema, defaults)
    await putMeta('settings', { ...local, onboarded: true })
    await reload()
  })
}
export async function savePrivate(privateData: PrivateData) {
  await putMeta('private', privateSchema.parse(privateData))
  useHours.setState({ privateData })
}
export function diffLedger(current: Ledger, next: Ledger): Change[] {
  return (Object.keys(collections) as Collection[]).flatMap((collection) => {
    const ids = new Set(next[collection].map((item) => item.id))
    const previous = new Map(current[collection].map((item) => [item.id, item]))
    const changed = (next[collection] as Item[]).filter(
      (item) => JSON.stringify(item) !== JSON.stringify(previous.get(item.id)),
    )
    return [
      ...changed.map((item) => ({ collection, item })),
      ...current[collection]
        .filter((item) => !ids.has(item.id))
        .map((item) => ({ collection, item, deleted: true })),
    ]
  })
}
