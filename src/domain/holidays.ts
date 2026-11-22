import { addDays, weekday } from './dates'
import type { Holiday } from './model'

// IDs estables para que los feriados precargados se fusionen entre dispositivos.
export const holidayId = (date: string) => '00000000-0000-4000-8000-0000' + date.replaceAll('-', '')
const fixed = [
  ['01-01','Año Nuevo'], ['03-24','Memoria por la Verdad y la Justicia'],
  ['04-02','Veteranos y Caídos en Malvinas'], ['05-01','Día del Trabajo'],
  ['05-25','Revolución de Mayo'], ['06-20','Manuel Belgrano'],
  ['07-09','Día de la Independencia'], ['12-08','Inmaculada Concepción'], ['12-25','Navidad'],
]
const movable = [['06-17','Martín Miguel de Güemes'],['08-17','José de San Martín'],['10-12','Respeto a la Diversidad Cultural'],['11-20','Día de la Soberanía Nacional']]
const move = (date: string) => addDays(date, ({2:-1,3:-2,4:4,5:3} as Record<number,number>)[weekday(date)] ?? 0)
export function nationalHolidays(): Holiday[] {
  const values = new Map<string,Holiday>()
  function add(date:string,name:string,kind:Holiday['kind']='feriado') {
    if (!values.has(date)) values.set(date,{ id:holidayId(date),date,name,kind })
  }
  for (const [year,easter] of [['2026','2026-04-05'],['2027','2027-03-28']]) {
    for (const [date,name] of fixed) add(year+'-'+date,name)
    for (const [date,name] of movable) add(move(year+'-'+date),name)
    add(addDays(easter,-48),'Lunes de Carnaval')
    add(addDays(easter,-47),'Martes de Carnaval')
    add(addDays(easter,-2),'Viernes Santo')
    add(addDays(easter,-3),'Jueves Santo','no laborable')
  }
  for (const date of ['2026-03-23','2026-07-10','2026-12-07']) add(date,'Día no laborable con fines turísticos','puente')
  add('2026-11-09','Feriado nacional extraordinario')
  return [...values.values()].sort((a,b)=>a.date.localeCompare(b.date))
}
