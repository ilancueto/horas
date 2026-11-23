import { describe, expect, it, vi } from 'vitest'
import { joinOutcome, pairingLink, readPairingKey, takePairingKey } from './pairing'
import { qrModules } from './qr'

describe('pairingLink', () => {
  it('arma el enlace con la clave en el fragmento', () => {
    expect(pairingLink('https://ejemplo.com', '/', 'abc123')).toBe(
      'https://ejemplo.com/#clave=abc123',
    )
    expect(pairingLink('https://usuario.github.io', '/horas/', 'abc')).toBe(
      'https://usuario.github.io/horas/#clave=abc',
    )
  })
  it('codifica los caracteres especiales de la clave', () => {
    expect(pairingLink('http://127.0.0.1:5173', '/', 'a b&c#d/é')).toBe(
      'http://127.0.0.1:5173/#clave=a%20b%26c%23d%2F%C3%A9',
    )
  })
})

describe('readPairingKey', () => {
  it('lee y decodifica la clave', () => {
    expect(readPairingKey('#clave=abc123')).toBe('abc123')
    expect(readPairingKey('#clave=a%20b%26c%23d%2F%C3%A9')).toBe('a b&c#d/é')
    expect(readPairingKey('#clave=%20%20abc%20')).toBe('abc')
  })
  it('vuelve a leer lo que arma pairingLink', () => {
    const key = 'K3y+/=?&ñ'
    const link = new URL(pairingLink('https://x.dev', '/horas/', key))
    expect(readPairingKey(link.hash)).toBe(key)
  })
  it('ignora fragmentos vacíos o que no son #clave=', () => {
    for (const hash of [
      '',
      '#',
      '#clave=',
      '#clave=%20%20',
      '#otra=abc',
      '#contenido',
      '#claves=abc',
      '?clave=abc',
    ])
      expect(readPairingKey(hash)).toBeNull()
  })
  it('ignora una codificación inválida', () => {
    expect(readPairingKey('#clave=%E0%A4%A')).toBeNull()
  })
})

describe('takePairingKey', () => {
  const place = (hash: string) => ({ hash, pathname: '/horas/', search: '?hoy=1' })
  it('devuelve la clave y la borra de la barra de inmediato', () => {
    const replaceState = vi.fn()
    expect(takePairingKey(place('#clave=abc'), { replaceState })).toBe('abc')
    expect(replaceState).toHaveBeenCalledWith(null, '', '/horas/?hoy=1')
  })
  it('no toca la URL si el fragmento no es un enlace de vinculación', () => {
    const replaceState = vi.fn()
    expect(takePairingKey(place('#contenido'), { replaceState })).toBeNull()
    expect(takePairingKey(place(''), { replaceState })).toBeNull()
    expect(replaceState).not.toHaveBeenCalled()
  })
  it('borra un #clave= vacío sin devolver nada', () => {
    const replaceState = vi.fn()
    expect(takePairingKey(place('#clave='), { replaceState })).toBeNull()
    expect(replaceState).toHaveBeenCalledWith(null, '', '/horas/?hoy=1')
  })
})

describe('qrModules', () => {
  it('genera una matriz cuadrada con los patrones de posición', () => {
    const modules = qrModules('https://ejemplo.com/#clave=abc123')
    expect(modules.length).toBeGreaterThanOrEqual(21)
    expect(modules.every((row) => row.length === modules.length)).toBe(true)
    // Esquina superior izquierda: anillo oscuro de 7×7 con hueco claro.
    expect(modules[0].slice(0, 7)).toEqual(Array(7).fill(true))
    expect(modules[1].slice(0, 7)).toEqual([true, false, false, false, false, false, true])
  })
})

describe('joinOutcome', () => {
  const fresh = { needData: true, periods: 0 }
  it('entra solo si bajaron datos en un dispositivo sin configurar', () => {
    expect(joinOutcome('done', { ...fresh, periods: 2 })).toEqual({ outcome: 'ok', undo: false })
    expect(joinOutcome('merge', { ...fresh, periods: 1 })).toEqual({ outcome: 'ok', undo: false })
    expect(joinOutcome('done', fresh)).toEqual({ outcome: 'empty', undo: true })
    expect(joinOutcome('done', { ...fresh, needData: false })).toEqual({
      outcome: 'ok',
      undo: false,
    })
  })
  it('deshace con clave inválida o error, y conserva la clave si la nube está cifrada', () => {
    expect(joinOutcome('invalid', fresh)).toEqual({ outcome: 'invalid', undo: true })
    expect(joinOutcome('error', fresh)).toEqual({ outcome: 'error', undo: true })
    expect(joinOutcome('locked', fresh)).toEqual({ outcome: 'locked', undo: false })
  })
  it('al vencer la espera deshace salvo que ya hayan bajado períodos', () => {
    expect(joinOutcome('timeout', fresh)).toEqual({ outcome: 'error', undo: true })
    expect(joinOutcome('timeout', { ...fresh, needData: false })).toEqual({
      outcome: 'error',
      undo: true,
    })
    expect(joinOutcome('timeout', { ...fresh, periods: 3 })).toEqual({
      outcome: 'ok',
      undo: false,
    })
  })
})
