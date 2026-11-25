import { z } from 'zod'
import { encryptionSchema, type Encryption } from './crypto'
import { cloudRowSchema, type Backend } from './syncEngine'

const trimSlash = (value: string) => value.replace(/\/+$/, '')
const httpUrl = (value: string) => {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : undefined
  } catch {
    return undefined
  }
}

/** Valida `VITE_SYNC_URL`: solo una URL http(s) absoluta cuenta como configurada. */
export function parseCloudUrl(raw: string | undefined): string | undefined {
  const value = trimSlash(raw?.trim() ?? '')
  return value && httpUrl(value) ? value : undefined
}

/**
 * Dueño guardado de los datos locales. Si no es un origen http(s) (p. ej. el id de usuario
 * heredado de Supabase), se trata como no vinculado para que el diálogo de fusión proteja los datos.
 */
export function linkedOwner(stored: unknown): string {
  if (typeof stored !== 'string') return ''
  return httpUrl(stored)?.origin === stored ? stored : ''
}

export const cloudUrl = parseCloudUrl(import.meta.env.VITE_SYNC_URL as string | undefined)
export const cloudConfigured = Boolean(cloudUrl)
const cloudAddress = cloudUrl ? httpUrl(cloudUrl) : undefined
/** Origen del servidor configurado (identifica al dueño de los datos locales). */
export const cloudOrigin = cloudAddress?.origin ?? ''
export const cloudHost = cloudAddress?.host ?? ''

const PAGE = 500

/**
 * Error HTTP del Worker. `status` es el código real de la respuesta.
 * Convención para quien llame: 401 = clave inválida; 409 = conflicto de revisión;
 * cualquier 5xx se trata como "reintentar" (el Worker responde 500 cuando una escritura
 * concurrente gana la carrera, y el reintento recibe entonces 409).
 * Un fallo de red no es un CloudError: se propaga el error original de `fetch`.
 */
export class CloudError extends Error {
  status: number
  constructor(status: number) {
    super(`Cloud request failed (${status})`)
    this.name = 'CloudError'
    this.status = status
  }
}

const rowsSchema = z.object({ rows: z.array(cloudRowSchema) })
const profileSchema = z.object({ encryption: encryptionSchema.nullable() })

export function createCloud(
  baseUrl: string,
  key: string,
  fetcher: typeof fetch = (...args) => fetch(...args),
): Backend & {
  encryption: () => Promise<Encryption | null>
  disableEncryption: (phrase: string) => Promise<void>
} {
  const base = trimSlash(baseUrl)
  // La clave viaja solo en el encabezado Authorization; nunca en URLs ni en logs.
  const authorization = { Authorization: `Bearer ${key}` }

  async function get(path: string): Promise<unknown> {
    const response = await fetcher(`${base}${path}`, { method: 'GET', headers: authorization })
    if (!response.ok) throw new CloudError(response.status)
    try {
      return (await response.json()) as unknown
    } catch {
      throw new Error('Respuesta inválida del servidor de sincronización.')
    }
  }
  async function post(path: string, body: unknown): Promise<void> {
    const response = await fetcher(`${base}${path}`, {
      method: 'POST',
      headers: { ...authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) throw new CloudError(response.status)
  }

  return {
    async pull() {
      const rows = []
      let after: string | undefined
      for (;;) {
        const query = after ? `after=${encodeURIComponent(after)}&limit=${PAGE}` : `limit=${PAGE}`
        const batch = rowsSchema.parse(await get(`/v1/records?${query}`)).rows
        rows.push(...batch)
        if (batch.length < PAGE) return rows
        const next = batch.at(-1)!.id
        if (next === after) {
          throw new Error('El servidor de sincronización no avanza en la paginación.')
        }
        after = next
      }
    },
    push: (changes, encrypted) => post('/v1/push', { changes, encrypted }),
    async encryption() {
      return profileSchema.parse(await get('/v1/profile')).encryption
    },
    disableEncryption: (phrase) => post('/v1/decryption', { phrase }),
  }
}
