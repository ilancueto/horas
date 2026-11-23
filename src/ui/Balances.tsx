import { useState } from 'react'
import { Palmtree, Repeat2 } from 'lucide-react'
import { clock } from '../domain/dates'
import { compBalance, compMinutes, leaveBalance } from '../domain/hours'
import { useHours } from '../data/db'
import { AbsenceForm } from './Absences'

export function Balances({
  today,
  openSettings,
  openComps,
}: {
  today: string
  openSettings: () => void
  openComps: () => void
}) {
  const { ledger, settings } = useHours()
  const [form, setForm] = useState(false)
  const [year, setYear] = useState(today.slice(0, 4))
  const comps = compBalance(ledger, settings, today)
  const leaves = leaveBalance(ledger.leaves, year, settings.annualLeave)
  const years = [
    ...new Set([
      today.slice(0, 4),
      ...ledger.leaves.flatMap((l) => [l.from.slice(0, 4), l.to.slice(0, 4)]),
    ]),
  ].sort()
  const k = comps.taken - comps.opening
  const earned =
    k < 0 && settings.compSince
      ? settings.compSince
      : k >= 0 && k < comps.earnedDates.length
        ? comps.earnedDates[k]
        : today
  return (
    <section className="stack balances">
      <h1>Saldos</h1>
      <section className="panel stack" aria-labelledby="saldo-francos">
        <h2 id="saldo-francos">
          <Repeat2 size={19} aria-hidden="true" /> Francos compensatorios
        </h2>
        <p className={'balance-big' + (comps.available < 0 ? ' warning' : '')}>
          <strong>{comps.available}</strong>{' '}
          {Math.abs(comps.available) === 1 ? 'disponible' : 'disponibles'}
        </p>
        {comps.available < 0 && <p className="warning">Tomaste más francos de los ganados.</p>}
        <p className="muted">
          Ganados {comps.earned} · Tomados {comps.taken} · Saldo inicial {comps.opening}
        </p>
        <div className="balance-progress">
          <p>
            Acumulado al 100%: {clock(comps.remainder)} — faltan {clock(comps.missing)} para el
            próximo franco
          </p>
          <progress
            max={compMinutes}
            value={comps.remainder}
            aria-label="Progreso hacia el próximo franco"
          />
        </div>
        <div className="actions">
          <button className="primary" onClick={() => setForm(true)}>
            Registrar franco tomado
          </button>
          <button onClick={openSettings}>Cargar saldo inicial</button>
          <button onClick={openComps}>Ver lista</button>
        </div>
      </section>
      <section className="panel stack" aria-labelledby="saldo-vacaciones">
        <div className="title-line">
          <h2 id="saldo-vacaciones">
            <Palmtree size={19} aria-hidden="true" /> Vacaciones {year}
          </h2>
          <select
            className="year-picker"
            aria-label="Año de vacaciones"
            value={year}
            onChange={(e) => setYear(e.target.value)}
          >
            {years.map((y) => (
              <option key={y}>{y}</option>
            ))}
          </select>
        </div>
        <div className="absence-summary">
          {(
            [
              [settings.annualLeave, 'Disponibles'],
              [leaves.used, 'Tomados'],
              [leaves.remaining, 'Saldo'],
            ] as const
          ).map(([n, label]) => (
            <div className="tile" key={label}>
              <span>{label}</span>
              <strong>{n}</strong>
            </div>
          ))}
        </div>
      </section>
      {form && (
        <AbsenceForm
          view="comps"
          today={today}
          initial={{ earned, taken: today }}
          close={() => setForm(false)}
        />
      )}
    </section>
  )
}
