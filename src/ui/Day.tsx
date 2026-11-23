import { useState, type CSSProperties } from 'react'
import { Copy, WandSparkles } from 'lucide-react'
import { clock, clockInput, decimal, fmtDate, number, parseClock } from '../domain/dates'
import { entryWarnings, type DayRow } from '../domain/hours'
import { blankEntry, leaveLabels, type Entry, type Period, type Settings } from '../domain/model'
import { apply, notify, useHours } from '../data/db'
import { DeleteActions, Dialog } from './base'

export function Hours({
  value,
  format,
  decimalValue = decimal(value),
  roll = false,
}: {
  value: number
  format: Settings['format']
  decimalValue?: number
  roll?: boolean
}) {
  const text = format === 'decimal' ? number(decimalValue) : clock(value)
  return (
    <span className="hours" title={number(decimalValue) + ' h · ' + clock(value)}>
      {roll
        ? [...text].map((ch, i) => (
            <span
              key={i + ch}
              className={/\d/.test(ch) ? 'dg' : 'sep'}
              style={{ '--i': i } as CSSProperties}
            >
              {ch}
            </span>
          ))
        : text}
      {format === 'both' && <small> / {number(decimalValue)} h</small>}
    </span>
  )
}

export function TimeField({
  value,
  save,
  label,
  disabled,
}: {
  value: number | null
  save: (value: number | null) => void
  label: string
  disabled?: boolean
}) {
  const [input, setInput] = useState<string | null>(null)
  const [invalid, setInvalid] = useState(false)
  function finish() {
    if (input === null) return
    const time = parseClock(input)
    if (time === undefined) {
      setInvalid(true)
      notify('Ingresá una hora válida. Por ejemplo, 0745 o 07:45.')
      return
    }
    setInvalid(false)
    setInput(null)
    if (time !== value) save(time)
  }
  return (
    <input
      aria-label={label}
      aria-invalid={invalid}
      disabled={disabled}
      inputMode="numeric"
      placeholder="--:--"
      maxLength={5}
      value={input ?? clockInput(value)}
      onChange={(e) => {
        const text = e.target.value
        setInput(text)
        setInvalid(false)
      }}
      onBlur={finish}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
      }}
    />
  )
}

export function DayEditor({
  date,
  close,
  period,
  previous,
}: {
  date: string
  close: () => void
  period: Period
  previous?: Entry
}) {
  const { ledger, settings } = useHours()
  const [deleting, setDeleting] = useState(false)
  const [entry, setEntry] = useState(
    () => ledger.entries.find((e) => e.date === date) ?? blankEntry(date, settings),
  )
  const locked = period.status !== 'Abierto' && settings.lockClosed
  const warnings = entryWarnings(entry, period, ledger.entries)
  const patch = (value: Partial<Entry>) => setEntry((e) => ({ ...e, ...value }))
  return (
    <Dialog title={fmtDate(date, { weekday: 'long', day: 'numeric', month: 'long' })} close={close}>
      {deleting ? (
        <DeleteActions
          cancel={() => setDeleting(false)}
          remove={async () => {
            if (
              await apply(
                [{ collection: 'entries', item: entry, deleted: true }],
                'Jornada borrada',
              )
            )
              close()
          }}
        />
      ) : (
        <form
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault()
            if (
              locked ||
              e.currentTarget.querySelector('[aria-invalid=true]') ||
              entry.breakMinutes < 0 ||
              entry.breakMinutes > 1440
            )
              return
            if (
              await apply(
                [{ collection: 'entries', item: entry }],
                warnings.length ? warnings.join(' ') : 'Jornada guardada',
              )
            )
              close()
          }}
        >
          {locked && (
            <p role="status">
              Este período está bloqueado. Cambiá su estado a Abierto para editar.
            </p>
          )}
          <div className="actions">
            <button
              type="button"
              disabled={locked}
              onClick={() =>
                patch({
                  start: settings.start,
                  end: settings.end,
                  breakMinutes: settings.breakMinutes,
                })
              }
            >
              <WandSparkles size={16} /> Horario estándar
            </button>
            <button
              type="button"
              disabled={locked || !previous}
              onClick={() =>
                previous &&
                patch({
                  start: previous.start,
                  end: previous.end,
                  breakMinutes: previous.breakMinutes,
                })
              }
            >
              <Copy size={16} /> Copiar día anterior
            </button>
          </div>
          <div className="form-grid">
            <label>
              Entrada
              <TimeField
                key={'start-' + entry.start}
                value={entry.start}
                label="Entrada"
                disabled={locked}
                save={(start) => patch({ start })}
              />
            </label>
            <label>
              Salida
              <TimeField
                key={'end-' + entry.end}
                value={entry.end}
                label="Salida"
                disabled={locked}
                save={(end) => patch({ end })}
              />
            </label>
            <label>
              Descanso (min)
              <input
                type="number"
                min="0"
                max="1440"
                value={entry.breakMinutes}
                disabled={locked}
                onChange={(e) => patch({ breakMinutes: e.target.valueAsNumber || 0 })}
              />
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={entry.guard}
                disabled={locked}
                onChange={(e) => patch({ guard: e.target.checked })}
              />
              Guardia
            </label>
          </div>
          <label>
            Notas
            <textarea
              rows={2}
              value={entry.notes}
              disabled={locked}
              onChange={(e) => patch({ notes: e.target.value })}
            />
          </label>
          {warnings.map((warning) => (
            <p className="warning" key={warning}>
              {warning}
            </p>
          ))}
          <div className="actions">
            <button className="primary" disabled={locked}>
              Guardar jornada
            </button>
            {ledger.entries.some((e) => e.id === entry.id) && (
              <button type="button" disabled={locked} onClick={() => setDeleting(true)}>
                Borrar jornada
              </button>
            )}
          </div>
        </form>
      )}
    </Dialog>
  )
}
export function DayBadge({ row }: { row: DayRow }) {
  return (
    <span className="badges">
      {row.vac && (
        <span className="badge vac" title="Vacaciones">
          Vac
        </span>
      )}
      {row.leave && row.leave !== 'vacaciones' && (
        <span className="badge lic" title={leaveLabels[row.leave].label}>
          {leaveLabels[row.leave].short}
        </span>
      )}
      {row.comp && (
        <span className="badge comp" title="Compensatorio">
          Comp
        </span>
      )}
      {row.holiday && (
        <span className="badge week" title={row.holiday.name}>
          {row.holiday.kind === 'feriado' ? 'Fer' : 'No lab.'}
        </span>
      )}
      {row.entry?.guard && <span className="badge guard">Guardia</span>}
      {row.pending && (
        <span className="pending-dot" role="img" title="Falta cargar" aria-label="Falta cargar" />
      )}
    </span>
  )
}
