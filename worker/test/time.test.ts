import { describe, expect, it } from 'vitest'
import { nextTimestamp } from '../src/time'

describe('nextTimestamp', () => {
  it('formatea en UTC con 6 decimales', () => {
    expect(nextTimestamp(new Date('2026-11-23T12:00:00.123Z'))).toBe('2026-11-23T12:00:00.123000Z')
  })

  it('suma 1 µs si el reloj no avanzó respecto del anterior', () => {
    expect(nextTimestamp(new Date('2026-11-23T12:00:00.123Z'), '2026-11-23T12:00:00.123000Z')).toBe(
      '2026-11-23T12:00:00.123001Z',
    )
  })

  it('suma 1 µs al anterior si es posterior al reloj', () => {
    expect(nextTimestamp(new Date('2026-11-23T12:00:00.000Z'), '2026-11-23T12:00:05.500250Z')).toBe(
      '2026-11-23T12:00:05.500251Z',
    )
  })

  it('arrastra correctamente al pasar de 999999 µs', () => {
    expect(nextTimestamp(new Date('2026-11-23T12:00:00.000Z'), '2026-11-23T12:00:00.999999Z')).toBe(
      '2026-11-23T12:00:01.000000Z',
    )
    expect(nextTimestamp(new Date('2026-01-01T00:00:00.000Z'), '2026-12-31T23:59:59.999999Z')).toBe(
      '2027-01-01T00:00:00.000000Z',
    )
  })

  it('usa el reloj si es posterior al anterior', () => {
    expect(nextTimestamp(new Date('2026-11-23T12:00:01.000Z'), '2026-11-23T12:00:00.999999Z')).toBe(
      '2026-11-23T12:00:01.000000Z',
    )
  })
})
