import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Cloud, CloudOff, Copy, Link2, RefreshCw } from 'lucide-react'
import { z } from 'zod'
import { liveQuery } from 'dexie'
import { db, getMeta, markOnboarded, notify, putMeta, useHours } from '../data/db'
import {
  joinOutcome,
  pairingLink,
  takePairingKey,
  type Connection,
  type Settled,
} from '../data/pairing'
import {
  CloudError,
  cloudConfigured,
  cloudHost as host,
  cloudOrigin as owner,
  cloudUrl,
  createCloud,
  linkedOwner,
} from '../data/cloud'
import { cycle, retryDelay, stageInitial, type CloudRow } from '../data/syncEngine'
import { unlockEncryption, type Encryption } from '../data/crypto'
import { Dialog } from './base'

type Status =
  'Solo local' | 'Sincronizado' | 'Pendiente' | 'Sin conexión' | 'Error' | 'Nube bloqueada'
type Merge = { local: number; remote: number; rows: CloudRow[] }

const invalidKey = 'La clave de sincronización no es válida.'
const isInvalidKey = (error: unknown) => error instanceof CloudError && error.status === 401

/** Resultado de conectar, más `phrase` = la frase de paso no abre la nube. */
export type Joined = Connection | 'phrase' | 'connected'
export const connectionText: Record<Exclude<Joined, 'ok' | 'locked'>, string> = {
  invalid: invalidKey,
  empty: 'No encontramos datos en la nube con esa clave. Podés empezar de cero.',
  error: 'No pudimos conectar. Revisá la conexión y probá de nuevo.',
  phrase: 'La frase no coincide. Probá de nuevo.',
  connected: 'Este dispositivo ya está conectado.',
}
const lockedLinked =
  'Dispositivo conectado. Tu nube tiene cifrado: desbloqueala en Más → Sincronización con tu frase de paso.'
/** Espera del primer ciclo; las pruebas pueden acortarla con `window.__horasConnectTimeout`. */
const connectTimeout = () =>
  (globalThis as { __horasConnectTimeout?: number }).__horasConnectTimeout ?? 60_000
/** Conexión en curso desde la bienvenida o un enlace, hasta que entra o se deshace. */
type Join = {
  key: string
  /** La clave la guardó esta conexión (antes no había ninguna): solo entonces se puede quitar. */
  owned: boolean
  previousOwner: unknown
  generation: number
  needData: boolean
}

// Un enlace `#clave=…` se lee y se borra de la barra al cargar el módulo, antes de que
// cualquier efecto lea la URL. La clave queda solo en memoria hasta aplicarla.
let pendingLink = typeof location === 'undefined' ? null : takePairingKey(location, history)

