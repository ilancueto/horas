import { useCallback, useEffect, useRef, useState } from 'react'
import type { Session, SupabaseClient } from '@supabase/supabase-js'
import { Cloud, CloudOff, RefreshCw } from 'lucide-react'
import { z } from 'zod'
import { liveQuery } from 'dexie'
import { db, getMeta, putMeta } from '../data/db'
import { connectCloud, cloudConfigured, backend } from '../data/supabase'
import { cycle, encodeChanges, retryDelay, stageInitial, type CloudRow } from '../data/syncEngine'
import { createEncryption, unlockEncryption, type Encryption } from '../data/crypto'
import { Dialog } from './base'

type Status =
  'Solo local' | 'Sincronizado' | 'Pendiente' | 'Sin conexión' | 'Error' | 'Nube bloqueada'
type Merge = { local: number; remote: number; rows: CloudRow[] }

export function useSync(enabled: boolean) {
  const [client, setClient] = useState<SupabaseClient | null>(null)
  const [session, setSession] = useState<Session | null>(null)
  const [status, setStatus] = useState<Status>('Solo local')
  const [merge, setMerge] = useState<Merge | null>(null)
  const [encryption, setEncryption] = useState<Encryption | null>(null)
  const [issue, setIssue] = useState('')
  const busy = useRef(false)
  const secret = useRef<{ config: Encryption; key: CryptoKey } | null>(null)
  const perform = useRef<() => Promise<void>>(async () => undefined)
  const confirm = useRef<() => Promise<void>>(async () => undefined)

  useEffect(() => {
    let live = true
    void connectCloud()
      .then((result) => {
        if (live) setClient(result)
      })
      .catch(() => {
        if (live) setIssue('Revisá la URL y la clave pública de Supabase.')
      })
    return () => {
      live = false
    }
  }, [])
  useEffect(() => {
    if (!client) return
    const { data } = client.auth.onAuthStateChange((_event, next) => {
      setSession((previous) => (previous?.user.id === next?.user.id ? previous : next))
    })
    return () => data.subscription.unsubscribe()
  }, [client])
  useEffect(() => {
    if (!session) secret.current = null
    if (!enabled || !session || !client) {
      setStatus('Solo local')
      setMerge(null)
      return
    }
    const api = backend(session, client)
    let alive = true
    let running = false
    let again = false
    let failures = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const user = session.user.id
    const schedule = (delay = 120) => {
      clearTimeout(timer)
      timer = setTimeout(() => void run(), delay)
    }
    async function run() {
      if (!alive) return
      if (running || busy.current) {
        again = true
        return
      }
      if (!navigator.onLine) {
        setStatus('Sin conexión')
        return
      }
      running = true
      try {
        const owner = await getMeta('syncOwner', z.string(), '')
        if (!alive) return
        if (owner && owner !== user) {
          setIssue(
            'Estos datos locales están vinculados a otra cuenta. Abrí esta cuenta en otro perfil del navegador.',
          )
          setStatus('Error')
          return
        }
        const config = await api.encryption()
        if (!alive) return
        setEncryption(config)
        if (config && secret.current?.config.salt !== config.salt) {
          setStatus('Nube bloqueada')
          return
        }
        const key = config ? secret.current?.key : undefined
        if (!owner) {
          const remote = await api.pull()
          const local = (await db.records.toArray()).filter(
            (r) =>
              !r.deleted &&
              (r.collection !== 'holidays' || !r.id.startsWith('00000000-0000-4000-8000-0000')),
          ).length
          if (!alive) return
          const remoteCount = remote.filter((r) => !r.deleted_at).length
          if (local && remoteCount) {
            setMerge({ local, remote: remoteCount, rows: remote })
            setStatus('Pendiente')
            return
          }
          await stageInitial(remote)
          await putMeta('syncOwner', user)
        }
        if (!alive) return
        setMerge(null)
        setIssue('')
        setStatus('Pendiente')
        await cycle(api, key, () => alive)
        if (!alive) return
        failures = 0
        const pending = await db.queue.count()
        setStatus(pending ? 'Pendiente' : 'Sincronizado')
        if (pending) again = true
      } catch {
        if (!alive) return
        setStatus('Error')
        setIssue('No se pudo sincronizar. Tus cambios siguen guardados en este dispositivo.')
        failures++
        schedule(retryDelay(failures))
      } finally {
        running = false
        if (again && alive && !failures) {
          again = false
          schedule()
        }
      }
    }
    perform.current = run
    confirm.current = async () => {
      if (!alive) return
      const remote = await api.pull()
      await stageInitial(remote)
      await putMeta('syncOwner', user)
      await run()
    }
    const connection = () => schedule()
    addEventListener('online', connection)
    addEventListener('offline', connection)
    const realtime = client
      .channel('horas-' + user)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'records', filter: 'user_id=eq.' + user },
        connection,
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'horas_profiles', filter: 'user_id=eq.' + user },
        connection,
      )
      .subscribe((s) => {
        if (s === 'SUBSCRIBED') schedule()
      })
    let fingerprint = ''
    const subscription = liveQuery(() => db.queue.toArray()).subscribe((rows) => {
      const next = rows
        .map((r) => r.revision)
        .sort()
        .join('|')
      if (next !== fingerprint) {
        fingerprint = next
        schedule()
      }
    })
    const poll = setInterval(connection, 45_000)
    void run()
    return () => {
      alive = false
      clearTimeout(timer)
      clearInterval(poll)
      removeEventListener('online', connection)
      removeEventListener('offline', connection)
      subscription.unsubscribe()
      void client?.removeChannel(realtime)
      perform.current = async () => undefined
      confirm.current = async () => undefined
    }
  }, [client, enabled, session])
  const syncNow = useCallback(() => perform.current(), [])
  async function agree() {
    await confirm.current().catch(() => {
      setStatus('Error')
      setIssue('No se pudo confirmar la fusión. Probá de nuevo.')
    })
  }
  async function changeEncryption(phrase: string) {
    if (!session || !enabled || !client) return
    const api = backend(session, client)
    if (encryption) {
      const key = await unlockEncryption(phrase, encryption)
      secret.current = { config: encryption, key }
      await syncNow()
      return
    }
    if (status !== 'Sincronizado')
      throw new Error('Sincronizá primero antes de activar el cifrado.')
    busy.current = true
    try {
      const { key, config } = await createEncryption(phrase)
      const rows = await api.pull()
      const changes = await encodeChanges(
        rows
          .filter((r) => r.deleted_at === null)
          .map((r) => ({
            id: r.id,
            collection: r.collection,
            revision: r.revision,
            deleted: false,
            data: r.data as never,
          })),
        key,
      )
      await api.enable(config, changes)
      secret.current = { config, key }
      setEncryption(config)
    } finally {
      busy.current = false
      await syncNow()
    }
  }
  return {
    client,
    session,
    status,
    merge,
    encryption,
    issue,
    agree,
    syncNow,
    changeEncryption,
    canSend: cloudConfigured,
  }
}
export type SyncState = ReturnType<typeof useSync>

