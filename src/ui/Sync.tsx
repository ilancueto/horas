import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Cloud, CloudOff, RefreshCw } from 'lucide-react'
import { z } from 'zod'
import { liveQuery } from 'dexie'
import { db, getMeta, putMeta } from '../data/db'
import {
  CloudError,
  cloudConfigured,
  cloudHost as host,
  cloudOrigin as owner,
  cloudUrl,
  createCloud,
  linkedOwner,
} from '../data/cloud'
import { cycle, encodeChanges, retryDelay, stageInitial, type CloudRow } from '../data/syncEngine'
import { createEncryption, unlockEncryption, type Encryption } from '../data/crypto'
import { Dialog } from './base'

type Status =
  'Solo local' | 'Sincronizado' | 'Pendiente' | 'Sin conexión' | 'Error' | 'Nube bloqueada'
type Merge = { local: number; remote: number; rows: CloudRow[] }

const invalidKey = 'La clave de sincronización no es válida.'
const isInvalidKey = (error: unknown) => error instanceof CloudError && error.status === 401

export function useSync(enabled: boolean) {
  // La clave vive solo en el meta local del dispositivo: nunca en backups, sync, URLs ni logs.
  // Cada guardado crea un objeto nuevo, así una clave rechazada se puede reintentar al guardarla.
  const [credential, setCredential] = useState<{ key: string } | null>(null)
  const [status, setStatus] = useState<Status>('Solo local')
  const [merge, setMerge] = useState<Merge | null>(null)
  const [encryption, setEncryption] = useState<Encryption | null>(null)
  const [issue, setIssue] = useState('')
  const busy = useRef(false)
  const secret = useRef<{ config: Encryption; key: CryptoKey } | null>(null)
  const perform = useRef<() => Promise<void>>(async () => undefined)
  const confirm = useRef<() => Promise<void>>(async () => undefined)
  const api = useMemo(
    () => (cloudUrl && credential ? createCloud(cloudUrl, credential.key) : null),
    [credential],
  )

  useEffect(() => {
    let live = true
    void getMeta('syncKey', z.string().nullable(), null).then((key) => {
      if (live && key) setCredential((current) => current ?? { key })
    })
    return () => {
      live = false
    }
  }, [])
  useEffect(() => {
    if (!api) {
      secret.current = null
      setEncryption(null)
    }
    if (!enabled || !api) {
      setStatus('Solo local')
      setMerge(null)
      return
    }
    const cloud = api
    let alive = true
    let running = false
    let again = false
    let failures = 0
    let blocked = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = (delay = 120) => {
      clearTimeout(timer)
      timer = setTimeout(() => void run(), delay)
    }
    const reject = () => {
      // Clave rechazada: sin reintentos automáticos hasta que se guarde otra.
      blocked = true
      again = false
      clearTimeout(timer)
      setMerge(null)
      setStatus('Error')
      setIssue(invalidKey)
    }
    async function run(manual = false) {
      if (!alive) return
      if (manual) blocked = false
      if (blocked) return
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
        // Sin id de usuario, los datos locales quedan vinculados al origen del servidor.
        const linked = linkedOwner(await getMeta('syncOwner', z.unknown(), ''))
        if (!alive) return
        if (linked && linked !== owner) {
          setIssue('Estos datos locales están vinculados a otro servidor de sincronización.')
          setStatus('Error')
          return
        }
        const config = await cloud.encryption()
        if (!alive) return
        setEncryption(config)
        if (config && secret.current?.config.salt !== config.salt) {
          setStatus('Nube bloqueada')
          return
        }
        const key = config ? secret.current?.key : undefined
        if (!linked) {
          const remote = await cloud.pull()
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
          await putMeta('syncOwner', owner)
        }
        if (!alive) return
        setMerge(null)
        setIssue('')
        setStatus('Pendiente')
        await cycle(cloud, key, () => alive)
        if (!alive) return
        failures = 0
        const pending = await db.queue.count()
        setStatus(pending ? 'Pendiente' : 'Sincronizado')
        if (pending) again = true
      } catch (error) {
        if (!alive) return
        if (isInvalidKey(error)) {
          reject()
          return
        }
        setStatus('Error')
        setIssue('No se pudo sincronizar. Tus cambios siguen guardados en este dispositivo.')
        failures++
        schedule(retryDelay(failures))
      } finally {
        running = false
        if (again && alive && !failures && !blocked) {
          again = false
          schedule()
        }
      }
    }
    perform.current = () => run(true)
    confirm.current = async () => {
      if (!alive) return
      try {
        const remote = await cloud.pull()
        await stageInitial(remote)
        await putMeta('syncOwner', owner)
      } catch (error) {
        if (!alive) return
        if (isInvalidKey(error)) {
          reject()
          return
        }
        throw error
      }
      await run(true)
    }
    const connection = () => schedule()
    addEventListener('online', connection)
    addEventListener('offline', connection)
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
      perform.current = async () => undefined
      confirm.current = async () => undefined
    }
  }, [api, enabled])
  const syncNow = useCallback(() => perform.current(), [])
  async function agree() {
    await confirm.current().catch(() => {
      setStatus('Error')
      setIssue('No se pudo confirmar la fusión. Probá de nuevo.')
    })
  }
  async function saveKey(value: string) {
    const key = value.trim()
    if (!key) throw new Error('Escribí la clave de sincronización.')
    await putMeta('syncKey', key)
    setIssue('')
    setCredential({ key })
  }
  async function removeKey() {
    await putMeta('syncKey', null)
    secret.current = null
    setIssue('')
    setCredential(null)
  }
  async function changeEncryption(phrase: string) {
    if (!api || !enabled) return
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
    status,
    merge,
    encryption,
    issue,
    agree,
    syncNow,
    changeEncryption,
    canSend: cloudConfigured,
    hasKey: Boolean(credential),
    saveKey,
    removeKey,
  }
}
export type SyncState = ReturnType<typeof useSync>

export function SyncPanel({ sync }: { sync: SyncState }) {
  const [key, setKey] = useState('')
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
          Tus datos se guardan en este dispositivo. Podés habilitar la nube al configurar el Worker
          de Cloudflare.
        </p>
      ) : !sync.hasKey ? (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault()
            if (!key.trim()) {
              setMessage('Escribí la clave de sincronización.')
              return
            }
            void action(async () => {
              await sync.saveKey(key)
              setKey('')
            }, 'No se pudo guardar la clave. Probá de nuevo.')
          }}
        >
          <label>
            Clave de sincronización
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              required
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
          </label>
          <div className="actions">
            <button className="primary" disabled={busy}>
              Guardar y conectar
            </button>
          </div>
        </form>
      ) : (
        <>
          <p className="muted">Conectado a {host}</p>
          <div className="actions">
            <button disabled={busy} onClick={() => void sync.syncNow()}>
              <RefreshCw size={16} /> Sincronizar ahora
            </button>
            <button
              disabled={busy}
              onClick={() => void action(sync.removeKey, 'No se pudo quitar la clave.')}
            >
              Quitar clave
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
      {sync.canSend && !sync.hasKey && sync.issue && (
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