export function useSync(enabled: boolean) {
  // La clave vive solo en el meta local del dispositivo: nunca en backups, sync, URLs ni logs.
  // Cada guardado crea un objeto nuevo, así una clave rechazada se puede reintentar al guardarla.
  const [credential, setCredential] = useState<{ key: string } | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [status, setStatus] = useState<Status>('Solo local')
  const [merge, setMerge] = useState<Merge | null>(null)
  const [encryption, setEncryption] = useState<Encryption | null>(null)
  const [issue, setIssue] = useState('')
  const busy = useRef(false)
  const secret = useRef<{ config: Encryption; key: CryptoKey } | null>(null)
  const perform = useRef<() => Promise<void>>(async () => undefined)
  const confirm = useRef<() => Promise<void>>(async () => undefined)
  // Quien espera el primer ciclo con una clave recién guardada (ver `connect`).
  const waiter = useRef<{ key: string; settle: (result: Settled) => void } | null>(null)
  const flight = useRef<Promise<Joined> | null>(null)
  const generation = useRef(0)
  // Sube al deshacer una conexión: un ciclo empezado antes ya no puede volver a vincular.
  const epoch = useRef(0)
  const join = useRef<Join | null>(null)
  const merged = useRef(false)
  const [connecting, setConnecting] = useState(false)
  const [joinLocked, setJoinLocked] = useState(false)
  const api = useMemo(
    () => (cloudUrl && credential ? createCloud(cloudUrl, credential.key) : null),
    [credential],
  )

  useEffect(() => {
    let live = true
    void getMeta('syncKey', z.string().nullable(), null)
      .catch(() => null)
      .then((key) => {
        if (!live) return
        if (key) setCredential((current) => current ?? { key })
        setLoaded(true)
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
    const effectKey = credential?.key
    let alive = true
    let running = false
    let again = false
    let failures = 0
    let blocked = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (result: Settled) => {
      const wait = waiter.current
      if (!alive || !wait || wait.key !== effectKey) return
      waiter.current = null
      wait.settle(result)
    }
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
      finish('invalid')
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
        finish('error')
        return
      }
      running = true
      const started = epoch.current
      try {
        // Sin id de usuario, los datos locales quedan vinculados al origen del servidor.
        const linked = linkedOwner(await getMeta('syncOwner', z.unknown(), ''))
        if (!alive) return
        if (linked && linked !== owner) {
          setIssue('Estos datos locales están vinculados a otro servidor de sincronización.')
          setStatus('Error')
          finish('error')
          return
        }
        const config = await cloud.encryption()
        if (!alive) return
        setEncryption(config)
        if (config && secret.current?.config.salt !== config.salt) {
          setStatus('Nube bloqueada')
          finish('locked')
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
            finish('merge')
            return
          }
          await stageInitial(remote)
          // Una conexión deshecha puede haber restaurado el vínculo: un ciclo viejo no lo pisa.
          if (!alive || epoch.current !== started) return
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
        finish('done')
      } catch (error) {
        if (!alive) return
        if (isInvalidKey(error)) {
          reject()
          return
        }
        setStatus('Error')
        setIssue('No se pudo sincronizar. Tus cambios siguen guardados en este dispositivo.')
        finish('error')
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
      const started = epoch.current
      try {
        const remote = await cloud.pull()
        if (!alive) return
        await stageInitial(remote)
        if (!alive || epoch.current !== started) return
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
  }, [api, credential, enabled])
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
  /** Una sola conexión a la vez: una segunda llamada comparte la que está en curso. */
  function single(task: () => Promise<Joined>): Promise<Joined> {
    if (flight.current) return flight.current
    setConnecting(true)
    const current = task()
      .catch((): Joined => 'error')
      .finally(() => {
        flight.current = null
        setConnecting(false)
      })
    flight.current = current
    return current
  }
  /** Arranca algo que dispara un ciclo y espera a que ese ciclo termine (o venza la espera). */
  function waitCycle(key: string, start: () => Promise<void>) {
    return new Promise<Settled>((resolve) => {
      const timer = setTimeout(() => {
        if (waiter.current === wait) waiter.current = null
        resolve('timeout')
      }, connectTimeout())
      const wait = {
        key,
        settle: (result: Settled) => {
          clearTimeout(timer)
          resolve(result)
        },
      }
      waiter.current = wait
      start().catch(() => {
        clearTimeout(timer)
        if (waiter.current === wait) waiter.current = null
        resolve('error')
      })
    })
  }
  /** Quita la clave solo si la guardó esta conexión, sigue guardada y no empezó otra después. */
  async function undo(session: Join) {
    if (!session.owned || session.generation !== generation.current) return
    // Antes de cualquier espera: un ciclo en curso ya no puede volver a vincular.
    epoch.current++
    if ((await getMeta('syncKey', z.string().nullable(), null)) !== session.key) return
    await removeKey()
    await putMeta('syncOwner', session.previousOwner)
  }
  async function conclude(session: Join, result: Settled): Promise<Connection> {
    const { outcome, undo: revert } = joinOutcome(result, {
      needData: session.needData,
      periods: useHours.getState().ledger.periods.length,
    })
    merged.current = result === 'merge'
    if (revert) await undo(session)
    // Nube cifrada en un dispositivo sin configurar: queda esperando la frase de paso.
    const waiting = outcome === 'locked' && session.needData
    setJoinLocked(waiting)
    // Si entró sin configurar, la sesión sigue hasta que `finishJoin` confirme `markOnboarded`.
    join.current = waiting || (outcome === 'ok' && session.needData) ? session : null
    return outcome
  }
  /** La bienvenida quedó atrás (`markOnboarded` funcionó): ya no hay nada que deshacer. */
  function finishJoin() {
    join.current = null
  }
  /**
   * Guarda la clave y espera a que termine el primer ciclo de sincronización.
   * Con `needData` (dispositivo sin configurar), un ciclo sin períodos cuenta como nube vacía.
   * Si no queda conectado, quita la clave que guardó y deja el vínculo con el servidor como estaba.
   */
  function connect(value: string, needData: boolean): Promise<Joined> {
    return single(async () => {
      const key = value.trim()
      if (!key || !cloudUrl) return 'error'
      const stored = await getMeta('syncKey', z.string().nullable(), null)
      const previous = join.current
      const inherited = Boolean(previous?.owned && stored === previous.key)
      // Una clave guardada que no es de esta conexión no se pisa. En la bienvenida, la misma
      // clave que quedó guardada (una conexión que no terminó) sí se puede reintentar y quitar.
      const leftover = stored === key && needData
      if (stored !== null && !inherited && !leftover) return 'connected'
      const session: Join = {
        key,
        owned: stored === null || inherited || leftover,
        previousOwner: inherited
          ? previous!.previousOwner
          : await getMeta('syncOwner', z.unknown(), ''),
        generation: ++generation.current,
        needData,
      }
      join.current = session
      return conclude(session, await waitCycle(key, () => saveKey(key)))
    })
  }
  /** Paso de la frase de paso cuando la nube está cifrada: desbloquea y espera el ciclo. */
  function unlock(phrase: string): Promise<Joined> {
    return single(async () => {
      const session = join.current
      // Desde la bienvenida solo se desbloquea una nube ya cifrada; nunca se crea un cifrado.
      if (!session || !encryption) return 'error'
      let wrong = false
      const result = await waitCycle(session.key, async () => {
        try {
          const key = await unlockEncryption(phrase, encryption)
          secret.current = { config: encryption, key }
          await syncNow()
        } catch (error) {
          wrong = true
          throw error
        }
      })
      if (wrong) return 'phrase'
      return conclude(session, result)
    })
  }
  /** Se abandona la conexión pendiente (por ejemplo, en el paso de la frase de paso). */
  async function cancelJoin() {
    const session = join.current
    join.current = null
    setJoinLocked(false)
    if (session) await undo(session)
    // Una clave que quedó de una conexión sin terminar (por ejemplo, tras recargar): en la
    // bienvenida no hay otra forma de tener clave, así que se quita.
    else if (credential && !useHours.getState().settings.onboarded) {
      epoch.current++
      await removeKey()
    }
  }
  /** Reintenta con la clave que quedó guardada en la bienvenida. */
  function resumeJoin(): Promise<Joined> {
    return credential ? connect(credential.key, true) : Promise.resolve('error')
  }
  /** Enlace para vincular otro dispositivo; solo se arma cuando la persona lo pide. */
  function pairingUrl() {
    return credential ? pairingLink(location.origin, import.meta.env.BASE_URL, credential.key) : ''
  }
  const connectRef = useRef(connect)
  connectRef.current = connect
  const [linkOpened, setLinkOpened] = useState(0)
  useEffect(() => {
    // Con la app ya abierta, un enlace en la misma pestaña solo cambia el fragmento.
    const opened = () => {
      const key = takePairingKey(location, history)
      if (!key) return
      pendingLink = key
      setLinkOpened((n) => n + 1)
    }
    addEventListener('hashchange', opened)
    return () => removeEventListener('hashchange', opened)
  }, [])
  useEffect(() => {
    // Enlace `#clave=…`: se aplica cuando la app está desbloqueada y se sabe si hay clave.
    if (!enabled || !loaded || !pendingLink) return
    const key = pendingLink
    pendingLink = null
    // Solo local: el fragmento ya se borró de la barra y no se muestra nada nuevo.
    if (!cloudConfigured) return
    if (credential) {
      notify('Este dispositivo ya está conectado.')
      return
    }
    void (async () => {
      const onboarded = useHours.getState().settings.onboarded
      // En la bienvenida el aviso "Conectando…" es fijo; en la app, un aviso breve.
      if (onboarded) notify('Conectando con tu nube…')
      const outcome = await connectRef.current(key, !onboarded)
      if (outcome === 'ok') {
        if (!onboarded) {
          try {
            await markOnboarded()
          } catch {
            // La sesión sigue: la clave se puede reintentar o quitar desde la bienvenida.
            notify(connectionText.error)
            return
          }
          finishJoin()
        }
        notify(
          merged.current
            ? 'Dispositivo conectado. Revisá la fusión de datos.'
            : 'Dispositivo conectado.',
        )
      } else if (outcome === 'locked') {
        // Sin configurar, la bienvenida muestra el paso de la frase de paso.
        if (onboarded) notify(lockedLinked)
      } else notify(connectionText[outcome])
    })()
  }, [enabled, loaded, credential, linkOpened])
  async function disableEncryption(phrase: string) {
    if (!api || !enabled || !encryption) return
    busy.current = true
    try {
      await api.disableEncryption(phrase)
      secret.current = null
      setEncryption(null)
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
    disableEncryption,
    canSend: cloudConfigured,
    hasKey: Boolean(credential),
    saveKey,
    removeKey,
    connect,
    unlock,
    cancelJoin,
    resumeJoin,
    finishJoin,
    connecting,
    joinLocked,
    pairingUrl,
  }
}
export type SyncState = ReturnType<typeof useSync>

export function SyncPanel({ sync }: { sync: SyncState }) {
  const [key, setKey] = useState('')
  const [phrase, setPhrase] = useState('')
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
          <Pairing sync={sync} />
          {sync.encryption && (
            <form
              className="stack"
              onSubmit={(e) => {
                e.preventDefault()
                const currentPhrase = phrase
                setPhrase('')
                void action(async () => {
                  try {
                    await sync.disableEncryption(currentPhrase)
                    setMessage('Se desactivó el cifrado de la nube.')
                  } catch (error) {
                    if (error instanceof CloudError && error.status === 422) {
                      setMessage('La frase no coincide. Probá de nuevo.')
                      return
                    }
                    throw error
                  }
                }, 'No se pudo desactivar el cifrado. Probá de nuevo.')
              }}
            >
              <p className="muted">
                Ingresá tu frase de paso una última vez. La nube conservará tus jornadas y seguirá
                protegida por tu clave de sincronización.
              </p>
              <label>
                Frase de paso
                <input
                  type="password"
                  autoComplete="current-password"
                  value={phrase}
                  required
                  maxLength={4096}
                  onChange={(e) => setPhrase(e.target.value)}
                />
              </label>
              <div className="actions">
                <button disabled={busy}>Desactivar cifrado</button>
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

/** Bienvenida: conectar un dispositivo nuevo con la clave y bajar los datos de la nube. */
export function ConnectCloud({ sync, close }: { sync: SyncState; close: () => void }) {
  const [key, setKey] = useState('')
  const [phrase, setPhrase] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const errorId = useId()
  const working = busy || sync.connecting
  const locked = sync.joinLocked
  async function settle(outcome: Joined) {
    if (outcome === 'ok') {
      try {
        // Al marcarlo configurado, la app reemplaza la bienvenida (y este diálogo).
        await markOnboarded()
        sync.finishJoin()
        return
      } catch {
        outcome = 'error'
      }
    }
    setBusy(false)
    // Nube cifrada: el diálogo pasa al paso de la frase de paso.
    setError(outcome === 'locked' ? '' : connectionText[outcome])
  }
  async function dismiss() {
    if (working) return
    await sync.cancelJoin()
    close()
  }
  const alert = error && (
    <p className="warning" role="alert" id={errorId}>
      {error}
    </p>
  )
  const progress = working && <p role="status">Conectando con tu nube…</p>
  return (
    <Dialog title="Conectar con mi nube" busy={working} close={() => void dismiss()}>
      {locked ? (
        <form
          className="stack"
          noValidate
          onSubmit={async (e) => {
            e.preventDefault()
            if (working) return
            if (!phrase) {
              setError('Escribí tu frase de paso.')
              return
            }
            setBusy(true)
            setError('')
            const outcome = await sync.unlock(phrase)
            if (outcome === 'phrase') setPhrase('')
            await settle(outcome)
          }}
        >
          <p>Tu nube tiene cifrado. Escribí tu frase de paso para bajar tus datos.</p>
          <label>
            Frase de paso
            <input
              type="password"
              autoComplete="current-password"
              value={phrase}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
              onChange={(e) => setPhrase(e.target.value)}
            />
          </label>
          {alert}
          {progress}
          <div className="actions">
            <button className="primary" disabled={working}>
              Desbloquear
            </button>
            <button type="button" disabled={working} onClick={() => void dismiss()}>
              Cancelar
            </button>
          </div>
        </form>
      ) : (
        <form
          className="stack"
          noValidate
          onSubmit={async (e) => {
            e.preventDefault()
            if (!key.trim()) {
              setError('Escribí la clave de sincronización.')
              return
            }
            setBusy(true)
            setError('')
            // Si ya hay una conexión en curso (por ejemplo, de un enlace), se comparte.
            await settle(await sync.connect(key, true))
          }}
        >
          <p className="muted">
            Pegá la clave de sincronización que usás en tus otros dispositivos. Vamos a bajar tus
            datos de la nube.
          </p>
          <label>
            Clave de sincronización
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={key}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
              onChange={(e) => setKey(e.target.value)}
            />
          </label>
          {alert}
          {progress}
          <div className="actions">
            <button className="primary" disabled={working}>
              Conectar
            </button>
          </div>
        </form>
      )}
    </Dialog>
  )
}

/** QR en SVG: módulos negros sobre una caja blanca con margen, legible también en tema oscuro. */
function PairingQr({ text }: { text: string }) {
  const [modules, setModules] = useState<{ text: string; rows: boolean[][] } | null>(null)
  useEffect(() => {
    let live = true
    // La librería del QR se carga recién cuando se pide el enlace.
    // Si no carga (por ejemplo, sin conexión y sin caché), queda el campo con el enlace.
    import('../data/qr')
      .then(({ qrModules }) => {
        if (live) setModules({ text, rows: qrModules(text) })
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [text])
  if (modules?.text !== text) return null
  const quiet = 4
  const size = modules.rows.length + quiet * 2
  const path = modules.rows
    .flatMap((row, y) =>
      row.map((dark, x) => (dark ? `M${x + quiet} ${y + quiet}h1v1h-1z` : '')).filter(Boolean),
    )
    .join('')
  return (
    <svg
      className="pairing-qr"
      role="img"
      aria-label="Código QR para vincular otro dispositivo"
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
    >
      <rect width={size} height={size} rx={1.5} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  )
}

function Pairing({ sync }: { sync: SyncState }) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState('')
  const field = useRef<HTMLInputElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const opener = useRef<HTMLButtonElement>(null)
  const toggled = useRef(false)
  useEffect(() => {
    // Foco al título al abrir y de vuelta al botón al ocultar (no al montar).
    if (!toggled.current) return
    if (open) heading.current?.focus()
    else opener.current?.focus()
  }, [open])
  function toggle(next: boolean) {
    toggled.current = true
    setOpen(next)
    if (!next) setCopied('')
  }
  // La clave solo está en el DOM mientras el enlace está a la vista.
  const url = open ? sync.pairingUrl() : ''
  async function copy() {
    try {
      if (!navigator.clipboard) throw new Error('Sin portapapeles')
      await navigator.clipboard.writeText(url)
      setCopied('Enlace copiado.')
    } catch {
      field.current?.select()
      setCopied('No se pudo copiar. Seleccioná el enlace y copialo a mano.')
    }
  }
  if (!open)
    return (
      <div className="actions">
        <button ref={opener} onClick={() => toggle(true)}>
          <Link2 size={16} /> Vincular otro dispositivo
        </button>
      </div>
    )
  return (
    <div className="stack pairing">
      <h3 ref={heading} tabIndex={-1}>
        Vincular otro dispositivo
      </h3>
      <p className="muted">
        Abrí este enlace o escaneá el código en el otro dispositivo para conectarlo sin escribir la
        clave.
      </p>
      <p className="warning">
        Este enlace contiene tu clave. Usalo solo en tus dispositivos y borrá el mensaje y la
        entrada del historial después.
      </p>
      <label>
        Enlace para vincular
        <input
          ref={field}
          readOnly
          value={url}
          spellCheck={false}
          autoComplete="off"
          onFocus={(e) => e.currentTarget.select()}
        />
      </label>
      {url && <PairingQr text={url} />}
      <div className="actions">
        <button className="primary" onClick={() => void copy()}>
          <Copy size={16} /> Copiar enlace
        </button>
        <button onClick={() => toggle(false)}>Ocultar enlace</button>
      </div>
      {copied && <p role="status">{copied}</p>}
    </div>
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
