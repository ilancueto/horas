import 'fake-indexeddb/auto'
import { beforeEach, expect, it } from 'vitest'
import { blankEntry, defaults, rulesId, rulesSchema } from '../domain/model'
import { apply, db, putMeta, readLedger, saveSettings, useHours } from './db'
import { cycle, retryDelay, stageInitial, type Backend, type CloudRow } from './syncEngine'
import { createEncryption, seal, unlockEncryption, unseal } from './crypto'

class MockBackend implements Backend {
  rows = new Map<string, CloudRow>()
  revisions = new Set<string>()
  time = 0
  online = true
  async pull() {
    return [...this.rows.values()]
  }
  async push(changes: Parameters<Backend['push']>[0]) {
    if (!this.online) throw new Error('offline')
    for (const change of changes) {
      if (this.revisions.has(change.revision)) continue
      this.revisions.add(change.revision)
      const updated_at = new Date(Date.UTC(2026, 10, 1, 0, 0, ++this.time)).toISOString()
      this.rows.set(change.id, {
        id: change.id,
        collection: change.collection,
        data: change.data,
        revision: change.revision,
        updated_at,
        deleted_at: change.deleted ? updated_at : null,
      })
    }
  }
}
beforeEach(async () => {
  await db.records.clear()
  await db.queue.clear()
})
it('conserva la cola offline, aplica la última escritura, sincroniza y conserva tombstones', async () => {
  const server = new MockBackend()
  const entry = { ...blankEntry('2026-11-10', defaults), notes: 'Uno' }
  await apply([{ collection: 'entries', item: entry }])
  server.online = false
  await expect(cycle(server)).rejects.toThrow('offline')
  expect(await db.queue.count()).toBe(1)
  server.online = true
  await cycle(server)
  expect(await db.queue.count()).toBe(0)
  await server.push([
    {
      id: entry.id,
      collection: 'entries',
      revision: crypto.randomUUID(),
      deleted: false,
      data: { ...entry, notes: 'Dos' },
    },
  ])
  await cycle(server)
  expect((await readLedger()).entries[0].notes).toBe('Dos')
  await apply([{ collection: 'entries', item: entry, deleted: true }])
  await cycle(server)
  expect((await readLedger()).entries).toHaveLength(0)
  expect(server.rows.get(entry.id)?.deleted_at).toBeTruthy()
  expect(retryDelay(3)).toBe(4000)
})
it('fusiona una primera conexión sin descartar registros de ninguno de los dispositivos', async () => {
  const server = new MockBackend()
  const offline = blankEntry('2026-11-10', defaults),
    online = blankEntry('2026-11-11', defaults)
  await apply([{ collection: 'entries', item: offline }])
  await server.push([
    {
      id: online.id,
      collection: 'entries',
      revision: crypto.randomUUID(),
      deleted: false,
      data: online,
    },
  ])
  await stageInitial(await server.pull())
  await cycle(server)
  expect((await readLedger()).entries.map((r) => r.date).sort()).toEqual([
    offline.date,
    online.date,
  ])
})
it('permite recuperar un registro cifrado solo con la frase y el contexto correctos', async () => {
  const { config, key } = await createEncryption('Una frase de ejemplo de prueba')
  const locked = await seal(key, { notes: 'Reservado' }, 'id|revision')
  const unlocked = await unlockEncryption('Una frase de ejemplo de prueba', config)
  await expect(unseal(unlocked, locked, 'id|revision')).resolves.toEqual({ notes: 'Reservado' })
  await expect(unseal(unlocked, locked, 'otro')).rejects.toThrow()
  await expect(unlockEncryption('Otra frase de ejemplo', config)).rejects.toThrow()
})
it('acepta reglas remotas y ajustes locales viejos sin saldo inicial de francos', async () => {
  const server = new MockBackend()
  const oldRules = {
    id: rulesId,
    start: 480,
    end: 1020,
    breakMinutes: 30,
    saturday: 780,
    early: 'extra',
    nonWorking: false,
    closing: 14,
    annualLeave: 14,
    lockClosed: true,
  }
  server.rows.set(rulesId, {
    id: rulesId,
    collection: 'rules',
    data: oldRules,
    revision: crypto.randomUUID(),
    updated_at: new Date(Date.UTC(2026, 10, 1)).toISOString(),
    deleted_at: null,
  })
  const { compSince, compOpeningDays, compOpeningMinutes, ...oldSettings } = defaults
  void compSince
  void compOpeningDays
  void compOpeningMinutes
  await putMeta('settings', { ...oldSettings, onboarded: true })
  await cycle(server)
  const settings = useHours.getState().settings
  expect(settings).toMatchObject({
    start: 480,
    breakMinutes: 30,
    onboarded: true,
    compSince: null,
    compOpeningDays: 0,
    compOpeningMinutes: 0,
  })
})
it('reglas remotas de una versión vieja no pisan el saldo inicial local', async () => {
  const server = new MockBackend()
  const { compSince, compOpeningDays, compOpeningMinutes, compOpeningCentihours, ...base } =
    defaults
  void compSince
  void compOpeningDays
  void compOpeningMinutes
  void compOpeningCentihours
  server.rows.set(rulesId, {
    id: rulesId,
    collection: 'rules',
    data: { id: rulesId, ...rulesSchema.parse({ ...base, start: 480 }) },
    revision: crypto.randomUUID(),
    updated_at: new Date(Date.UTC(2026, 10, 1)).toISOString(),
    deleted_at: null,
  })
  const local = {
    ...defaults,
    compSince: '2026-11-10',
    compOpeningDays: 3,
    compOpeningMinutes: 91,
    compOpeningCentihours: 2551,
  }
  await putMeta('settings', local)
  await cycle(server)
  expect(useHours.getState().settings).toMatchObject({
    start: 480,
    compSince: '2026-11-10',
    compOpeningDays: 3,
    compOpeningMinutes: 91,
    compOpeningCentihours: 2551,
  })
  await server.push([
    {
      id: rulesId,
      collection: 'rules',
      revision: crypto.randomUUID(),
      deleted: false,
      data: {
        id: rulesId,
        ...rulesSchema.parse(base),
        compSince: '2026-11-10',
        compOpeningDays: 2,
        compOpeningMinutes: 15,
      },
    },
  ])
  await cycle(server)
  expect(useHours.getState().settings).toMatchObject({
    compOpeningDays: 2,
    compOpeningMinutes: 15,
    compOpeningCentihours: null,
  })
})
it('al guardar las reglas se sincroniza el saldo inicial', async () => {
  useHours.setState({ settings: defaults })
  await saveSettings({
    compSince: '2026-11-10',
    compOpeningDays: 3,
    compOpeningMinutes: 91,
    compOpeningCentihours: 2551,
  })
  expect((await db.queue.get(rulesId))?.data).toMatchObject({
    id: rulesId,
    compSince: '2026-11-10',
    compOpeningDays: 3,
    compOpeningMinutes: 91,
    compOpeningCentihours: 2551,
  })
})
it('conserva el saldo decimal recibido si otro dispositivo anterior cambia el horario', async () => {
  const server = new MockBackend()
  await putMeta('settings', defaults)
  const date = '2026-11-10'
  const opening = { compSince: date, compOpeningDays: 3, compOpeningMinutes: 91 }
  const data = { id: rulesId, ...rulesSchema.parse({ ...defaults, ...opening }) }
  const pushRules = (data: unknown) =>
    server.push([
      { id: rulesId, collection: 'rules', revision: crypto.randomUUID(), deleted: false, data },
    ])
  await pushRules({ ...data, compOpeningCentihours: 2551 })
  await cycle(server)
  expect(useHours.getState().settings.compOpeningCentihours).toBe(2551)

  const { compOpeningCentihours, ...legacy } = data
  void compOpeningCentihours
  await pushRules({ ...legacy, start: 480 })
  await cycle(server)
  expect(useHours.getState().settings).toMatchObject({
    start: 480,
    ...opening,
    compOpeningCentihours: 2551,
  })

  await pushRules({ ...legacy, compOpeningDays: 2 })
  await cycle(server)
  expect(useHours.getState().settings).toMatchObject({
    ...opening,
    compOpeningDays: 2,
    compOpeningCentihours: null,
  })

  await pushRules(legacy)
  await cycle(server)
  expect((await db.records.get(rulesId))?.data).toMatchObject({
    ...opening,
    compOpeningCentihours: null,
  })
})
