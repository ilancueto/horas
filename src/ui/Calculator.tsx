import { useState } from 'react'
import { number } from '../domain/dates'
import { chain, dayRows, decimalTotals } from '../domain/hours'
import { ars, extraPay, extraRates } from '../domain/pay'
import { useHours } from '../data/db'
import { Empty } from './base'
import { periodName } from './Period'

export function Calculator({
  periodId,
  today,
  openSettings,
}: {
  periodId?: string
  today: string
  openSettings: () => void
}) {
  const { ledger, settings, privateData } = useHours()
  const periods = chain(ledger.periods)
  const [chosen, setChosen] = useState(periodId ?? '')
  // Valor de prueba: vive solo en esta vista y nunca se guarda.
  const [test, setTest] = useState<string | null>(null)
  const period =
    periods.find((p) => p.id === chosen) ??
    periods.find((p) => p.from <= today && p.to >= today) ??
    periods.at(-1)
  if (!period)
    return (
      <Empty title="Calculadora de extras">
        <p>Creá un período para calcular el valor de tus horas extra.</p>
      </Empty>
    )
  const saved = privateData.rate
  const value = test ?? saved?.toString() ?? ''
  const parsed = Number(value)
  const rate = value !== '' && Number.isFinite(parsed) && parsed > 0 ? parsed : 0
  const hours = decimalTotals(dayRows(period, ledger, settings, today), Boolean(period.excel))
  const pay = extraPay(hours, rate)
  const lines = [
    ['Al 50%', 'extra', hours.extra, rate * extraRates.extra, pay.extra],
    ['Al 100%', 'double', hours.double, rate * extraRates.double, pay.double],
  ] as const
  return (
    <section className="stack calculator">
      <header className="title-line">
        <h1>Calculadora de extras</h1>
        <label className="calc-period">
          Período
          <select value={period.id} onChange={(e) => setChosen(e.target.value)}>
            {periods.map((p) => (
              <option key={p.id} value={p.id}>
                {periodName(p).replace(/^./, (c) => c.toLocaleUpperCase('es-AR'))}
              </option>
            ))}
          </select>
        </label>
      </header>
      <div className="panel stack">
        <label className="calc-rate">
          Valor hora
          <input
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            placeholder="$ 0,00"
            aria-describedby="calc-rate-note"
            value={value}
            onChange={(e) => setTest(e.target.value)}
          />
        </label>
        <small id="calc-rate-note" className="muted">
          {saved !== null ? 'De Ajustes · ' : ''}No se guarda si lo cambiás
        </small>
        {saved === null && (
          <div className="balance-link">
            <p>Cargá tu valor hora en Ajustes para no tener que repetirlo.</p>
            <button onClick={openSettings}>Ajustes</button>
          </div>
        )}
      </div>
      <section className="panel calc-rows" aria-label="Resultado">
        {lines.map(([label, key, h, unit, amount]) => (
          <div className="calc-row" key={key}>
            <span className={'calc-label ' + key}>{label}</span>
            <span className="calc-formula">
              {number(h)} h × {ars(unit)}
            </span>
            <strong>{ars(amount)}</strong>
          </div>
        ))}
        <div className="calc-row calc-total">
          <span className="calc-label">Total extras</span>
          <strong role="status">{ars(pay.total)}</strong>
        </div>
        <small className="muted">
          Usa las horas decimales del período{period.excel ? ' con el redondeo de Excel' : ''},
          igual que el recibo. Es una estimación.
        </small>
      </section>
    </section>
  )
}
