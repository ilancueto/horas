import { useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { addDays, clock, fmtDate, monthEnd, monthOffset, weekday } from '../domain/dates'
import { chain, dayRows, summarize } from '../domain/hours'
import { useHours } from '../data/db'
import { DayBadge, Hours } from './Day'
import { Empty } from './base'
import { periodName } from './Period'

export function Calendar({ today, open }: { today:string; open:(date:string)=>void }) {
  const { ledger,settings }=useHours()
  const [month,setMonth]=useState(today.slice(0,7))
  const first=month+'-01'
  const last=monthEnd(first)
  const start=addDays(first,-((weekday(first)+6)%7))
  const end=addDays(last,(7-weekday(last))%7)
  const rows=dayRows({from:start,to:end},ledger,settings,today)
  return <section className="stack">
    <div className="title-line"><div><p className="eyebrow">Vista mensual</p><h1>Calendario</h1></div>
      <div className="actions"><button className="icon" aria-label="Mes anterior" onClick={()=>setMonth(monthOffset(month,-1))}><ChevronLeft size={20}/></button><button onClick={()=>setMonth(today.slice(0,7))}>Este mes</button><button className="icon" aria-label="Mes siguiente" onClick={()=>setMonth(monthOffset(month,1))}><ChevronRight size={20}/></button></div>
    </div>
    <div className="panel"><h2 className="capitalize">{fmtDate(first,{month:'long',year:'numeric'})}</h2>
      <div className="calendar">{['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'].map(d=><small className="calendar-label" key={d}>{d}</small>)}
        {rows.map(row=><button key={row.date} className={'calendar-day '+row.tone+(row.date.slice(0,7)!==month?' outside':'')} aria-current={row.date===today?'date':undefined} aria-label={fmtDate(row.date)+(row.hours.total?' · '+clock(row.hours.total)+' horas':'')} onClick={()=>open(row.date)}>
          <strong>{Number(row.date.slice(-2))}</strong><DayBadge row={row}/>{!!row.hours.total&&<Hours value={row.hours.total} format="clock"/>}
        </button>)}
      </div>
      <div className="actions legend"><span className="badge week">Feriado / fin de semana</span><span className="badge guard">Guardia</span><span className="badge comp">Compensatorio</span><span className="badge vac">Vacaciones</span></div>
    </div>
  </section>
}
export function Annual({ today, choose }: { today:string; choose:(id:string)=>void }) {
  const { ledger,settings }=useHours()
  const [year,setYear]=useState(today.slice(0,4))
  const periods=chain(ledger.periods)
  const years=[...new Set([today.slice(0,4),...periods.map(p=>p.to.slice(0,4))])].sort()
  const data=periods.filter(p=>p.to.startsWith(year)).map(p=>({p,...summarize(dayRows(p,ledger,settings,today))}))
  const max=Math.max(1,...data.map(d=>d.total))
  const total=data.reduce((sum,d)=>sum+d.total,0)
  const extra=data.reduce((sum,d)=>sum+d.extra+d.double,0)
  const worked=data.reduce((sum,d)=>sum+d.worked,0)
  return <section className="stack">
    <div className="title-line"><div><p className="eyebrow">Resumen por período</p><h1>Resumen anual</h1></div><select aria-label="Año del resumen" value={year} onChange={e=>setYear(e.target.value)}>{years.map(y=><option key={y}>{y}</option>)}</select></div>
    <div className="overview"><div className="tile total-tile"><span>Acumulado del año</span><strong><Hours value={total} format={settings.format}/></strong></div>
      <div className="tile"><span>Horas extra promedio</span><strong><Hours value={Math.round(extra/Math.max(1,data.length))} format={settings.format}/></strong><small>Por período</small></div>
      <div className="tile"><span>Días trabajados</span><strong>{worked}</strong><small>Promedio {new Intl.NumberFormat('es-AR',{maximumFractionDigits:1}).format(worked/Math.max(1,data.length))} por período</small></div></div>
    <div className="panel stack"><h2>Horas por período</h2><div className="actions legend"><span className="badge normal">Normales</span><span className="badge extra">50%</span><span className="badge double">100%</span></div>
      {data.length?data.map(d=><div key={d.p.id} className="chart-row"><button onClick={()=>choose(d.p.id)}>{periodName(d.p)}</button><div className="chart" role="img" aria-label={'Normales '+clock(d.normal)+', al 50% '+clock(d.extra)+', al 100% '+clock(d.double)}>{(['normal','extra','double'] as const).map(k=><span key={k} className={k} style={{width:(100*d[k]/max)+'%'}}/>)}</div><Hours value={d.total} format={settings.format}/></div>):<Empty title="Todavía no hay períodos en este año"><p>El resumen aparece cuando guardás un período.</p></Empty>}
    </div>
  </section>
}
