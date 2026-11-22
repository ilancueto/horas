import { z } from 'zod'
import { daysBetween, localMinute, today } from '../domain/dates'
import { getMeta, putMeta } from './db'
import type { Period, Settings } from '../domain/model'

export const pinSchema=z.object({salt:z.string(),digest:z.string()})
export type Pin=z.infer<typeof pinSchema>
const hex=(bytes:Uint8Array)=>Array.from(bytes,v=>v.toString(16).padStart(2,'0')).join('')
async function pinDigest(pin:string,salt:string){
  const encoder=new TextEncoder()
  const key=await crypto.subtle.importKey('raw',encoder.encode(pin),'PBKDF2',false,['deriveBits'])
  const bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt:encoder.encode(salt),iterations:150000,hash:'SHA-256'},key,256)
  return hex(new Uint8Array(bits))
}
export async function makePin(pin:string):Promise<Pin>{
  const salt=hex(crypto.getRandomValues(new Uint8Array(16)))
  return {salt,digest:await pinDigest(pin,salt)}
}
export const checkPin=async(pin:string,stored:Pin)=>(await pinDigest(pin,stored.salt))===stored.digest

export async function requestReminders(){
  if(!('Notification'in window))return false
  return Notification.permission==='granted'||(await Notification.requestPermission())==='granted'
}
export async function checkReminders(settings:Settings,periods:Period[],hasEntry:(date:string)=>boolean){
  if(!('Notification'in window)||Notification.permission!=='granted'||(!settings.dailyReminder&&!settings.closingReminder))return
  const date=today()
  const active=periods.find(p=>p.from<=date&&date<=p.to&&p.status==='Abierto')
  if(!active)return
  const remaining=daysBetween(date,active.to)
  const daily=settings.dailyReminder&&localMinute()>=settings.reminderTime&&!hasEntry(date)
  const closing=settings.closingReminder>0&&remaining>=0&&remaining<=settings.closingReminder
  if(!daily&&!closing)return
  const registration=await navigator.serviceWorker?.getRegistration()
  const key='reminder-'+date
  const kinds=await getMeta(key,z.array(z.string()),[])
  const send=async(kind:string,body:string)=>{
    if(kinds.includes(kind))return
    if(registration)await registration.showNotification('Horas',{body,tag:'horas-'+kind,icon:'/icon.svg',data:{url:'/?hoy=1'}})
    else new Notification('Horas',{body,tag:'horas-'+kind})
    kinds.push(kind)
  }
  if(closing)await send('closing',remaining===0?'El período cierra hoy.':'El período cierra en '+remaining+' días.')
  if(daily)await send('daily','Cargá las horas de hoy.')
  await putMeta(key,kinds)
}
