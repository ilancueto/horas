import { useEffect, useState } from 'react'
import { flushSync } from 'react-dom'
import {
  Activity,
  CalendarDays,
  Clock3,
  HelpCircle,
  ListChecks,
  Menu,
  Plus,
  Scale,
  Settings as SettingsIcon,
  Undo2,
  Redo2,
} from 'lucide-react'
import { addDays, today } from '../domain/dates'
import { chain, dayRows, suggestPeriod } from '../domain/hours'
import type { Period } from '../domain/model'
import { getMeta, initialize, notify, undo, useHours } from '../data/db'
import { DayEditor } from './Day'
import { PeriodEditor, PeriodView } from './Period'
import { Annual, Calendar } from './Calendar'
import { DataTools, ImportExcel, Report } from './Transfer'
import { Absences, type AbsenceView } from './Absences'
import { Balances } from './Balances'
import { Help, Lock, Onboarding, Preferences, Reconcile } from './Settings'
import { MergeSync, SyncPanel, useSync } from './Sync'
import { checkReminders, pinSchema, type Pin } from '../data/preferences'

type View = 'period' | 'calendar' | 'balances' | 'calculator' | 'annual' | 'more' | AbsenceView
const nav = [
  ['period', 'Período', ListChecks],
  ['calendar', 'Calendario', CalendarDays],
  ['balances', 'Saldos', Scale],
  ['annual', 'Resumen anual', Activity],
  ['more', 'Más', Menu],
] as const

