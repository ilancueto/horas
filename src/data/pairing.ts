// Enlace para vincular otro dispositivo. La clave viaja en el fragmento `#`, que el
// navegador nunca envía a ningún servidor; la app lo borra de la barra apenas lo lee.
const prefix = '#clave='

/** `<origen><base>#clave=<clave>`; `base` es `import.meta.env.BASE_URL` (termina en `/`). */
export function pairingLink(origin: string, base: string, key: string): string {
  return `${origin}${base}${prefix}${encodeURIComponent(key)}`
}

/** Clave de un fragmento `#clave=…`, decodificada y sin espacios; `null` si no hay. */
export function readPairingKey(hash: string): string | null {
  if (!hash.startsWith(prefix)) return null
  try {
    return decodeURIComponent(hash.slice(prefix.length)).trim() || null
  } catch {
    return null
  }
}

/**
 * Lee la clave de la URL y la borra de inmediato de la barra (y del historial actual).
 * Solo toca la URL si el fragmento es un enlace de vinculación.
 */
export function takePairingKey(
  place: Pick<Location, 'hash' | 'pathname' | 'search'>,
  log: Pick<History, 'replaceState'>,
): string | null {
  if (!place.hash.startsWith(prefix)) return null
  const key = readPairingKey(place.hash)
  log.replaceState(null, '', place.pathname + place.search)
  return key
}

/** Resultado de conectar un dispositivo con una clave (bienvenida o enlace). */
export type Connection = 'ok' | 'invalid' | 'empty' | 'locked' | 'error'
/**
 * Cómo terminó la espera del primer ciclo tras guardar la clave (o tras desbloquear la nube):
 * `merge` = se ofreció fusionar; `timeout` = no terminó a tiempo.
 */
export type Settled = 'done' | 'merge' | 'invalid' | 'locked' | 'error' | 'timeout'

/**
 * Decide el resultado de conectar y si hay que deshacer (quitar la clave guardada y restaurar el
 * vínculo con el servidor). `needData`: el dispositivo no está configurado y solo cuenta como
 * conectado si bajaron períodos.
 */
export function joinOutcome(
  result: Settled,
  { needData, periods }: { needData: boolean; periods: number },
): { outcome: Connection; undo: boolean } {
  const hasData = !needData || periods > 0
  switch (result) {
    case 'done':
    case 'merge':
      return hasData ? { outcome: 'ok', undo: false } : { outcome: 'empty', undo: true }
    case 'locked':
      return { outcome: 'locked', undo: false }
    case 'invalid':
      return { outcome: 'invalid', undo: true }
    case 'timeout':
      // Venció la espera: solo cuenta como conectado si ya bajaron períodos; si no, se deshace
      // y el dispositivo vuelve a quedar limpio.
      return needData && periods > 0
        ? { outcome: 'ok', undo: false }
        : { outcome: 'error', undo: true }
    default:
      return { outcome: 'error', undo: true }
  }
}
