import { clock, decimal, fmtDate, monthEnd, number } from '../domain/dates'
import { summarize, type DayRow } from '../domain/hours'
import type { Period } from '../domain/model'

const show=(minutes:number)=>clock(minutes)+' ('+number(decimal(minutes))+' h)'
export function reportText(period:Period,rows:DayRow[],detail:'all'|'extra'){
  const t=summarize(rows)
  return [
    'Registro de horas · '+fmtDate(period.to,{month:'long',year:'numeric'}),
    'Período '+fmtDate(period.from)+' a '+fmtDate(period.to)+' · Pago '+fmtDate(monthEnd(period.to)),
    '',
    'Normales '+show(t.normal)+'   |   Al 50% '+show(t.extra)+'   |   Al 100% '+show(t.double),
    'Total '+show(t.total)+' · '+t.worked+' días trabajados · '+t.guards+' guardias',
    '',
    detail==='extra'?'Detalle de horas extra':'Detalle de jornadas',
    ...rows.filter(r=>detail==='extra'?r.hours.extra||r.hours.double:r.hours.total||r.entry?.guard||r.comp||r.vac)
      .map(r=>fmtDate(r.date)+'  |  '+(detail==='all'?'Total '+clock(r.hours.total)+'  |  Normal '+clock(r.hours.normal)+'  |  ':'')+'50% '+clock(r.hours.extra)+'  |  100% '+clock(r.hours.double)+(r.comp?'  |  Comp':'')+(r.vac?'  |  Vac':'')+(r.entry?.guard?'  |  Guardia':'')),
  ].join('\n')
}
export async function downloadPDF(period:Period,rows:DayRow[],detail:'all'|'extra'){
  const {jsPDF}=await import('jspdf')
  const doc=new jsPDF()
  const lines=reportText(period,rows,detail).split('\n')
  function header(){
    doc.setFillColor(23,62,57);doc.rect(0,0,210,32,'F')
    doc.setTextColor(255,252,246);doc.setFont('times','bold');doc.setFontSize(23);doc.text('Horas',16,21)
    doc.setTextColor(36,40,35);doc.setFont('helvetica','normal');doc.setFontSize(10)
  }
  header()
  let y=44
  for(const [index,line] of lines.entries()){
    if(y>275){doc.addPage();header();y=44}
    if(index===0){doc.setFont('times','bold');doc.setFontSize(18)}
    if(index===7||index>7&&index%2===1){doc.setFillColor(245,242,235);doc.rect(14,y-4,182,6,'F')}
    doc.text(line,16,y)
    if(index===0){doc.setFont('helvetica','normal');doc.setFontSize(10)}
    y+=index===0?8:6
  }
  for(let i=1;i<=doc.getNumberOfPages();i++){doc.setPage(i);doc.setFontSize(8);doc.text(String(i)+' / '+doc.getNumberOfPages(),194,287,{align:'right'})}
  doc.save((detail==='extra'?'RRHH-':'Horas-')+period.to+'.pdf')
}
