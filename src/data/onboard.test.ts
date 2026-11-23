import 'fake-indexeddb/auto'
import { beforeEach, expect, it } from 'vitest'
import { defaults, rulesId } from '../domain/model'
import { db, getMeta, markOnboarded, putMeta, useHours } from './db'
import { settingsSchema } from '../domain/model'

beforeEach(async () => {
  await db.records.clear()
  await db.queue.clear()
  await db.meta.clear()
  useHours.setState({ settings: defaults })
})

it('marca el dispositivo como configurado sin encolar ni tocar las reglas', async () => {
  await putMeta('settings', { ...defaults, theme: 'dark', dailyReminder: true, closing: 20 })
  await markOnboarded()
  expect(await db.queue.count()).toBe(0)
  expect(await db.records.get(rulesId)).toBeUndefined()
  const stored = await getMeta('settings', settingsSchema, defaults)
  expect(stored).toEqual({
    ...defaults,
    theme: 'dark',
    dailyReminder: true,
    closing: 20,
    onboarded: true,
  })
  expect(useHours.getState().settings.onboarded).toBe(true)
  expect(useHours.getState().settings.theme).toBe('dark')
})

it('usa las reglas que bajaron de la nube y no las pisa', async () => {
  const rules = { ...defaults, closing: 5, start: 480, end: 1020 }
  await db.records.put({
    id: rulesId,
    collection: 'rules',
    data: {
      id: rulesId,
      start: rules.start,
      end: rules.end,
      breakMinutes: rules.breakMinutes,
      saturday: rules.saturday,
      early: rules.early,
      nonWorking: rules.nonWorking,
      closing: rules.closing,
      annualLeave: rules.annualLeave,
      lockClosed: rules.lockClosed,
    },
    deleted: false,
    revision: 'r1',
  })
  await markOnboarded()
  expect(await db.queue.count()).toBe(0)
  expect((await db.records.get(rulesId))?.revision).toBe('r1')
  const { settings } = useHours.getState()
  expect(settings.onboarded).toBe(true)
  expect(settings.closing).toBe(5)
  expect(settings.start).toBe(480)
})

it('funciona sin ajustes locales guardados', async () => {
  await markOnboarded()
  expect(await db.queue.count()).toBe(0)
  expect(await getMeta('settings', settingsSchema, defaults)).toEqual({
    ...defaults,
    onboarded: true,
  })
})
