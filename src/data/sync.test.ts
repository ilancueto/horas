import 'fake-indexeddb/auto'
import { beforeEach, expect, it } from 'vitest'
import { blankEntry, defaults } from '../domain/model'
import { apply, db, readLedger } from './db'
import { cycle, retryDelay, stageInitial, type Backend, type CloudRow } from './syncEngine'
import { createEncryption, seal, unlockEncryption, unseal } from './crypto'

class MockBackend implements Backend {
  rows=new Map<string,CloudRow>()
  revisions=new Set<string>()
  time=0
  online=true
  async pull(){return [...this.rows.values()]}
  async push(changes:Parameters<Backend['push']>[0]){
    if(!this.online)throw new Error('offline')
    for(const change of changes){
      if(this.revisions.has(change.revision))continue
      this.revisions.add(change.revision)
      const updated_at=new Date(Date.UTC(2026,10,1,0,0,++this.time)).toISOString()
      this.rows.set(change.id,{id:change.id,collection:change.collection,data:change.data,revision:change.revision,updated_at,deleted_at:change.deleted?updated_at:null})
    }
  }
}
beforeEach(async()=>{await db.records.clear();await db.queue.clear()})
it('conserva la cola offline, aplica la última escritura, sincroniza y conserva tombstones',async()=>{
  const server=new MockBackend()
  const entry={...blankEntry('2026-11-10',defaults),notes:'Uno'}
  await apply([{collection:'entries',item:entry}])
  server.online=false
  await expect(cycle(server)).rejects.toThrow('offline')
  expect(await db.queue.count()).toBe(1)
  server.online=true
  await cycle(server)
  expect(await db.queue.count()).toBe(0)
  await server.push([{id:entry.id,collection:'entries',revision:crypto.randomUUID(),deleted:false,data:{...entry,notes:'Dos'}}])
  await cycle(server)
  expect((await readLedger()).entries[0].notes).toBe('Dos')
  await apply([{collection:'entries',item:entry,deleted:true}])
  await cycle(server)
  expect((await readLedger()).entries).toHaveLength(0)
  expect(server.rows.get(entry.id)?.deleted_at).toBeTruthy()
  expect(retryDelay(3)).toBe(4000)
})
it('fusiona una primera conexión sin descartar registros de ninguno de los dispositivos',async()=>{
  const server=new MockBackend()
  const offline=blankEntry('2026-11-10',defaults),online=blankEntry('2026-11-11',defaults)
  await apply([{collection:'entries',item:offline}])
  await server.push([{id:online.id,collection:'entries',revision:crypto.randomUUID(),deleted:false,data:online}])
  await stageInitial(await server.pull())
  await cycle(server)
  expect((await readLedger()).entries.map(r=>r.date).sort()).toEqual([offline.date,online.date])
})
it('permite recuperar un registro cifrado solo con la frase y el contexto correctos',async()=>{
  const {config,key}=await createEncryption('Una frase de ejemplo de prueba')
  const locked=await seal(key,{notes:'Reservado'},'id|revision')
  const unlocked=await unlockEncryption('Una frase de ejemplo de prueba',config)
  await expect(unseal(unlocked,locked,'id|revision')).resolves.toEqual({notes:'Reservado'})
  await expect(unseal(unlocked,locked,'otro')).rejects.toThrow()
  await expect(unlockEncryption('Otra frase de ejemplo',config)).rejects.toThrow()
})