export function App() {
  const { ledger, settings, ready, error, notice, undoNotice, past, future } = useHours()
  const [view, setView] = useState<View>('period')
  const [selected, setSelected] = useState('')
  const [day, setDay] = useState('')
  const [requestedDay, setRequestedDay] = useState('')
  const [draft, setDraft] = useState<Period>()
  const [modal, setModal] = useState('')
  const [pin, setPin] = useState<Pin | null>(null)
  const [pinReady, setPinReady] = useState(false)
  const [unlocked, setUnlocked] = useState(false)
  const [now, setNow] = useState(today)
  const [shortcutRequested, setShortcutRequested] = useState(
    () => new URLSearchParams(location.search).get('hoy') === '1',
  )
  const sync = useSync(ready && pinReady && (!pin || unlocked))
  const periods = chain(ledger.periods)
  const current = periods.find((p) => p.from <= now && p.to >= now)
  const period = periods.find((p) => p.id === selected) ?? current ?? periods.at(-1)
  const dayPeriod = periods.find((p) => p.from <= day && p.to >= day)
  const rows = period ? dayRows(period, ledger, settings, now) : []
  useEffect(() => {
    void initialize()
    void getMeta('pin', pinSchema.nullable(), null)
      .then(setPin)
      .finally(() => setPinReady(true))
      .catch(() => undefined)
  }, [])
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)')
    const update = () => {
      document.documentElement.dataset.theme =
        settings.theme === 'auto' ? (media.matches ? 'dark' : 'light') : settings.theme
    }
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [settings.theme])
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => notify(''), 5500)
    return () => clearTimeout(timer)
  }, [notice])
  useEffect(() => {
    if (!ready || !settings.onboarded) return
    const tick = () => {
      setNow(today())
      void checkReminders(settings, chain(ledger.periods), (date) =>
        ledger.entries.some((e) => e.date === date && e.start !== null && e.end !== null),
      ).catch(() => undefined)
    }
    tick()
    const timer = setInterval(tick, 30_000)
    return () => clearInterval(timer)
  }, [ready, settings, ledger.entries, ledger.periods])
  function choose(id: string) {
    setSelected(id)
    setView('period')
    window.scrollTo(0, 0)
  }
  function openDay(date: string) {
    if (periods.some((p) => p.from <= date && p.to >= date)) setDay(date)
    else {
      const proposed = suggestPeriod(periods, settings, date)
      if (proposed.from > date) {
        notify('No hay un período que incluya esa fecha. Revisá las fechas de cierre.')
        return
      }
      setRequestedDay(date)
      setDraft(proposed)
    }
  }
  function move(next: View) {
    const run = () => {
      flushSync(() => setView(next))
      window.scrollTo(0, 0)
    }
    if (document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches)
      document.startViewTransition(run)
    else run()
  }
  function closeDraft() {
    setDraft(undefined)
    setRequestedDay('')
  }
  function savePeriod(id: string) {
    choose(id)
    if (
      requestedDay &&
      useHours
        .getState()
        .ledger.periods.some((p) => p.id === id && p.from <= requestedDay && p.to >= requestedDay)
    )
      setDay(requestedDay)
  }
  useEffect(() => {
    if (ready && pinReady && (!pin || unlocked) && shortcutRequested) {
      setShortcutRequested(false)
      history.replaceState(null, '', location.pathname)
      openDay(now)
    }
  })
  const shortcut = (event: KeyboardEvent) => {
    if (
      !settings.onboarded ||
      (pin && !unlocked) ||
      (event.target instanceof HTMLElement &&
        (event.target.closest('input, textarea, select, [contenteditable]') ||
          document.querySelector('dialog[open]')))
    )
      return
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault()
      void undo(event.shiftKey)
    }
    if (!event.altKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'h') {
      event.preventDefault()
      openDay(now)
    }
  }
  useEffect(() => {
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  })
  const toast = notice && (
    <div className="toast" role="status">
      <span>{notice}</span>
      {undoNotice && past.length > 0 && <button onClick={() => void undo()}>Deshacer</button>}
      <button className="icon" aria-label="Cerrar aviso" onClick={() => notify('')}>
        ×
      </button>
    </div>
  )
  if (!ready || !pinReady)
    return (
      <main className="welcome" aria-busy="true">
        <div className="brand">
          <span>
            <Clock3 />
          </span>
          Horas
        </div>
        <div className="skeleton" />
        <div className="skeleton short" />
      </main>
    )
  if (error)
    return (
      <main className="welcome stack">
        <h1>No se pudo abrir Horas</h1>
        <p>{error}</p>
        <button onClick={() => void initialize()}>Reintentar</button>
      </main>
    )
  if (pin && !unlocked) return <Lock pin={pin} unlock={() => setUnlocked(true)} />
  if (!settings.onboarded)
    return (
      <>
        <Onboarding
          openImport={() => setModal('import')}
          start={() => setDraft(suggestPeriod(periods, useHours.getState().settings, now))}
        />
        {modal === 'import' && (
          <ImportExcel close={() => setModal('')} onDone={() => move('period')} />
        )}
        {toast}
      </>
    )
  return (
    <div className="app">
      <a className="skip-link" href="#contenido">
        Ir al contenido
      </a>
      <header className="topbar">
        <div className="brand">
          <span>
            <Clock3 size={22} />
          </span>
          Horas
        </div>
        <nav aria-label="Navegación principal">
          {nav.map(([value, label, Icon]) => (
            <button
              key={value}
              aria-current={view === value ? 'page' : undefined}
              onClick={() => move(value)}
            >
              <Icon size={18} />
              {label}
            </button>
          ))}
        </nav>
        <div className="actions">
          <span className="status desk-sync">
            <i /> {sync.status}
          </span>
          {sync.canSend && (
            <span className="status mobile-sync">
              <i />
              {sync.status}
            </span>
          )}
          <button
            className="icon history-button"
            aria-label="Deshacer"
            disabled={!past.length}
            onClick={() => void undo()}
          >
            <Undo2 size={18} />
          </button>
          <button
            className="icon history-button"
            aria-label="Rehacer"
            disabled={!future.length}
            onClick={() => void undo(true)}
          >
            <Redo2 size={18} />
          </button>
          <button className="primary" aria-label="Cargar hoy" onClick={() => openDay(now)}>
            <Plus size={18} /> Hoy
          </button>
        </div>
      </header>
      <main className="workspace" id="contenido">
        <div className="content" key={view}>
          {view === 'period' && (
            <PeriodView
              period={period}
              periods={periods}
              rows={rows}
              today={now}
              choose={choose}
              edit={() => setDraft(period)}
              add={() => setDraft(suggestPeriod(periods, settings, now))}
              openDay={openDay}
              report={() => setModal('report')}
              reconcile={() => setModal('receipt')}
            />
          )}
          {view === 'calendar' && <Calendar today={now} open={openDay} />}
          {view === 'annual' && <Annual today={now} choose={choose} />}
          {(view === 'comps' ||
            view === 'leaves' ||
            view === 'licenses' ||
            view === 'holidays') && (
            <Absences key={view} view={view} today={now} openBalances={() => move('balances')} />
          )}
          {view === 'balances' && (
            <Balances
              today={now}
              openSettings={() => setModal('settings-comps')}
              openComps={() => move('comps')}
            />
          )}
          {view === 'more' && (
            <section className="stack">
              <h1>Más</h1>
              <div className="panel actions">
                <button onClick={() => move('comps')}>Compensatorio</button>
                <button onClick={() => move('leaves')}>Vacaciones</button>
                <button onClick={() => move('licenses')}>Licencias</button>
                <button onClick={() => move('holidays')}>Feriados</button>
                <button onClick={() => setModal('settings')}>
                  <SettingsIcon size={18} /> Ajustes
                </button>
                <button onClick={() => setModal('help')}>
                  <HelpCircle size={18} /> Ayuda
                </button>
              </div>
              <SyncPanel sync={sync} />
              <div className="panel actions mobile-history">
                <button disabled={!past.length} onClick={() => void undo()}>
                  <Undo2 size={17} /> Deshacer
                </button>
                <button disabled={!future.length} onClick={() => void undo(true)}>
                  <Redo2 size={17} /> Rehacer
                </button>
              </div>
              <DataTools today={now} openImport={() => setModal('import')} />
            </section>
          )}
        </div>
      </main>
      <nav className="bottom-nav" aria-label="Navegación móvil">
        {nav.map(([value, label, Icon]) => (
          <button
            key={value}
            aria-current={view === value ? 'page' : undefined}
            onClick={() => move(value)}
          >
            <Icon size={20} />
            {value === 'annual' ? 'Resumen' : label}
          </button>
        ))}
      </nav>
      {draft && <PeriodEditor draft={draft} close={closeDraft} select={savePeriod} />}
      {day && dayPeriod && (
        <DayEditor
          key={day}
          date={day}
          period={dayPeriod}
          close={() => setDay('')}
          previous={ledger.entries.find((e) => e.date === addDays(day, -1))}
        />
      )}
      {(modal === 'settings' || modal === 'settings-comps') && (
        <Preferences
          close={() => setModal('')}
          today={now}
          focusComps={modal === 'settings-comps'}
          pin={pin}
          pinChanged={(value) => {
            setPin(value)
            setUnlocked(true)
          }}
        />
      )}
      {modal === 'help' && <Help close={() => setModal('')} />}
      {modal === 'receipt' && period && (
        <Reconcile key={period.id} period={period} rows={rows} close={() => setModal('')} />
      )}
      {modal === 'report' && period && (
        <Report period={period} rows={rows} close={() => setModal('')} />
      )}
      {modal === 'import' && (
        <ImportExcel close={() => setModal('')} onDone={() => move('period')} />
      )}
      <MergeSync sync={sync} />
      {toast}
    </div>
  )
}