export function SyncPanel({ sync }: { sync: SyncState }) {
  const [email, setEmail] = useState('')
  const [phrase, setPhrase] = useState('')
  const [repeat, setRepeat] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  async function action(run: () => Promise<void>, fail: string) {
    setBusy(true)
    setMessage('')
    try {
      await run()
    } catch {
      setMessage(fail)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="panel stack">
      <div className="actions">
        <h2>Sincronización</h2>
        <span className="status">
          {sync.canSend ? <Cloud size={15} /> : <CloudOff size={15} />} {sync.status}
        </span>
      </div>
      {!sync.canSend ? (
        <p className="muted">
          Tus datos se guardan en este dispositivo. Podés habilitar la nube al configurar Supabase.
        </p>
      ) : !sync.session ? (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault()
            void action(async () => {
              const { error } = await sync.client!.auth.signInWithOtp({
                email,
                options: { emailRedirectTo: location.origin + location.pathname },
              })
              if (error) throw error
              setMessage('Revisá tu correo y abrí el enlace en este dispositivo.')
            }, 'No pudimos enviar el enlace. Revisá el correo o probá en unos minutos.')
          }}
        >
          <label>
            Correo electrónico
            <input
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <div className="actions">
            <button className="primary" disabled={busy || !sync.client}>
              Enviar link de acceso
            </button>
          </div>
        </form>
      ) : (
        <>
          <p className="muted">{sync.session.user.email}</p>
          <div className="actions">
            <button disabled={busy} onClick={() => void sync.syncNow()}>
              <RefreshCw size={16} /> Sincronizar ahora
            </button>
            <button
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  const { error } = await sync.client!.auth.signOut({ scope: 'local' })
                  if (error) throw error
                }, 'No se pudo cerrar la sesión.')
              }
            >
              Cerrar sesión
            </button>
          </div>
          {sync.issue && (
            <p className="warning" role="alert">
              {sync.issue}
            </p>
          )}
          <h3>Cifrado de extremo a extremo</h3>
          {sync.encryption && sync.status !== 'Nube bloqueada' ? (
            <p className="muted">Cifrado activo para los registros en la nube.</p>
          ) : (
            <form
              className="stack"
              onSubmit={(e) => {
                e.preventDefault()
                if (!sync.encryption && phrase !== repeat) {
                  setMessage('Las frases tienen que coincidir.')
                  return
                }
                void action(
                  async () => {
                    await sync.changeEncryption(phrase)
                    setPhrase('')
                    setRepeat('')
                  },
                  sync.encryption
                    ? 'La frase no coincide o no se pudo conectar.'
                    : 'Sincronizá primero y volvé a intentar. La nube puede haber cambiado durante la activación.',
                )
              }}
            >
              <p className="muted">
                Vas a necesitar la frase en cada sesión. Si la perdés, los registros cifrados de la
                nube no se pueden recuperar.
              </p>
              <label>
                Frase de paso
                <input
                  type="password"
                  autoComplete={sync.encryption ? 'current-password' : 'new-password'}
                  value={phrase}
                  required
                  minLength={12}
                  onChange={(e) => setPhrase(e.target.value)}
                />
              </label>
              {!sync.encryption && (
                <label>
                  Repetir frase de paso
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={repeat}
                    required
                    minLength={12}
                    onChange={(e) => setRepeat(e.target.value)}
                  />
                </label>
              )}
              <div className="actions">
                <button disabled={busy || (!sync.encryption && sync.status !== 'Sincronizado')}>
                  {sync.encryption ? 'Desbloquear nube' : 'Activar cifrado'}
                </button>
              </div>
            </form>
          )}
        </>
      )}
      {!sync.session && sync.issue && (
        <p className="warning" role="alert">
          {sync.issue}
        </p>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  )
}

export function MergeSync({ sync }: { sync: SyncState }) {
  const [dismissed, setDismissed] = useState(false)
  const [busy, setBusy] = useState(false)
  if (!sync.merge) return null
  return (
    <>
      {dismissed ? (
        <button className="sync-resume" onClick={() => setDismissed(false)}>
          Revisar fusión de datos
        </button>
      ) : (
        <Dialog title="Fusionar datos" close={() => !busy && setDismissed(true)}>
          <div className="stack">
            <p>
              Encontramos {sync.merge.local} registros en este dispositivo y {sync.merge.remote} en
              la nube. Se conservan los registros de ambos orígenes. Si un mismo registro se editó
              sin conexión, su cambio pendiente se enviará al confirmar.
            </p>
            <div className="actions">
              <button
                className="primary"
                disabled={busy}
                onClick={async () => {
                  setBusy(true)
                  await sync.agree()
                  setBusy(false)
                }}
              >
                Fusionar y sincronizar
              </button>
              <button disabled={busy} onClick={() => setDismissed(true)}>
                Ahora no
              </button>
            </div>
          </div>
        </Dialog>
      )}
    </>
  )
}
