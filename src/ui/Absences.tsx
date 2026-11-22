import { useState } from 'react'
import { CalendarOff, Palmtree, Plus, Repeat2, Trash2 } from 'lucide-react'
import { daysBetween, fmtDate } from '../domain/dates'
import { calculate, holidayMap, leaveBalance, overlapsLeave } from '../domain/hours'
import { collections, type Holiday, type Item } from '../domain/model'
import { holidayId } from '../domain/holidays'
import { apply, useHours } from '../data/db'
import { DeleteActions, Dialog, Empty } from './base'

export type AbsenceView = 'comps' | 'leaves' | 'holidays'
const config = {
  comps: { title: 'Compensatorio', one: 'compensatorio', icon: Repeat2, tone: 'comp' },
  leaves: { title: 'Vacaciones', one: 'vacaciones', icon: Palmtree, tone: 'vac' },
  holidays: { title: 'Feriados', one: 'feriado', icon: CalendarOff, tone: 'week' },
}
export function Absences({ view, today }: { view: AbsenceView; today: string }) {
  const { ledger, settings } = useHours()
  const [form, setForm] = useState<{ item?: Item<AbsenceView> } | null>(null)
  const [year, setYear] = useState(today.slice(0, 4))
  const { title, one, icon: Icon, tone } = config[view]
  const items = ledger[view] as Item<AbsenceView>[]
  const pending = ledger.comps.filter((c) => !c.taken).length
  const balance = leaveBalance(ledger.leaves, year, settings.annualLeave)
  const years = [
    ...new Set([
      today.slice(0, 4),
      ...ledger.leaves.flatMap((l) => [l.from.slice(0, 4), l.to.slice(0, 4)]),
    ]),
  ].sort()
  const sortKey = (i: Item<AbsenceView>) =>
    'date' in i ? i.date : 'earned' in i ? i.earned : i.from
  return (
    <section className="stack">
      <div className="title-line">
        <div>
          <p className="eyebrow">
            <Icon size={15} /> Días especiales
          </p>
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
                          : fmtDate(item.from) + ' – ' + fmtDate(item.to)}
                    </strong>
                    <p className="muted">
                      {'date' in item
                        ? fmtDate(item.date)
                        : 'earned' in item
                          ? 'Ganado el ' +
                            fmtDate(item.earned) +
                            (item.taken ? ' · Tomado el ' + fmtDate(item.taken) : '')
                          : daysBetween(item.from, item.to) +
                            1 +
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
                          : 'Vac'}
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
function AbsenceForm({
  view,
  today,
  item,
  close,
}: {
  view: AbsenceView
  today: string
  item?: Item<AbsenceView>
  close: () => void
}) {
  const { ledger, settings } = useHours()
  const [deleting, setDeleting] = useState(false)
  const [taken, setTaken] = useState(Boolean(item && 'taken' in item && item.taken))
  const [warning, setWarning] = useState('')
  return (
    <Dialog title={(item ? 'Editar ' : 'Agregar ') + config[view].one} close={close}>
      {deleting && item ? (
        <DeleteActions
          cancel={() => setDeleting(false)}
          remove={async () => {
            if (await apply([{ collection: view, item, deleted: true }], 'Registro borrado'))
              close()
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
            let next: Item<AbsenceView>
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
                setWarning('Ya hay vacaciones en esa fecha.')
                return
              }
              if (
                next.taken &&
                ledger.comps.some((r) => r.id !== id && r.taken === (next as Item<'comps'>).taken)
              ) {
                setWarning('Ya hay un compensatorio tomado ese día.')
                return
              }
            } else if (view === 'leaves') {
              next = { id, from: value('from'), to: value('to'), notes: value('notes') }
              if (next.to < next.from || overlapsLeave(ledger.leaves, next)) {
                setWarning(
                  'Revisá las fechas. El rango no puede superponerse con otras vacaciones.',
                )
                return
              }
              const range = next
              if (
                ledger.comps.some((c) => c.taken && c.taken >= range.from && c.taken <= range.to)
              ) {
                setWarning('Las vacaciones se superponen con un compensatorio tomado.')
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
            if (!collections[view].safeParse(next).success) {
              setWarning('Revisá los campos antes de guardar.')
              return
            }
            if (await apply([{ collection: view, item: next }])) close()
          }}
          onChange={() => setWarning('')}
        >
          <label>
            {view === 'comps' ? 'Fecha ganada' : view === 'leaves' ? 'Desde' : 'Fecha'}
            <input
              required
              type="date"
              name="from"
              defaultValue={
                item
                  ? 'date' in item
                    ? item.date
                    : 'earned' in item
                      ? item.earned
                      : item.from
                  : today
              }
            />
          </label>
          {view === 'comps' && (
            <label className="check">
              <input type="checkbox" checked={taken} onChange={(e) => setTaken(e.target.checked)} />{' '}
              Tomado
            </label>
          )}
          {(view === 'leaves' || taken) && (
            <label>
              {view === 'leaves' ? 'Hasta' : 'Fecha tomado'}
              <input
                required
                type="date"
                name="to"
                defaultValue={
                  item
                    ? 'taken' in item
                      ? (item.taken ?? today)
                      : 'to' in item
                        ? item.to
                        : today
                    : today
                }
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
            {view === 'comps' ? 'Motivo' : view === 'leaves' ? 'Notas' : 'Nombre'}
            <input
              required={view === 'holidays'}
              name="notes"
              defaultValue={
                item
                  ? 'name' in item
                    ? item.name
                    : 'reason' in item
                      ? item.reason
                      : item.notes
                  : ''
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
