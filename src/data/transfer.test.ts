import 'fake-indexeddb/auto'
import { afterEach, expect, it, vi } from 'vitest'
import { blankEntry, defaults, emptyLedger } from '../domain/model'
import { apply, db, putMeta } from './db'
import { encodeChanges } from './syncEngine'
import { backup, readBackup } from './transfer'

it('la clave de sincronización no entra en la cola ni en los cambios enviados', async () => {
  await putMeta('syncKey', 'secreta-123')
  await apply([{ collection: 'entries', item: blankEntry('2026-11-23', defaults) }])
  const queue = await db.queue.toArray()
  expect(queue.length).toBeGreaterThan(0)
  expect(JSON.stringify(queue)).not.toContain('secreta-123')
  expect(JSON.stringify(await encodeChanges(queue))).not.toContain('secreta-123')
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('la clave de sincronización no sale en el backup', async () => {
  await putMeta('syncKey', 'secreta-123')
  const blobs: Blob[] = []
  vi.stubGlobal('document', { createElement: () => ({ click: () => undefined }) })
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    blobs.push(blob as Blob)
    return 'blob:prueba'
  })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
  await backup('2026-11-23', false)
  await backup('2026-11-23', true)
  expect(blobs).toHaveLength(2)
  for (const blob of blobs) {
    const text = await blob.text()
    expect(JSON.parse(text)).toMatchObject({ version: 1 })
    expect(text).not.toContain('secreta-123')
  }
})

it('restaura un backup viejo sin tipo', () => {
  const old = {
    version: 1,
    created: '2026-03-01',
    ledger: {
      ...emptyLedger,
      leaves: [{ id: crypto.randomUUID(), from: '2026-03-01', to: '2026-03-02', notes: 'x' }],
    },
    settings: defaults,
  }
  const out = readBackup(JSON.stringify(old))
  expect(out.ledger.leaves[0].kind).toBe('vacaciones')
})
it('restaura un backup sin saldo inicial de francos', () => {
  const { compSince, compOpeningDays, compOpeningMinutes, ...settings } = defaults
  void compSince
  void compOpeningDays
  void compOpeningMinutes
  const out = readBackup(
    JSON.stringify({ version: 1, created: '2026-03-01', ledger: emptyLedger, settings }),
  )
  expect(out.settings).toMatchObject({ compSince: null, compOpeningDays: 0, compOpeningMinutes: 0 })
})
