import { useState } from 'react'
import { CalendarOff, Palmtree, Plus, Repeat2, Stethoscope, Trash2 } from 'lucide-react'
import { daysBetween, fmtDate } from '../domain/dates'
import { calculate, holidayMap, leaveBalance, overlapsLeave } from '../domain/hours'
import {
  collections,
  leaveKinds,
  leaveLabels,
  type Holiday,
  type Item,
  type LeaveKind,
} from '../domain/model'
import { holidayId } from '../domain/holidays'
import { apply, useHours } from '../data/db'
import { DeleteActions, Dialog, Empty } from './base'

export type AbsenceView = 'comps' | 'leaves' | 'licenses' | 'holidays'
type AbsenceCollection = 'comps' | 'leaves' | 'holidays'
const collectionOf = (view: AbsenceView): AbsenceCollection =>
  view === 'licenses' ? 'leaves' : view
const config = {
  comps: { title: 'Compensatorio', one: 'compensatorio', icon: Repeat2, tone: 'comp' },
  leaves: { title: 'Vacaciones', one: 'vacaciones', icon: Palmtree, tone: 'vac' },
  licenses: { title: 'Licencias', one: 'licencia', icon: Stethoscope, tone: 'lic' },
  holidays: { title: 'Feriados', one: 'feriado', icon: CalendarOff, tone: 'week' },
}
export function Absences({ view, today }: { view: AbsenceView; today: string }) {
  const { ledger, settings } = useHours()
  const [form, setForm] = useState<{ item?: Item<AbsenceCollection> } | null>(null)
  const [year, setYear] = useState(today.slice(0, 4))
  const { title, one, tone } = config[view]
  const items: Item<AbsenceCollection>[] =
    view === 'leaves'
      ? ledger.leaves.filter((l) => l.kind === 'vacaciones')
      : view === 'licenses'
        ? ledger.leaves.filter((l) => l.kind !== 'vacaciones')
        : ledger[view]
  const pending = ledger.comps.filter((c) => !c.taken).length
  const balance = leaveBalance(ledger.leaves, year, settings.annualLeave)
  const years = [
    ...new Set([
      today.slice(0, 4),
      ...ledger.leaves.flatMap((l) => [l.from.slice(0, 4), l.to.slice(0, 4)]),
    ]),
  ].sort()
  const sortKey = (i: Item<AbsenceCollection>) =>
    'date' in i ? i.date : 'earned' in i ? i.earned : i.from
  return (
    <section className="stack">
      <div className="title-line">
        <div>
          <h1>{title}</h1>
        </div>
        <button className="primary" onClick={() => setForm({})}>
          <Plus size={17} /> Agregar {one}
        </button>
      </div>
      {view === 'comps' && (
        <div className="absence-summary">
          {[
            [pending, 'Pendientes'],
            [items.length - pending, 'Tomados'],
            [items.length, 'En total'],
          ].map(([n, label]) => (
            <div className="tile" key={label}>
              <span>{label}</span>
              <strong>{n}</strong>
            </div>
          ))}
        </div>
      )}
      {view === 'leaves' && (
        <>
          <label className="year-picker">
            Año
            <select value={year} onChange={(e) => setYear(e.target.value)}>
              {years.map((y) => (
                <option key={y}>{y}</option>
              ))}
            </select>
          </label>
          <div className="absence-summary">
            {[
              [settings.annualLeave, 'Disponibles'],
              [balance.used, 'Tomados'],
              [balance.remaining, 'Saldo'],
            ].map(([n, label]) => (
              <div className="tile" key={label}>
                <span>{label}</span>
                <strong>{n}</strong>
              </div>
            ))}
          </div>
        </>
      )}
      <div className="panel">
        {!items.length ? (
          <Empty title={'Todavía no hay ' + title.toLowerCase()}>
            <p>Agregá un registro para verlo en tu calendario.</p>
          </Empty>
        ) : (
          <ul className="record-list">
            {[...items]
              .sort((a, b) => sortKey(a).localeCompare(sortKey(b)))
              .map((item) => (
                <li key={item.id}>
                  <div>
                    <strong className="wrap-anywhere">
                      {'date' in item
                        ? item.name
                        : 'earned' in item
                          ? item.reason || 'Compensatorio'
                          : view === 'licenses'
                            ? leaveLabels[item.kind].label
                            : fmtDate(item.from) + ' – ' + fmtDate(item.to)}
                    </strong>
                    <p className="muted">
                      {'date' in item
                        ? fmtDate(item.date)
                        : 'earned' in item
                          ? 'Ganado el ' +
                            fmtDate(item.earned) +
                            (item.taken ? ' · Tomado el ' + fmtDate(item.taken) : '')
                          : (view === 'licenses'
                              ? fmtDate(item.from) + ' – ' + fmtDate(item.to) + ' · '
                              : '') +
                            (daysBetween(item.from, item.to) + 1) +
                            ' días' +
                            (item.notes ? ' · ' + item.notes : '')}
                    </p>
                  </div>
                  <div className="actions">
                    <span className={'badge ' + tone}>
                      {'date' in item
                        ? item.kind
                        : 'earned' in item
                          ? item.taken
                            ? 'Tomado'
                            : 'Pendiente'
                          : leaveLabels[item.kind].short}
                    </span>
                    <button onClick={() => setForm({ item })}>Editar</button>
                  </div>
                </li>
              ))}
          </ul>
        )}
      </div>
      {form && (
        <AbsenceForm view={view} today={today} item={form.item} close={() => setForm(null)} />
      )}
    </section>
  )
}
export function AbsenceForm({
  view,
  today,
  item,
  close,
  initial,
}: {
  view: AbsenceView
  today: string
  item?: Item<AbsenceCollection>
  close: () => void
  initial?: Partial<Item<'comps'>>
}) {
  const { ledger, settings } = useHours()
  const collection = collectionOf(view)
  const leave = item && 'from' in item ? item : undefined
  const comp = item && 'earned' in item ? item : view === 'comps' ? initial : undefined
  const [deleting, setDeleting] = useState(false)
  const [taken, setTaken] = useState(Boolean(comp?.taken))
  const [warning, setWarning] = useState('')
  return (
    <Dialog title={(item ? 'Editar ' : 'Agregar ') + config[view].one} close={close}>
      {deleting && item ? (
        <DeleteActions
          cancel={() => setDeleting(false)}
          remove={async () => {
            if (await apply([{ collection, item, deleted: true }], 'Registro borrado')) close()
          }}
        />
      ) : (
        <form
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault()
            const data = new FormData(e.currentTarget)
            const value = (key: string) => String(data.get(key) ?? '').trim()
            const id = item?.id ?? crypto.randomUUID()
            let next: Item<AbsenceCollection>
            if (view === 'comps') {
              next = {
                id,
                earned: value('from'),
                reason: value('notes'),
                taken: taken ? value('to') : null,
              }
              if (next.taken && next.taken < next.earned) {
                setWarning('La fecha tomada tiene que ser posterior o igual a la ganada.')
                return
              }
              if (
                next.taken &&
                calculate(
                  ledger.entries.find((r) => r.date === (next as Item<'comps'>).taken),
                  settings,
                  holidayMap(ledger),
                ).total > 0
              ) {
                setWarning(
                  'Ese día ya tiene horas cargadas. Elegí otra fecha o corregí la jornada.',
                )
                return
              }
              const takenDate = next.taken
              if (
                takenDate &&
                ledger.leaves.some((l) => l.from <= takenDate && l.to >= takenDate)
              ) {
                setWarning('Ya hay vacaciones o una licencia en esa fecha.')
                return
              }
              if (
                next.taken &&
                ledger.comps.some((r) => r.id !== id && r.taken === (next as Item<'comps'>).taken)
              ) {
                setWarning('Ya hay un compensatorio tomado ese día.')
                return
              }
            } else if (collection === 'leaves') {
              next = {
                id,
                kind:
                  view === 'licenses'
                    ? (value('kind') as LeaveKind)
                    : (leave?.kind ?? 'vacaciones'),
                from: value('from'),
                to: value('to'),
                notes: value('notes'),
              }
              if (next.kind === 'otra' && !next.notes) {
                setWarning('Contá el motivo en las notas.')
                return
              }
              if (next.to < next.from || overlapsLeave(ledger.leaves, next)) {
                setWarning(
                  'Revisá las fechas. El rango no puede superponerse con otras vacaciones o licencias.',
                )
                return
              }
              const range = next
              if (
                ledger.comps.some((c) => c.taken && c.taken >= range.from && c.taken <= range.to)
              ) {
                setWarning(
                  (view === 'licenses'
                    ? 'La licencia se superpone'
                    : 'Las vacaciones se superponen') + ' con un compensatorio tomado.',
                )
                return
              }
            } else {
              next = {
                id: item?.id ?? holidayId(value('from')),
                date: value('from'),
                name: value('notes'),
                kind: value('kind') as Holiday['kind'],
              }
              if (
                ledger.holidays.some((h) => h.id !== item?.id && h.date === (next as Holiday).date)
              ) {
                setWarning('Ya hay un feriado registrado en esa fecha.')
                return
              }
            }
            if (!collections[collection].safeParse(next).success) {
              setWarning('Revisá los campos antes de guardar.')
              return
            }
            if (await apply([{ collection, item: next }])) close()
          }}
          onChange={() => setWarning('')}
        >
          {view === 'licenses' && (
            <label>
              Tipo
              <select name="kind" aria-label="Tipo" defaultValue={leave?.kind ?? 'enfermedad'}>
                {leaveKinds
                  .filter((k) => k !== 'vacaciones')
                  .map((k) => (
                    <option key={k} value={k}>
                      {leaveLabels[k].label}
                    </option>
                  ))}
              </select>
            </label>
          )}
          <label>
            {view === 'comps' ? 'Fecha ganada' : collection === 'leaves' ? 'Desde' : 'Fecha'}
            <input
              required
              type="date"
              name="from"
              defaultValue={
                item && 'date' in item ? item.date : leave ? leave.from : (comp?.earned ?? today)
              }
            />
          </label>
          {view === 'comps' && (
            <label className="check">
              <input type="checkbox" checked={taken} onChange={(e) => setTaken(e.target.checked)} />{' '}
              Tomado
            </label>
          )}
          {(collection === 'leaves' || taken) && (
            <label>
              {collection === 'leaves' ? 'Hasta' : 'Fecha tomado'}
              <input
                required
                type="date"
                name="to"
                defaultValue={leave ? leave.to : (comp?.taken ?? today)}
              />
            </label>
          )}
          {view === 'holidays' && (
            <label>
              Tipo
              <select name="kind" defaultValue={item && 'kind' in item ? item.kind : 'feriado'}>
                <option value="feriado">Feriado</option>
                <option value="no laborable">Día no laborable</option>
                <option value="puente">Puente</option>
              </select>
            </label>
          )}
          <label>
            {view === 'comps' ? 'Motivo' : collection === 'leaves' ? 'Notas' : 'Nombre'}
            <input
              required={view === 'holidays'}
              name="notes"
              defaultValue={
                item && 'name' in item ? item.name : leave ? leave.notes : (comp?.reason ?? '')
              }
            />
          </label>
          {warning && (
            <p role="alert" className="warning">
              {warning}
            </p>
          )}
          <div className="actions">
            <button className="primary">Guardar</button>
            {item && (
              <button type="button" onClick={() => setDeleting(true)}>
                <Trash2 size={16} /> Borrar
              </button>
            )}
          </div>
        </form>
      )}
    </Dialog>
  )
}
