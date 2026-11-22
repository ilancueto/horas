import type { Session, SupabaseClient } from '@supabase/supabase-js'
import { encryptionSchema, type Encryption } from './crypto'
import { cloudRowSchema, type Backend, type ChangePacket, type CloudRow } from './syncEngine'

const url=import.meta.env.VITE_SUPABASE_URL
const key=import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
export const cloudConfigured=Boolean(url&&key)
let connecting:Promise<SupabaseClient>|undefined
export function connectCloud(){
  if(!cloudConfigured)return Promise.resolve(null)
  connecting ??= import('@supabase/supabase-js').then(({createClient})=>createClient(url,key))
  return connecting
}
export function backend(session:Session,api:SupabaseClient):Backend & {
  encryption:()=>Promise<Encryption|null>
  enable:(config:Encryption,changes:ChangePacket[])=>Promise<void>
} {
  const owner=session.user.id
  return {
    async pull(){
      const rows:CloudRow[]=[]
      let cursor:string|undefined
      for(;;){
        let query=api.from('records').select('id,collection,data,revision,updated_at,deleted_at').eq('user_id',owner).order('id').limit(500)
        if(cursor)query=query.gt('id',cursor)
        const {data,error}=await query
        if(error)throw error
        const batch=cloudRowSchema.array().parse(data)
        rows.push(...batch)
        if(batch.length<500)return rows
        cursor=batch.at(-1)!.id
      }
    },
    async push(changes,encrypted){
      const {error}=await api.rpc('horas_push',{changes,encrypted})
      if(error)throw error
    },
    async encryption(){
      const {data,error}=await api.from('horas_profiles').select('encryption').eq('user_id',owner).maybeSingle()
      if(error)throw error
      return data?.encryption?encryptionSchema.parse(data.encryption):null
    },
    async enable(config,changes){
      const {error}=await api.rpc('horas_enable_encryption',{config,changes})
      if(error)throw error
    },
  }
}
