import { useEffect, useState } from 'react'
import { Activity, CalendarDays, Clock3, HelpCircle, ListChecks, Menu, Plus, Settings as SettingsIcon, Sun, Timer, Undo2, Redo2 } from 'lucide-react'
import { addDays, today } from '../domain/dates'
import { chain, dayRows, suggestPeriod } from '../domain/hours'
import type { Period } from '../domain/model'
import { initialize, notify, saveSettings, undo, useHours } from '../data/db'
import { Dialog } from './base'
import { DayEditor } from './Day'
import { PeriodEditor, PeriodView } from './Period'
import { Annual, Calendar } from './Calendar'
import { DataTools, ImportExcel, Report } from './Transfer'
import { Absences, type AbsenceView } from './Absences'

type View = 'period'|'calendar'|'annual'|'more'|AbsenceView
const nav = [
  ['period','Período',ListChecks], ['calendar','Calendario',CalendarDays],
  ['annual','Resumen anual',Activity], ['more','Más',Menu],
] as const

export function App() {
  const { ledger,settings,ready,error,notice,past,future }=useHours()
  const [view,setView]=useState<View>('period')
  const [selected,setSelected]=useState('')
  const [day,setDay]=useState('')
  const [draft,setDraft]=useState<Period>()
  const [modal,setModal]=useState('')
  const now=today()
  const periods=chain(ledger.periods)
  const current=periods.find(p=>p.from<=now&&p.to>=now)
  const period=periods.find(p=>p.id===selected)??current??periods.at(-1)
  const dayPeriod=periods.find(p=>p.from<=day&&p.to>=day)
  const rows=period?dayRows(period,ledger,settings,now):[]
  useEffect(()=>{void initialize()},[])
  useEffect(()=>{
    const media=matchMedia('(prefers-color-scheme: dark)')
    const update=()=>{document.documentElement.dataset.theme=settings.theme==='auto'?(media.matches?'dark':'light'):settings.theme}
    update();media.addEventListener('change',update);return ()=>media.removeEventListener('change',update)
  },[settings.theme])
  useEffect(()=>{
    if(!notice)return
    const timer=setTimeout(()=>notify(''),5500)
    return ()=>clearTimeout(timer)
  },[notice])
  function choose(id:string) { setSelected(id);setView('period');window.scrollTo(0,0) }
  function openDay(date:string) {
    if(periods.some(p=>p.from<=date&&p.to>=date)) setDay(date)
    else { notify('No hay un período que incluya esa fecha.');setDraft(suggestPeriod(periods,settings,date)) }
  }
  function move(view:View) {setView(view);window.scrollTo(0,0)}
  const shortcut = (event: KeyboardEvent) => {
    if (event.target instanceof HTMLElement && (event.target.closest('input, textarea, select, [contenteditable]') || document.querySelector('dialog[open]'))) return
    if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z'){event.preventDefault();void undo(event.shiftKey)}
    if(!event.altKey&&!event.ctrlKey&&!event.metaKey&&event.key.toLowerCase()==='h'){event.preventDefault();openDay(now)}
  }
  useEffect(()=>{window.addEventListener('keydown',shortcut);return ()=>window.removeEventListener('keydown',shortcut)})
  if(!ready)return <main className="welcome" aria-busy="true"><div className="brand"><span><Clock3/></span>Horas</div><div className="skeleton"/><div className="skeleton short"/></main>
  if(error)return <main className="welcome stack"><h1>No se pudo abrir Horas</h1><p>{error}</p><button onClick={()=>void initialize()}>Reintentar</button></main>
  return <div className="app">
    <aside className="sidebar">
      <div className="brand"><span><Clock3 size={22}/></span>Horas</div>
      <p className="side-label">Registro personal</p>
      <nav aria-label="Navegación principal">{nav.map(([value,label,Icon])=><button key={value} aria-current={view===value?'page':undefined} onClick={()=>move(value)}><Icon size={19}/>{label}</button>)}</nav>
      <div className="side-foot"><span className="status"><i/> Solo local</span><small>Argentina · es-AR</small></div>
    </aside>
    <main className="workspace" id="contenido">
      <header className="topbar"><div className="mobile-brand brand"><span><Clock3 size={21}/></span>Horas</div><span className="desktop-label">Registro de jornadas</span>
        <div className="actions"><button className="icon history-button" aria-label="Deshacer" disabled={!past.length} onClick={()=>void undo()}><Undo2 size={18}/></button><button className="icon history-button" aria-label="Rehacer" disabled={!future.length} onClick={()=>void undo(true)}><Redo2 size={18}/></button><button className="primary" aria-label="Cargar hoy" onClick={()=>openDay(now)}><Plus size={18}/> Hoy</button></div>
      </header>
      <div className="content" key={view}>
        {view==='period'&&<PeriodView period={period} periods={periods} rows={rows} today={now} choose={choose} edit={()=>setDraft(period)} add={()=>setDraft(suggestPeriod(periods,settings,now))} openDay={openDay} report={()=>setModal('report')}/>}
        {view==='calendar'&&<Calendar today={now} open={openDay}/>}
        {view==='annual'&&<Annual today={now} choose={choose}/>}
        {(view==='comps'||view==='leaves'||view==='holidays')&&<Absences key={view} view={view} today={now}/>}
        {view==='more'&&<section className="stack"><h1>Más</h1><div className="panel actions"><button onClick={()=>move('comps')}>Compensatorio</button><button onClick={()=>move('leaves')}>Vacaciones</button><button onClick={()=>move('holidays')}>Feriados</button><button onClick={()=>setModal('settings')}><SettingsIcon size={18}/> Ajustes</button><button onClick={()=>setModal('help')}><HelpCircle size={18}/> Ayuda</button></div><DataTools today={now} openImport={()=>setModal('import')}/></section>}
      </div>
    </main>
    <nav className="bottom-nav" aria-label="Navegación móvil">{nav.map(([value,label,Icon])=><button key={value} aria-current={view===value?'page':undefined} onClick={()=>move(value)}><Icon size={20}/>{value==='annual'?'Resumen':label}</button>)}</nav>
    {draft&&<PeriodEditor draft={draft} close={()=>setDraft(undefined)} select={choose}/>}
    {day&&dayPeriod&&<DayEditor key={day} date={day} period={dayPeriod} close={()=>setDay('')} previous={ledger.entries.find(e=>e.date===addDays(day,-1))}/>}
    {modal==='settings'&&<Dialog title="Ajustes" close={()=>setModal('')}><label><Sun size={17}/> Tema<select value={settings.theme} onChange={e=>void saveSettings({theme:e.target.value as typeof settings.theme})}><option value="auto">Automático</option><option value="light">Claro</option><option value="dark">Oscuro</option></select></label></Dialog>}
    {modal==='help'&&<Dialog title="Ayuda" close={()=>setModal('')}><p><Timer size={18}/> Usá la grilla o el botón Hoy para registrar entradas y salidas.</p></Dialog>}
    {modal==='report'&&period&&<Report period={period} rows={rows} close={()=>setModal('')}/>} 
    {modal==='import'&&<ImportExcel close={()=>setModal('')} onDone={()=>move('period')}/>}
    {notice&&<div className="toast" role="status"><span>{notice}</span>{past.length>0&&<button onClick={()=>void undo()}>Deshacer</button>}<button className="icon" aria-label="Cerrar aviso" onClick={()=>notify('')}>×</button></div>}
  </div>
}
