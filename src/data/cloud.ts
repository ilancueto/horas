import { z } from 'zod'
import { encryptionSchema, type Encryption } from './crypto'
import { cloudRowSchema, type Backend, type ChangePacket } from './syncEngine'

const configured = import.meta.env.VITE_SYNC_URL as string | undefined
const trimSlash = (value: string) => value.replace(/\/+$/, '')
export const cloudUrl: string | undefined = configured ? trimSlash(configured) : undefined
export const cloudConfigured = Boolean(cloudUrl)

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
  enable: (config: Encryption, changes: ChangePacket[]) => Promise<void>
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
    enable: (config, changes) => post('/v1/encryption', { config, changes }),
  }
}
