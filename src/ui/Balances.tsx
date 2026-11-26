import { useState } from 'react'
import { Palmtree, Repeat2 } from 'lucide-react'
import { decimal, number } from '../domain/dates'
import { compBalance, compMinutes, leaveBalance } from '../domain/hours'
import { useHours } from '../data/db'
import { AbsenceForm } from './Absences'

const preciseHours = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 3 })
function balanceHours(minutes: number) {
  const rounded = decimal(minutes)
  return rounded % (compMinutes / 60) === 0 && rounded * 60 !== minutes
    ? preciseHours.format(minutes / 60)
    : number(rounded)
}

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
  const credited = comps.creditedMinutes
  const deducted = comps.taken * compMinutes
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
      <section className="panel balance-card" aria-labelledby="saldo-francos">
        <h2 id="saldo-francos">
          <Repeat2 size={19} aria-hidden="true" /> Francos compensatorios
        </h2>
        <div className="balance-overview">
          <p className={'balance-big' + (comps.available < 0 ? ' warning' : '')}>
            <strong>{comps.available}</strong>{' '}
            {Math.abs(comps.available) === 1 ? 'franco disponible' : 'francos disponibles'}
          </p>
          <p className="balance-total">
            Saldo actual <strong>{balanceHours(comps.balanceMinutes)} h</strong>
          </p>
          {comps.available < 0 && <p className="warning">Tomaste más francos de los ganados.</p>}
        </div>
        <div className="balance-progress">
          <p>
            Te faltan <strong>{balanceHours(comps.missing)} h</strong> para el próximo franco
          </p>
          <progress
            max={compMinutes}
            value={comps.remainder}
            aria-label="Progreso hacia el próximo franco"
          />
        </div>
        <dl className="balance-detail">
          <div>
            <dt>Saldo inicial</dt>
            <dd>{balanceHours(comps.openingMinutes)} h</dd>
          </div>
          <div>
            <dt>Ganadas</dt>
            <dd>
              {credited > 0 ? '+' : ''}
              {balanceHours(credited)} h
            </dd>
          </div>
          <div>
            <dt>Tomadas</dt>
            <dd>
              {deducted > 0 ? '−' : ''}
              {balanceHours(deducted)} h
            </dd>
          </div>
        </dl>
        <div className="balance-actions">
          <button className="primary" onClick={() => setForm(true)}>
            Registrar franco tomado
          </button>
          <button onClick={openComps}>Ver lista</button>
          <button onClick={openSettings}>Ajustar saldo inicial</button>
        </div>
      </section>
      <section className="panel balance-card balance-leave" aria-labelledby="saldo-vacaciones">
        <div className="title-line">
          <h2 id="saldo-vacaciones">
            <Palmtree size={19} aria-hidden="true" /> Vacaciones
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
        <p className={'balance-big' + (leaves.remaining < 0 ? ' warning' : '')}>
          <strong>{leaves.remaining}</strong>{' '}
          {Math.abs(leaves.remaining) === 1 ? 'día disponible' : 'días disponibles'}
        </p>
        <p className="muted">
          {leaves.used} {leaves.used === 1 ? 'día tomado' : 'días tomados'}
        </p>
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
