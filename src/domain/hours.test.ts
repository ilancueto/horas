import { describe, expect, it } from 'vitest'
import { addDays, decimal, monthEnd } from './dates'
import { calculate, chain, dayRows, leaveBalance, overlapsLeave, summarize } from './hours'
import { blankEntry, defaults, emptyLedger, type Holiday, type Period } from './model'

describe('horas por franja', () => {
  const fri = '2026-10-16', sat = '2026-10-17', sun = '2026-10-18'
  const holiday: Holiday = { id: crypto.randomUUID(), date: '2026-10-20', name: 'Prueba', kind: 'feriado' }
  it.each([
    [fri,465,1005,60,8,0,0],[fri,465,1040,60,8,.58,0],
    ['2026-10-19',465,1125,60,8,2,0],[sat,465,900,60,0,4.25,2],
    [sat,450,1020,60,0,4.5,4],[sun,480,720,60,0,0,3],[sun,480,840,60,0,0,5],
    [holiday.date,480,720,60,0,0,3],[sat,1320,360,60,0,0,7],
    [fri,1320,360,60,0,7,0],[fri,465,510,60,0,0,0],[fri,960,1080,90,0,.5,0],
  ])('%s %i–%i, descanso %i', (date,start,end,breakMinutes,normal,extra,double) => {
    const h = calculate({ ...blankEntry(date, defaults), start, end, breakMinutes }, defaults, new Map([[holiday.date, holiday]]))
    expect([decimal(h.normal), decimal(h.extra), decimal(h.double)]).toEqual([normal, extra, double])
    expect(h.total).toBe(h.normal+h.extra+h.double)
  })
  it('no suma un turno incompleto', () => {
    expect(calculate({ ...blankEntry(fri, defaults), start: 465 }, defaults, new Map()).total).toBe(0)
  })
})
it('encadena los períodos y determina la fecha de pago', () => {
  const periods: Period[] = [['2026-10-15','2026-11-12'],['2026-11-13','2026-12-14'],['2026-12-15','2027-01-14']].map(([from,to]) => ({id:crypto.randomUUID(),from,to,status:'Abierto'}))
  expect(monthEnd(periods[0].to)).toBe('2026-11-30')
  periods[0].to='2026-11-15'
  periods[1].to='2026-12-17'
  expect(chain(periods).map(p=>p.from)).toEqual(['2026-10-15','2026-11-16','2026-12-18'])
})
it('marca ausencias, calcula saldo y agrupa guardias consecutivas', () => {
  const from='2026-10-15', to='2026-10-20'
  const leaves=[{id:crypto.randomUUID(),from:addDays(from,2),to:addDays(from,3),notes:''}]
  const entries=[0,1,4].map(i=>({...blankEntry(addDays(from,i),defaults),guard:true}))
  const comps=[{id:crypto.randomUUID(),earned:from,reason:'',taken:to}]
  const rows=dayRows({from,to},{...emptyLedger,leaves,entries,comps},defaults,to)
  expect(rows[2].tone).toBe('vac')
  expect(rows.at(-1)?.tone).toBe('comp')
  expect(summarize(rows).blocks).toBe(2)
  expect(overlapsLeave(leaves,{...leaves[0],id:crypto.randomUUID()})).toBe(true)
  expect(leaveBalance(leaves,'2026',14)).toEqual({used:2,remaining:12})
})
