import { useState } from 'react'
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Search,
  Plus,
  SlidersHorizontal,
} from 'lucide-react'
import { clock, daysBetween, decimal, fmtDate, monthEnd, number } from '../domain/dates'
import { chain, decimalTotals, entryWarnings, summarize, type DayRow } from '../domain/hours'
import { blankEntry, periodSchema, type Entry, type Period } from '../domain/model'
import { apply, notify, useHours } from '../data/db'
import { Dialog, Empty } from './base'
import { DayBadge, Hours, TimeField } from './Day'

export const periodName = (period: Period) => fmtDate(period.to, { month: 'long', year: 'numeric' })
export function PeriodEditor({
  draft,
  close,
  select,
}: {
  draft: Period
  close: () => void
  select: (id: string) => void
}) {
  const { ledger, settings } = useHours()
  const [period, setPeriod] = useState(draft)
  const [warning, setWarning] = useState('')
  const ordered = chain(ledger.periods)
  const index = ordered.findIndex((p) => p.id === period.id)
  const previous = index < 0 ? ordered.at(-1) : ordered[index - 1]
  const next = index < 0 ? undefined : ordered[index + 1]
  const locked = draft.status !== 'Abierto' && settings.lockClosed
  return (
    <Dialog title={index < 0 ? 'Nuevo período' : 'Editar período'} close={close}>
      <form
        className="stack"
        onChange={() => setWarning('')}
        onSubmit={async (e) => {
          e.preventDefault()
          if (
            !periodSchema.safeParse(period).success ||
            daysBetween(period.from, period.to) > 366 ||
            (next && period.to >= next.to) ||
            ordered.some((p) => p.id !== period.id && p.to === period.to)
          ) {
            setWarning(
              'Revisá las fechas. El cierre tiene que quedar entre los períodos vecinos y el rango puede tener hasta un año.',
            )
            return
          }
          const all = chain([...ordered.filter((p) => p.id !== period.id), period])
          const orphaned = ledger.entries.some(
            (e) =>
              ordered.some((p) => p.from <= e.date && p.to >= e.date) &&
              !all.some((p) => p.from <= e.date && p.to >= e.date),
          )
          if (orphaned) {
            setWarning(
              'Estas fechas dejarían jornadas registradas fuera de sus períodos. Revisá el rango.',
            )
            return
          }
          if (next && settings.lockClosed && next.status !== 'Abierto' && period.to !== draft.to) {
            setWarning('Abrí el período siguiente antes de cambiar este cierre.')
            return
          }
          const changes = all
            .filter(
              (p) => JSON.stringify(p) !== JSON.stringify(ordered.find((old) => old.id === p.id)),
            )
            .map((item) => ({ collection: 'periods' as const, item }))
          if (await apply(changes, 'Período guardado')) {
            select(period.id)
            close()
          }
        }}
      >
        <div className="form-grid">
          <label>
            Desde
            <input
              required
              type="date"
              value={period.from}
              disabled={!!previous || locked}
              onChange={(e) => setPeriod({ ...period, from: e.target.value })}
            />
          </label>
          <label>
            Hasta
            <input
              required
              type="date"
              value={period.to}
              disabled={locked}
              onChange={(e) => setPeriod({ ...period, to: e.target.value })}
            />
          </label>
        </div>
        <label>
          Estado
          <select
            value={period.status}
            onChange={(e) => setPeriod({ ...period, status: e.target.value as Period['status'] })}
          >
            {['Abierto', 'Enviado a RRHH', 'Pagado'].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        {locked && (
          <p className="muted">
            Este período está bloqueado. Guardalo como Abierto para cambiar sus fechas.
          </p>
        )}
        {warning && (
          <p role="alert" className="warning">
            {warning}
          </p>
        )}
        <button className="primary">Guardar período</button>
      </form>
    </Dialog>
  )
}

export function PeriodView({
  period,
  periods,
  rows,
  today,
  choose,
  edit,
  add,
  openDay,
  report,
  reconcile,
}: {
  period?: Period
  periods: Period[]
  rows: DayRow[]
  today: string
  choose: (id: string) => void
  edit: () => void
  add: () => void
  openDay: (day: string) => void
  report: () => void
  reconcile: () => void
}) {
  const { ledger, settings } = useHours()
  const [filter, setFilter] = useState('all')
  const [query, setQuery] = useState('')
  if (!period)
    return (
      <Empty title="Tu primer período">
        <p>Elegí la fecha de cierre para empezar a registrar jornadas.</p>
        <button className="primary" onClick={add}>
          <Plus size={18} /> Nuevo período
        </button>
      </Empty>
    )
  const index = periods.findIndex((p) => p.id === period.id)
  const totals = summarize(rows)
  const reported = decimalTotals(rows, Boolean(period.excel))
  const remaining = daysBetween(today, period.to)
  const progress = Math.min(
    100,
    Math.max(
      0,
      (100 * daysBetween(period.from, today)) / Math.max(1, daysBetween(period.from, period.to)),
    ),
  )
  const filtered = rows.filter(
    (r) =>
      (!query ||
        r.entry?.notes.toLocaleLowerCase('es-AR').includes(query.toLocaleLowerCase('es-AR'))) &&
      (filter === 'all' ||
        (filter === 'pending' && r.pending) ||
        (filter === 'guards' && r.entry?.guard) ||
        (filter === 'extras' && (r.hours.extra || r.hours.double))),
  )
  const locked = period.status !== 'Abierto' && settings.lockClosed
  function save(row: DayRow, patch: Partial<Entry>) {
    if (locked) {
      notify('El período está bloqueado. Cambiá su estado para editar.')
      return
    }
    const entry = { ...(row.entry ?? blankEntry(row.date, settings)), ...patch }
    const warnings = entryWarnings(entry, period!, ledger.entries)
    void apply(
      () => {
        const latest = useHours.getState().ledger.entries.find((e) => e.date === row.date)
        return [{ collection: 'entries', item: { ...(latest ?? entry), ...patch } }]
      },
      warnings.join(' ') || 'Jornada guardada',
    )
  }
  return (
    <>
      <header className="title-line">
        <div>
          <p className="eyebrow">
            <CalendarDays size={15} /> Período de pago
          </p>
          <h1 className="capitalize">{periodName(period)}</h1>
          <p className="muted range">
            {fmtDate(period.from)} – {fmtDate(period.to)} <span>·</span> Pago{' '}
            {fmtDate(monthEnd(period.to))}
          </p>
        </div>
        <div className="actions period-nav">
          <button
            className="icon"
            aria-label="Período anterior"
            disabled={index === 0}
            onClick={() => choose(periods[index - 1].id)}
          >
            <ChevronLeft size={20} />
          </button>
          <select
            aria-label="Seleccionar período"
            value={period.id}
            onChange={(e) => choose(e.target.value)}
          >
            {periods.map((p) => (
              <option key={p.id} value={p.id}>
                {fmtDate(p.to, { month: 'short', year: 'numeric' })}
              </option>
            ))}
          </select>
          <button
            className="icon"
            aria-label="Período siguiente"
            disabled={index === periods.length - 1}
            onClick={() => choose(periods[index + 1].id)}
          >
            <ChevronRight size={20} />
          </button>
          <button onClick={add}>
            <Plus size={16} /> Período
          </button>
        </div>
      </header>
      <div className="actions status-line">
        <span className="status">
          <i />
          {period.status}
        </span>
        <button onClick={edit}>Editar período</button>
        <button onClick={report}>Resumen para RRHH</button>
        <button onClick={reconcile}>Conciliar recibo</button>
      </div>
      <section className="overview overview-period" aria-label="Totales del período">
        <div className="tile total-tile">
          <span>
            <Clock3 size={17} /> Horas registradas
          </span>
          <strong>
            <Hours value={totals.total} decimalValue={reported.total} format={settings.format} />
          </strong>
          <small>
            {totals.worked} {totals.worked === 1 ? 'día trabajado' : 'días trabajados'}
          </small>
        </div>
        <div className="tile split-tile">
          {(
            [
              ['Normales', 'normal'],
              ['Al 50%', 'extra'],
              ['Al 100%', 'double'],
            ] as const
          ).map(([label, key]) => (
            <div key={key}>
              <span className={key}>{label}</span>
              <strong>
                <Hours value={totals[key]} decimalValue={reported[key]} format={settings.format} />
              </strong>
            </div>
          ))}
        </div>
        <div className="tile closing-tile">
          <span>
            {remaining < 0
              ? 'Período cerrado'
              : remaining === 0
                ? 'Cierre hoy'
                : 'Cierre en ' + remaining + ' días'}
          </span>
          <progress max={100} value={progress} aria-label="Progreso hasta el cierre" />
          <small>
            {totals.guards} guardias · {totals.blocks} bloques · {totals.comp} comp.
          </small>
        </div>
      </section>
      {period.excel && (
        <details className="reference">
          <summary>Totales de la planilla original</summary>
          <div className="reference-grid">
            {(
              [
                ['Normales', 'normal'],
                ['Al 50%', 'extra'],
                ['Al 100%', 'double'],
                ['Total', 'total'],
              ] as const
            ).map(([label, key]) => (
              <div key={key}>
                <strong>{label}</strong>
                <small>Excel {number(period.excel![key])} h</small>
                <small>Por minutos exactos {number(decimal(totals[key]))} h</small>
              </div>
            ))}
          </div>
          <small>
            Este período muestra los decimales con el redondeo por jornada de Excel. El formato h:mm
            conserva los minutos exactos.
          </small>
        </details>
      )}
      {totals.pending > 0 && (
        <div className="pending-banner">
          <span>
            <i className="pending-dot" /> Faltan cargar {totals.pending}{' '}
            {totals.pending === 1 ? 'día' : 'días'}
          </span>
          <button
            onClick={() => {
              setFilter(filter === 'pending' ? 'all' : 'pending')
              setQuery('')
            }}
          >
            {filter === 'pending' ? 'Ver todos' : 'Ver pendientes'}
          </button>
        </div>
      )}
      <section className="register" aria-label="Jornadas">
        <header className="register-head">
          <div>
            <h2>Jornadas</h2>
            <small>{rows.length} días en el período</small>
          </div>
          <div className="actions">
            <label className="search">
              <Search size={16} />
              <input
                type="search"
                aria-label="Buscar en notas"
                placeholder="Buscar notas"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <label className="filter">
              <SlidersHorizontal size={16} />
              <select
                aria-label="Filtrar jornadas"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              >
                <option value="all">Todas</option>
                <option value="pending">Pendientes</option>
                <option value="guards">Guardias</option>
                <option value="extras">Horas extra</option>
              </select>
            </label>
          </div>
        </header>
        {locked && (
          <p className="lock-note">
            Edición bloqueada. Podés reabrir el período desde «Editar período».
          </p>
        )}
        {!filtered.length ? (
          <Empty title="Sin jornadas para mostrar">
            <p>Probá con otros filtros.</p>
          </Empty>
        ) : (
          <>
            <div className="table-wrap">
              <table className="daily">
                <thead>
                  <tr>
                    {[
                      'Fecha',
                      'Día',
                      'Entrada',
                      'Salida',
                      'Desc.',
                      'Guardia',
                      'Horas',
                      'Normales',
                      '50%',
                      '100%',
                      'Notas',
                    ].map((h) => (
                      <th scope="col" key={h}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((row) => (
                    <tr key={row.date} className={row.tone}>
                      <th scope="row">
                        <button className="date-link" onClick={() => openDay(row.date)}>
                          {fmtDate(row.date, { day: '2-digit', month: '2-digit' })}
                        </button>
                      </th>
                      <td>
                        <span className="weekday">{fmtDate(row.date, { weekday: 'short' })}</span>
                        <DayBadge row={row} />
                      </td>
                      <td>
                        <TimeField
                          label={'Entrada ' + row.date}
                          value={row.entry?.start ?? null}
                          disabled={locked}
                          save={(start) => save(row, { start })}
                        />
                      </td>
                      <td>
                        <TimeField
                          label={'Salida ' + row.date}
                          value={row.entry?.end ?? null}
                          disabled={locked}
                          save={(end) => save(row, { end })}
                        />
                      </td>
                      <td>
                        <input
                          key={row.entry?.breakMinutes ?? settings.breakMinutes}
                          type="number"
                          aria-label={'Descanso ' + row.date}
                          disabled={locked}
                          min={0}
                          max={1440}
                          defaultValue={row.entry?.breakMinutes ?? settings.breakMinutes}
                          onBlur={(e) => {
                            const n = e.target.valueAsNumber
                            if (
                              e.target.validity.valid &&
                              Number.isInteger(n) &&
                              n !== (row.entry?.breakMinutes ?? settings.breakMinutes)
                            )
                              save(row, { breakMinutes: n })
                          }}
                        />
                      </td>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={'Guardia ' + row.date}
                          checked={row.entry?.guard ?? false}
                          disabled={locked}
                          onChange={(e) => save(row, { guard: e.target.checked })}
                        />
                      </td>
                      {(['total', 'normal', 'extra', 'double'] as const).map((k) => (
                        <td key={k} className={row.hours[k] ? k : ''}>
                          {row.hours[k] ? (
                            <Hours value={row.hours[k]} format={settings.format} />
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                      ))}
                      <td>
                        <input
                          key={row.entry?.notes ?? ''}
                          className="notes-input"
                          aria-label={'Notas ' + row.date}
                          placeholder="Agregar…"
                          defaultValue={row.entry?.notes ?? ''}
                          disabled={locked}
                          onBlur={(e) => {
                            if (e.target.value !== (row.entry?.notes ?? ''))
                              save(row, { notes: e.target.value })
                          }}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="day-cards">
              {filtered.map((row) => (
                <article className={'day-card ' + row.tone} key={row.date}>
                  <div>
                    <strong>
                      {fmtDate(row.date, { weekday: 'long', day: 'numeric', month: 'short' })}
                    </strong>
                    <DayBadge row={row} />
                    <small>
                      {row.entry?.start != null && row.entry.end != null
                        ? clock(row.entry.start) +
                          ' – ' +
                          clock(row.entry.end) +
                          ' · ' +
                          row.entry.breakMinutes +
                          ' min descanso'
                        : 'Sin horario cargado'}
                    </small>
                    {!!row.hours.total && (
                      <small>
                        Normal {clock(row.hours.normal)} · 50% {clock(row.hours.extra)} · 100%{' '}
                        {clock(row.hours.double)}
                      </small>
                    )}
                    {row.entry?.notes && <small className="wrap-anywhere">{row.entry.notes}</small>}
                  </div>
                  <div className="card-action">
                    <Hours value={row.hours.total} format={settings.format} />
                    <button
                      aria-label={'Editar jornada ' + row.date}
                      onClick={() => openDay(row.date)}
                    >
                      {locked ? 'Ver' : 'Editar'}
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </>
        )}
      </section>
    </>
  )
}
