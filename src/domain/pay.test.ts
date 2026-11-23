import { describe, expect, it } from 'vitest'
import { extraPay } from './pay'
import { decimalTotals, type DayRow } from './hours'

describe('extraPay', () => {
  it('multiplica las horas decimales por 1,5 y 2 veces el valor hora', () => {
    expect(extraPay({ extra: 12.5, double: 8 }, 5000)).toEqual({
      extra: 93750,
      double: 80000,
      total: 173750,
    })
  })
  it.each([0, -5, NaN, Infinity])('devuelve ceros si el valor hora es %s', (rate) => {
    expect(extraPay({ extra: 1, double: 1 }, rate)).toEqual({ extra: 0, double: 0, total: 0 })
  })
  it('usa las horas del recibo con y sin redondeo de Excel', () => {
    const row = (extra: number) =>
      ({ hours: { normal: 0, extra, double: 0, total: extra } }) as DayRow
    const rows = [row(35), row(35)]
    // Excel redondea cada jornada: 0,58 + 0,58 = 1,16 h; por minutos exactos 70 min = 1,17 h.
    expect(extraPay(decimalTotals(rows, true), 1000).extra).toBeCloseTo(1740, 6)
    expect(extraPay(decimalTotals(rows, false), 1000).extra).toBeCloseTo(1755, 6)
  })
})
