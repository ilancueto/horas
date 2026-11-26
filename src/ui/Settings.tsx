import { useEffect, useState } from 'react'
import { Clock3, Cloud, FileSpreadsheet, Plus, ShieldCheck, Timer } from 'lucide-react'
import { clock, decimal, number } from '../domain/dates'
import { compMinutes, compOpeningSeconds, decimalTotals, type DayRow } from '../domain/hours'
import { ars, extraPay } from '../domain/pay'
import {
  compOpeningCentihours,
  defaults,
  emptyLedger,
  emptyPrivate,
  settingsSchema,
  type Period,
  type Settings,
} from '../domain/model'
import {
  apply,
  diffLedger,
  markOnboarded,
  notify,
  putMeta,
  savePrivate,
  saveSettings,
  useHours,
} from '../data/db'
import { nationalHolidays } from '../domain/holidays'
import { backup } from '../data/transfer'
import { checkPin, makePin, requestReminders, type Pin } from '../data/preferences'
import { Dialog } from './base'
import { ConnectCloud, connectionText, type SyncState } from './Sync'
import { TimeField } from './Day'

const hundredthsPerComp = (compMinutes * 100) / 60

function ScheduleFields({
  draft,
  patch,
}: {
  draft: Settings
  patch: (p: Partial<Settings>) => void
}) {
  return (
    <div className="form-grid">
      <label>
        Entrada habitual
        <TimeField
          value={draft.start}
          label="Entrada habitual"
          save={(start) => start !== null && patch({ start })}
        />
      </label>
      <label>
        Salida habitual
        <TimeField
          value={draft.end}
          label="Salida habitual"
          save={(end) => end !== null && patch({ end })}
        />
      </label>
      <label>
        Descanso habitual (min)
        <input
          type="number"
          min={0}
          max={1440}
          required
          value={draft.breakMinutes}
          onChange={(e) => patch({ breakMinutes: e.target.valueAsNumber || 0 })}
        />
      </label>
      <label>
        Día típico de cierre
        <input
          type="number"
          min={1}
          max={28}
          required
          value={draft.closing}
          onChange={(e) => patch({ closing: e.target.valueAsNumber || 0 })}
        />
      </label>
      <label>
        Vacaciones anuales (días)
        <input
          type="number"
          min={0}
          max={366}
          required
          value={draft.annualLeave}
          onChange={(e) => patch({ annualLeave: e.target.valueAsNumber || 0 })}
        />
      </label>
    </div>
  )
}
export function Onboarding({
  openImport,
  start,
  sync,
}: {
  openImport: () => void
  start: () => void
  sync: SyncState
}) {
  const [setup, setSetup] = useState(false)
  const [joining, setJoining] = useState(false)
  // Un enlace a una nube cifrada deja la conexión esperando la frase de paso.
  const connectOpen = joining || sync.joinLocked
  // Mientras conecta o quedó una clave guardada, no se empieza por otro camino.
  const held = sync.connecting || sync.hasKey
  const [retry, setRetry] = useState({ busy: false, error: '' })
  const [draft, setDraft] = useState(defaults)
  async function resume() {
    setRetry({ busy: true, error: '' })
    let outcome = await sync.resumeJoin()
    if (outcome === 'ok') {
      try {
        await markOnboarded()
        sync.finishJoin()
        return
      } catch {
        outcome = 'error'
      }
    }
    // Nube cifrada: se abre el paso de la frase de paso.
    setRetry({ busy: false, error: outcome === 'locked' ? '' : connectionText[outcome] })
  }
  async function discard() {
    setRetry({ busy: true, error: '' })
    await sync.cancelJoin()
    setRetry({ busy: false, error: '' })
  }
  return (
    <main className="welcome welcome-panel">
      <div className="brand">
        <span>
          <Clock3 size={24} />
        </span>
        Horas
      </div>
      <div className="stack welcome-content">
        <h1>{setup ? 'Tu horario habitual' : 'Tus horas, en orden.'}</h1>
        {setup ? (
          <form
            className="stack"
            onSubmit={async (e) => {
              e.preventDefault()
              if (e.currentTarget.querySelector('[aria-invalid=true]')) return
              if (await saveSettings({ ...draft, onboarded: true })) start()
            }}
          >
            <ScheduleFields draft={draft} patch={(p) => setDraft((d) => ({ ...d, ...p }))} />
            <div className="actions">
              <button className="primary" disabled={held}>
                Continuar
              </button>
              <button type="button" onClick={() => setSetup(false)}>
                Atrás
              </button>
            </div>
          </form>
        ) : (
          <>
            <p className="muted">
              Registrá jornadas, horas extra y cierres de pago desde el celular o la compu.
            </p>
            <div className="actions">
              <button className="primary" disabled={held} onClick={openImport}>
                <FileSpreadsheet size={18} /> Importar mi Excel
              </button>
              <button disabled={held} onClick={() => setSetup(true)}>
                <Plus size={18} /> Empezar de cero
              </button>
            </div>
            {sync.canSend && (
              <div className="actions welcome-connect">
                <button disabled={held} onClick={() => setJoining(true)}>
                  <Cloud size={18} /> Ya tengo mis datos en la nube
                </button>
              </div>
            )}
          </>
        )}
        {!connectOpen &&
          (sync.connecting || retry.busy ? (
            <p role="status">Conectando con tu nube…</p>
          ) : (
            sync.hasKey && (
              <div className="stack">
                <p>Quedó una clave guardada que no terminó de conectar.</p>
                <div className="actions">
                  <button className="primary" onClick={() => void resume()}>
                    Reintentar
                  </button>
                  <button onClick={() => void discard()}>Cancelar</button>
                </div>
              </div>
            )
          ))}
        {!connectOpen && retry.error && (
          <p className="warning" role="alert">
            {retry.error}
          </p>
        )}
      </div>
      {connectOpen && <ConnectCloud sync={sync} close={() => setJoining(false)} />}
    </main>
  )
}
export function Lock({ pin, unlock }: { pin: Pin; unlock: () => void }) {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <main className="welcome welcome-panel">
      <div className="brand">
        <span>
          <ShieldCheck size={22} />
        </span>
        Horas
      </div>
      <form
        className="stack welcome-content"
        onSubmit={async (e) => {
          e.preventDefault()
          const value = String(new FormData(e.currentTarget).get('pin') ?? '')
          setBusy(true)
          try {
            if (await checkPin(value, pin)) unlock()
            else setError('El PIN no coincide.')
          } catch {
            setError('No se pudo comprobar el PIN.')
          } finally {
            setBusy(false)
          }
        }}
      >
        <h1>Ingresá tu PIN</h1>
        <label>
          PIN
          <input
            name="pin"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            required
            pattern="[0-9]{4,8}"
          />
        </label>
        {error && (
          <p className="warning" role="alert">
            {error}
          </p>
        )}
        <button className="primary" disabled={busy}>
          Desbloquear
        </button>
      </form>
    </main>
  )
}
export function Preferences({
  close,
  pin,
  pinChanged,
  today,
  focusComps,
}: {
  close: () => void
  pin: Pin | null
  pinChanged: (pin: Pin | null) => void
  today: string
  focusComps?: boolean
}) {
  const { settings, privateData } = useHours()
  useEffect(() => {
    if (focusComps) document.getElementById('saldo-inicial')?.scrollIntoView({ block: 'start' })
  }, [focusComps])
  const [draft, setDraft] = useState(settings)
  const [openingInput, setOpeningInput] = useState<string | null>(null)
  const openingValue =
    openingInput ?? String(decimal(compOpeningSeconds(draft) / 60)).replace('.', ',')
  const trimmedOpening = openingValue.trim()
  const parsedOpening = compOpeningCentihours.safeParse(
    /^(?:\d+(?:[,.]\d{1,2})?)?$/.test(trimmedOpening)
      ? Math.round(Number(trimmedOpening.replace(',', '.')) * 100)
      : NaN,
  )
  const [rate, setRate] = useState(privateData.rate?.toString() ?? '')
  const [enabled, setEnabled] = useState(privateData.rate !== null)
  const [pinValue, setPinValue] = useState('')
  const [clearPin, setClearPin] = useState(false)
  const [wipe, setWipe] = useState(false)
  const [wipePrivate, setWipePrivate] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const patch = (p: Partial<Settings>) => setDraft((d) => ({ ...d, ...p }))
  return (
    <Dialog title="Ajustes" close={() => !busy && close()}>
      {wipe ? (
        <div className="stack">
          <p>
            Se borrarán los períodos, jornadas y registros personales. Se descargará un respaldo
            antes de borrar.
          </p>
          <label className="check">
            <input
              type="checkbox"
              checked={wipePrivate}
              onChange={(e) => setWipePrivate(e.target.checked)}
            />{' '}
            Incluir conciliación y valor hora en el backup
          </label>
          <div className="actions">
            <button
              className="primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                try {
                  await backup(today, wipePrivate)
                  if (
                    !(await apply(
                      () =>
                        diffLedger(useHours.getState().ledger, {
                          ...emptyLedger,
                          holidays: nationalHolidays(),
                        }),
                      'Datos borrados',
                      false,
                      {
                        settings: defaults,
                        privateData: emptyPrivate,
                        clearPin: true,
                      },
                    ))
                  )
                    return
                  pinChanged(null)
                  useHours.setState({ past: [], future: [] })
                  close()
                } catch {
                  setError('No se pudieron borrar los datos.')
                } finally {
                  setBusy(false)
                }
              }}
            >
              Descargar backup y borrar
            </button>
            <button disabled={busy} onClick={() => setWipe(false)}>
              Cancelar
            </button>
          </div>
          {error && (
            <p role="alert" className="warning">
              {error}
            </p>
          )}
        </div>
      ) : (
        <form
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault()
            if (e.currentTarget.querySelector('[aria-invalid=true]')) return
            setError('')
            if (!parsedOpening.success || parsedOpening.data === null) {
              setError('Ingresá las horas con hasta dos decimales. El máximo es 7.999,99 h.')
              return
            }
            const opening = parsedOpening.data
            if (opening > 0 && draft.compSince === null) {
              setError('Elegí la fecha del saldo inicial.')
              return
            }
            const openingChanged = openingInput !== null || draft.compSince !== settings.compSince
            // Conserva un equivalente en minutos para las versiones anteriores de la app.
            const legacyMinutes = Math.min(Math.round((opening * 60) / 100), 1000 * compMinutes - 1)
            const next = openingChanged
              ? {
                  ...draft,
                  compOpeningCentihours: draft.compSince ? opening : null,
                  compOpeningDays: Math.floor(legacyMinutes / compMinutes),
                  compOpeningMinutes: legacyMinutes % compMinutes,
                }
              : draft
            if (!settingsSchema.safeParse(next).success || next.start >= next.end) {
              setError(
                'Revisá los valores. La salida habitual tiene que ser posterior a la entrada.',
              )
              return
            }
            setBusy(true)
            try {
              if ((draft.dailyReminder || draft.closingReminder) && !(await requestReminders())) {
                setError(
                  'Habilitá las notificaciones de este sitio en el navegador o desactivá los recordatorios.',
                )
                return
              }
              const nextPin = clearPin ? null : pinValue ? await makePin(pinValue) : pin
              await saveSettings(next)
              await savePrivate({ ...privateData, rate: enabled ? Number(rate) : null })
              await putMeta('pin', nextPin)
              pinChanged(nextPin)
              notify('Ajustes guardados')
              close()
            } catch {
              setError('No se pudieron guardar los ajustes.')
            } finally {
              setBusy(false)
            }
          }}
        >
          <h3>Horario y reglas</h3>
          <ScheduleFields draft={draft} patch={patch} />
          <div className="form-grid">
            <label>
              Límite del sábado
              <TimeField
                value={draft.saturday}
                label="Límite del sábado"
                save={(saturday) => saturday !== null && patch({ saturday })}
              />
            </label>
            <label>
              Antes de la entrada
              <select
                value={draft.early}
                onChange={(e) => patch({ early: e.target.value as Settings['early'] })}
              >
                <option value="extra">Al 50%</option>
                <option value="normal">Normal</option>
                <option value="double">Al 100%</option>
              </select>
            </label>
          </div>
          <h4 id="saldo-inicial">Saldo inicial de compensatorios</h4>
          <small>
            Cada 8 horas al 100% equivalen a un franco. Para un saldo nuevo, se cuentan las jornadas
            y los francos tomados desde la fecha indicada, inclusive.
          </small>
          <div className="form-grid">
            <label>
              Fecha del saldo inicial
              <input
                type="date"
                aria-label="Fecha del saldo inicial"
                value={draft.compSince ?? ''}
                onChange={(e) => patch({ compSince: e.target.value || null })}
              />
            </label>
            <label>
              Saldo inicial (horas decimales)
              <input
                type="text"
                inputMode="decimal"
                placeholder="25,51"
                value={openingValue}
                onChange={(e) => setOpeningInput(e.target.value)}
              />
            </label>
          </div>
          {parsedOpening.success && parsedOpening.data !== null && trimmedOpening && (
            <small>
              {Math.floor(parsedOpening.data / hundredthsPerComp)} francos completos ·{' '}
              {number((parsedOpening.data % hundredthsPerComp) / 100)} h restantes
            </small>
          )}
          <label className="check">
            <input
              type="checkbox"
              checked={draft.nonWorking}
              onChange={(e) => patch({ nonWorking: e.target.checked })}
            />{' '}
            Días no laborables y puentes al 100%
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={draft.lockClosed}
              onChange={(e) => patch({ lockClosed: e.target.checked })}
            />{' '}
            Bloquear edición al enviar o pagar
          </label>
          <div className="form-grid">
            <label>
              Tema
              <select
                value={draft.theme}
                onChange={(e) => patch({ theme: e.target.value as Settings['theme'] })}
              >
                <option value="auto">Automático</option>
                <option value="light">Claro</option>
                <option value="dark">Oscuro</option>
              </select>
            </label>
            <label>
              Formato de horas
              <select
                value={draft.format}
                onChange={(e) => patch({ format: e.target.value as Settings['format'] })}
              >
                <option value="clock">Horas y minutos</option>
                <option value="decimal">Decimal</option>
                <option value="both">Ambos</option>
              </select>
            </label>
          </div>
          <h3>Privacidad</h3>
          <label>
            {pin ? 'Cambiar PIN (4 a 8 dígitos)' : 'Activar PIN (4 a 8 dígitos)'}
            <input
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              pattern="[0-9]{4,8}"
              disabled={clearPin}
              value={pinValue}
              onChange={(e) => setPinValue(e.target.value)}
            />
          </label>
          {pin && (
            <label className="check">
              <input
                type="checkbox"
                checked={clearPin}
                onChange={(e) => setClearPin(e.target.checked)}
              />{' '}
              Quitar PIN
            </label>
          )}
          <small>El PIN limita el acceso desde esta pantalla en este dispositivo.</small>
          <label className="check">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />{' '}
            Valor hora para calcular extras
          </label>
          {enabled && (
            <label>
              Valor hora (ARS)
              <input
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                required
                value={rate}
                onChange={(e) => setRate(e.target.value)}
              />
            </label>
          )}
          <h3>Recordatorios</h3>
          <label className="check">
            <input
              type="checkbox"
              checked={draft.dailyReminder}
              onChange={(e) => patch({ dailyReminder: e.target.checked })}
            />{' '}
            Recordatorio diario de carga
          </label>
          {draft.dailyReminder && (
            <label>
              Hora del recordatorio
              <TimeField
                value={draft.reminderTime}
                label="Hora del recordatorio"
                save={(reminderTime) => reminderTime !== null && patch({ reminderTime })}
              />
            </label>
          )}
          <label>
            Días de aviso antes del cierre (0 desactiva)
            <input
              type="number"
              min={0}
              max={14}
              required
              value={draft.closingReminder}
              onChange={(e) => patch({ closingReminder: e.target.valueAsNumber || 0 })}
            />
          </label>
          <small>
            Los avisos se comprueban mientras Horas está abierta. La tarjeta de cierre aparece en el
            período.
          </small>
          {error && (
            <p className="warning" role="alert">
              {error}
            </p>
          )}
          <div className="actions">
            <button className="primary" disabled={busy}>
              Guardar ajustes
            </button>
            <button type="button" onClick={() => setWipe(true)}>
              Borrar todos los datos
            </button>
          </div>
        </form>
      )}
    </Dialog>
  )
}
export function Reconcile({
  period,
  rows,
  close,
}: {
  period: Period
  rows: DayRow[]
  close: () => void
}) {
  const { privateData } = useHours()
  const saved = privateData.receipt[period.id]
  const [extra, setExtra] = useState(saved?.extra?.toString() ?? '')
  const [double, setDouble] = useState(saved?.double?.toString() ?? '')
  const reported = decimalTotals(rows, Boolean(period.excel))
  const delta = (reportedHours: number, paid: string) =>
    paid === '' ? null : Math.round((Number(paid) - reportedHours) * 100) / 100
  const diff50 = delta(reported.extra, extra),
    diff100 = delta(reported.double, double)
  const rate = privateData.rate
  const pay = extraPay(reported, rate ?? 0)
  return (
    <Dialog title="Conciliar recibo" close={close}>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault()
          try {
            await savePrivate({
              ...privateData,
              receipt: {
                ...privateData.receipt,
                [period.id]: {
                  extra: extra === '' ? null : Number(extra),
                  double: double === '' ? null : Number(double),
                },
              },
            })
            notify('Conciliación guardada')
            close()
          } catch {
            notify('No se pudo guardar la conciliación.')
          }
        }}
      >
        <p className="muted">
          Ingresá las horas decimales del recibo. Se guardan en este dispositivo.
        </p>
        <div className="form-grid">
          <label>
            Horas al 50% pagadas
            <input
              type="number"
              min="0"
              step=".01"
              inputMode="decimal"
              value={extra}
              onChange={(e) => setExtra(e.target.value)}
            />
          </label>
          <label>
            Horas al 100% pagadas
            <input
              type="number"
              min="0"
              step=".01"
              inputMode="decimal"
              value={double}
              onChange={(e) => setDouble(e.target.value)}
            />
          </label>
        </div>
        <p>
          Registradas: {number(reported.extra)} h al 50% · {number(reported.double)} h al 100%
        </p>
        {(diff50 !== null || diff100 !== null) && (
          <p className={diff50 || diff100 ? 'warning' : 'muted'} role="status">
            Diferencia pagadas − registradas: {diff50 === null ? '—' : number(diff50)} h al 50% ·{' '}
            {diff100 === null ? '—' : number(diff100)} h al 100%.
          </p>
        )}
        {rate !== null && (
          <div className="tile">
            <span>Extras estimadas del período</span>
            <strong>{ars(pay.total)}</strong>
            <small>
              50% {ars(pay.extra)} · 100% {ars(pay.double)}
            </small>
          </div>
        )}
        <button className="primary">Guardar conciliación</button>
      </form>
    </Dialog>
  )
}
export function Help({ close }: { close: () => void }) {
  return (
    <Dialog title="Cómo se calculan las horas" close={close}>
      <div className="stack">
        <h3>
          <Timer size={17} /> Una jornada habitual
        </h3>
        <p>
          De lunes a viernes, 07:45–16:45 con 60 minutos de descanso da 8 horas normales. Si salís a
          las 17:20, sumás {clock(35)} al 50% ({number(decimal(35))} h).
        </p>
        <h3>Fines de semana y feriados</h3>
        <p>
          El sábado suma al 50% hasta las 13:00 y al 100% después. Domingos y feriados suman al
          100%. El descanso se descuenta en orden de normales, 50% y 100%.
        </p>
        <h3>Turnos nocturnos</h3>
        <p>
          Si la salida es igual o anterior a la entrada, se toma como salida del día siguiente. Cada
          tramo se clasifica según su fecha.
        </p>
        <h3>Atajos</h3>
        <p>
          <kbd>H</kbd> abre Hoy. <kbd>Ctrl/⌘ + Z</kbd> deshace cambios y{' '}
          <kbd>Ctrl/⌘ + Mayús + Z</kbd> los rehace. <kbd>Esc</kbd> cierra el diálogo activo.
        </p>
      </div>
    </Dialog>
  )
}
