import { z } from 'zod'
import { empty, json } from './http'
import type { Env } from './index'
import { nextTimestamp } from './time'

export const MAX_BATCH = 100
/** Largo máximo del JSON de `data` por registro. */
export const MAX_RECORD = 1_000_000

const collections = ['periods', 'entries', 'comps', 'leaves', 'holidays', 'rules'] as const

const uuid = z.uuid().transform((value) => value.toLowerCase())

const changeSchema = z.object({
  id: uuid,
  collection: z.enum(collections),
  revision: uuid,
  deleted: z.boolean(),
  data: z.unknown(),
})

const bodySchema = z.object({
  changes: z.array(changeSchema).max(MAX_BATCH),
  encrypted: z.boolean(),
})

const plainObject = z.record(z.string(), z.unknown())
const sealedObject = z.looseObject({ iv: z.string(), ciphertext: z.string() })

export type ChangePacket = z.infer<typeof changeSchema>

function invalid(message: string): Response {
  return json({ error: message }, 400)
}

/** Valores para `in (select value from json_each(?))`, evitando el límite de parámetros. */
function list(values: string[]): string {
  return JSON.stringify([...new Set(values)])
}

/**
 * Port de `horas_private.push`: valida todo el lote antes de escribir, lee el estado previo,
 * calcula las filas en memoria y escribe todo en una única `env.DB.batch` (atómica).
 */
export async function push(
  env: Env,
  body: unknown,
  now: () => Date = () => new Date(),
): Promise<Response> {
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) return invalid('Invalid batch')
  const { changes, encrypted } = parsed.data
  const record = encrypted ? sealedObject : plainObject
  const payloads: (string | null)[] = []
  for (const change of changes) {
    if (change.deleted) {
      payloads.push(null)
      continue
    }
    if (!record.safeParse(change.data).success) return invalid('Invalid record')
    const payload = JSON.stringify(change.data)
    if (payload.length > MAX_RECORD) return invalid('Invalid record')
    payloads.push(payload)
  }

  const ids = list(changes.map((change) => change.id))
  const revisions = list(changes.map((change) => change.revision))
  const [profile, applied, previous] = await Promise.all([
    env.DB.prepare('select encryption from profile where id = 1').first<{
      encryption: string | null
    }>(),
    env.DB.prepare(
      'select revision from mutations where revision in (select value from json_each(?))',
    )
      .bind(revisions)
      .all<{ revision: string }>(),
    env.DB.prepare(
      'select id, updated_at from records where id in (select value from json_each(?))',
    )
      .bind(ids)
      .all<{ id: string; updated_at: string }>(),
  ])

  const mode = profile?.encryption ?? null
  if ((mode !== null) !== encrypted) return json({ error: 'Encryption mode changed' }, 409)

  const seen = new Set(applied.results.map((row) => row.revision))
  const updatedAt = new Map(previous.results.map((row) => [row.id, row.updated_at]))
  // Las lecturas y la batch no forman una transacción: otro push (o activar el cifrado) puede
  // confirmarse en el medio. Estas defensas, dentro de la batch atómica, lo contemplan:
  // - Si el modo de cifrado cambió desde la lectura, se inserta `profile(id = 0)`, que viola
  //   `check (id = 1)` y revierte toda la batch; el reintento del cliente recibe el 409.
  //   La Task 3 (`enableEncryption`) también debe protegerse de pushes concurrentes.
  // - Una revisión ya registrada por un push concurrente viola la clave de `mutations` y
  //   revierte la batch; el reintento la ignora.
  // - El upsert solo pisa una fila con un `updated_at` menor (ISO de ancho fijo: compara bien
  //   como texto), así `updated_at` nunca retrocede.
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `insert into profile(id) select 0
       where coalesce((select encryption is not null from profile where id = 1), 0) <> ?`,
    ).bind(encrypted ? 1 : 0),
    env.DB.prepare('insert into profile(id) values (1) on conflict do nothing'),
  ]
  const insertMutation = env.DB.prepare('insert into mutations(revision) values (?)')
  const upsert = env.DB.prepare(
    `insert into records(id, collection, data, revision, updated_at, deleted_at)
     values (?, ?, ?, ?, ?, ?)
     on conflict(id) do update set collection = excluded.collection, data = excluded.data,
       revision = excluded.revision, updated_at = excluded.updated_at,
       deleted_at = excluded.deleted_at
     where excluded.updated_at > records.updated_at`,
  )
  for (const [index, change] of changes.entries()) {
    if (seen.has(change.revision)) continue
    seen.add(change.revision)
    const at = nextTimestamp(now(), updatedAt.get(change.id))
    updatedAt.set(change.id, at)
    statements.push(
      insertMutation.bind(change.revision),
      upsert.bind(
        change.id,
        change.collection,
        payloads[index],
        change.revision,
        at,
        change.deleted ? at : null,
      ),
    )
  }
  await env.DB.batch(statements)
  return empty()
}
