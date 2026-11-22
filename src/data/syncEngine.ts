import { z } from 'zod'
import { collections, rulesRecordSchema, type Collection } from '../domain/model'
import { db, reload, type Row } from './db'
import { seal, unseal } from './crypto'

export const cloudRowSchema=z.object({
  id:z.uuid(),collection:z.enum(['periods','entries','comps','leaves','holidays','rules']),
  data:z.unknown().nullable(),revision:z.uuid(),updated_at:z.iso.datetime({offset:true}),
  deleted_at:z.iso.datetime({offset:true}).nullable(),
})
export type CloudRow=z.infer<typeof cloudRowSchema>
export type ChangePacket={id:string;collection:Collection | 'rules';revision:string;deleted:boolean;data:unknown}
export type Backend={
  pull:()=>Promise<CloudRow[]>
  push:(changes:ChangePacket[], encrypted:boolean)=>Promise<void>
}
const context=(row:{id:string;collection:Collection | 'rules';revision:string})=>[row.collection,row.id,row.revision].join('|')

export async function encodeChanges(rows:Row[],key?:CryptoKey):Promise<ChangePacket[]>{
  return Promise.all(rows.map(async row=>({
    id:row.id,collection:row.collection,revision:row.revision,deleted:row.deleted,
    data:row.deleted?null:key?await seal(key,row.data,context(row)):row.data,
  })))
}
export async function decryptRows(rows:CloudRow[],key?:CryptoKey){
  return Promise.all(rows.map(async row=>{
    if(row.deleted_at)return {...row,data:null}
    const data=(row.collection==='rules' ? rulesRecordSchema : collections[row.collection]).parse(key?await unseal(key,row.data,context(row)):row.data)
    if(data.id!==row.id)throw new Error('Invalid record id')
    return {...row,data}
  }))
}
function compareTimestamp(left:string,right:string) {
  const epochDifference=Date.parse(left)-Date.parse(right)
  if(epochDifference) return epochDifference
  const extra=(value:string)=>Number((value.match(/\.(\d+)/)?.[1]??'').padEnd(6,'0').slice(3,6))
  return extra(left)-extra(right)
}
export function preferRemote(local:Row|undefined, remote:CloudRow, pending:Row|undefined){
  return !pending&&(!local?.updatedAt||compareTimestamp(local.updatedAt,remote.updated_at)<=0)
}
export async function cycle(backend:Backend,key?:CryptoKey,active=()=>true){
  const pending=await db.queue.toArray()
  if(!active())return
  for(let i=0;i<pending.length;i+=100){
    const batch=pending.slice(i,i+100)
    const encoded=await encodeChanges(batch,key)
    if(!active())return
    await backend.push(encoded,Boolean(key))
  }
  if(!active())return
  const remote=await decryptRows(await backend.pull(),key)
  if(!active())return
  await db.transaction('rw',db.queue,db.records,async()=>{
    for(const item of pending){
      const current=await db.queue.get(item.id)
      if(current?.revision===item.revision)await db.queue.delete(item.id)
    }
    const queued=new Map((await db.queue.toArray()).map(row=>[row.id,row]))
    const local=new Map((await db.records.toArray()).map(row=>[row.id,row]))
    const updates:Row[]=[]
    for(const row of remote){
      const old=local.get(row.id)
      if(!preferRemote(old,row,queued.get(row.id)))continue
      if(!row.data&&!old)continue
      if(old?.revision===row.revision&&old.updatedAt===row.updated_at)continue
      updates.push({id:row.id,collection:row.collection,data:row.data??old!.data,deleted:Boolean(row.deleted_at),revision:row.revision,updatedAt:row.updated_at})
    }
    await db.records.bulkPut(updates)
  })
  if(active())await reload()
}
export async function stageInitial(remote:CloudRow[]) {
  await db.transaction('rw',db.records,db.queue,async()=>{
    const remoteIds=new Set(remote.map(row=>row.id))
    const existing=new Set((await db.queue.toArray()).map(row=>row.id))
    // Los feriados de fábrica ya están precargados en cada dispositivo.
    const locals=(await db.records.toArray()).filter(row=>!row.deleted&&row.collection!=='holidays'&&!remoteIds.has(row.id)&&!existing.has(row.id))
    await db.queue.bulkPut(locals)
  })
}
export const retryDelay=(failures:number)=>Math.min(60_000,1_000*2**Math.min(6,Math.max(0,failures-1)))
