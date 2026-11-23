import { z } from 'zod'
import { empty, json } from './http'
import type { Env } from './index'
import { MAX_RECORD, byteLength } from './push'
import { nextTimestamp } from './time'

/** Largo máximo del JSON de `config` guardado en el perfil. */
export const MAX_CONFIG = 10_000

const uuid = z.uuid().transform((value) => value.toLowerCase())
const envelope = z.looseObject({ iv: z.string(), ciphertext: z.string() })

const bodySchema = z.object({
  // `crypto.ts` genera la sal como base64 de 16 bytes: 24 caracteres.
  config: z.object({ salt: z.string().length(24), check: envelope }),
  changes: z.array(z.object({ id: uuid, revision: uuid, data: envelope })),
})

type LiveRow = { id: string; revision: string; data: string; updated_at: string }

function recordsChanged(): Response {
  return json({ error: 'Records changed' }, 409)
}

/**
 * `true` si el JSON guardado ya tiene `ciphertext` con un valor no nulo. Mismo criterio que
 * `(data ->> 'ciphertext') is null` en SQLite, donde un `ciphertext` JSON `null` cuenta como NO
 * cifrado (a diferencia de `(data -> 'ciphertext') is null` de Postgres/jsonb en
 * `enable_encryption`, donde un `null` JSON sí contaría como presente).
 */
function isSealed(data: string): boolean {
  const parsed = JSON.parse(data) as unknown
  return (
    typeof parsed === 'object' &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    (parsed as Record<string, unknown>).ciphertext != null
  )
}

/**
 * Port de `horas_private.enable_encryption`: valida todo antes de escribir, comprueba que
 * `changes` cubra exactamente los registros vivos sin cifrar (por `id` y `revision`) y escribe
 * los registros cifrados y el perfil en una única `env.DB.batch` (atómica).
 */
export async function enableEncryption(
  env: Env,
  body: unknown,
  now: () => Date = () => new Date(),
): Promise<Response> {
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) return json({ error: 'Invalid configuration' }, 400)
  const { config, changes } = parsed.data
  const encryption = JSON.stringify(config)
  if (byteLength(encryption) > MAX_CONFIG) return json({ error: 'Invalid configuration' }, 400)
  const payloads: string[] = []
  for (const change of changes) {
    const payload = JSON.stringify(change.data)
    if (byteLength(payload) > MAX_RECORD) return json({ error: 'Invalid ciphertext' }, 400)
    payloads.push(payload)
  }

  const [profile, live] = await Promise.all([
    env.DB.prepare('select encryption from profile where id = 1').first<{
      encryption: string | null
    }>(),
    env.DB.prepare(
      'select id, revision, data, updated_at from records where deleted_at is null',
    ).all<LiveRow>(),
  ])
  if ((profile?.encryption ?? null) !== null) {
    return json({ error: 'Encryption already enabled' }, 409)
  }

  const byId = new Map(live.results.map((row) => [row.id, row]))
  if (byId.size !== changes.length) return recordsChanged()
  const seen = new Set<string>()
  for (const change of changes) {
    const row = byId.get(change.id)
    if (!row || seen.has(change.id) || row.revision !== change.revision || isSealed(row.data)) {
      return recordsChanged()
    }
    seen.add(change.id)
  }

  // Las lecturas y la batch no forman una transacción: un push u otra activación pueden
  // confirmarse en el medio. La primera sentencia de la batch repite la comprobación dentro de
  // la batch atómica: si el perfil ya está cifrado, cambió la cantidad de registros vivos o
  // alguno de los pares (id, revision) ya no está vivo y sin cifrar, inserta `profile(id = 0)`,
  // que viola `check (id = 1)` y revierte todo; el reintento del cliente recibe el 409.
  // Los `update` además llevan sus propias condiciones, como en `enable_encryption`.
  const pairs = JSON.stringify(changes.map((change) => [change.id, change.revision]))
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `insert into profile(id) select 0
       where coalesce((select encryption is not null from profile where id = 1), 0)
         or (select count(*) from records where deleted_at is null) <> ?1
         or (select count(distinct r.id) from records r
               join json_each(?2) c
                 on r.id = (c.value ->> 0) and r.revision = (c.value ->> 1)
               where r.deleted_at is null and (r.data ->> 'ciphertext') is null) <> ?1`,
    ).bind(changes.length, pairs),
  ]
  const update = env.DB.prepare(
    `update records set data = ?, updated_at = ?
     where id = ? and revision = ? and deleted_at is null and (data ->> 'ciphertext') is null`,
  )
  for (const [index, change] of changes.entries()) {
    const at = nextTimestamp(now(), byId.get(change.id)?.updated_at)
    statements.push(update.bind(payloads[index], at, change.id, change.revision))
  }
  statements.push(
    env.DB.prepare(
      `insert into profile(id, encryption) values (1, ?)
       on conflict(id) do update set encryption = excluded.encryption
       where profile.encryption is null`,
    ).bind(encryption),
  )
  await env.DB.batch(statements)
  return empty()
}
