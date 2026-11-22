import { z } from 'zod'
import { day, ledgerSchema, privateSchema, settingsSchema } from '../domain/model'
import { putMeta, useHours } from './db'

const backupSchema = z.object({
  version: z.literal(1),
  created: day,
  ledger: ledgerSchema,
  settings: settingsSchema,
  privateData: privateSchema.optional(),
})
export type Backup = z.infer<typeof backupSchema>
export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 30000)
}
export async function backup(today: string, includePrivate = false) {
  const { ledger, settings, privateData } = useHours.getState()
  const value: Backup = {
    version: 1,
    created: today,
    ledger,
    settings,
    ...(includePrivate ? { privateData } : {}),
  }
  download(
    new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }),
    'Horas-backup-' + today + '.json',
  )
  await putMeta('backupAt', today)
  useHours.setState({ backupAt: today })
}
export function readBackup(source: string): Backup {
  try {
    const parsed = backupSchema.parse(JSON.parse(source))
    const ids = new Set<string>()
    for (const rows of Object.values(parsed.ledger))
      for (const row of rows) {
        if (ids.has(row.id)) throw new Error()
        ids.add(row.id)
      }
    return parsed
  } catch {
    throw new Error(
      'El archivo no es un backup válido de Horas. Elegí un JSON exportado por la app.',
    )
  }
}
