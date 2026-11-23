/** Multiplicadores fijos de las horas extra. */
export const extraRates = { extra: 1.5, double: 2 } as const

/**
 * Convierte horas decimales (las del recibo) en pesos.
 * Un valor hora vacío, no finito, cero o negativo da todo en cero.
 */
export function extraPay(hours: { extra: number; double: number }, rate: number) {
  if (!Number.isFinite(rate) || rate <= 0) return { extra: 0, double: 0, total: 0 }
  const extra = hours.extra * rate * extraRates.extra
  const double = hours.double * rate * extraRates.double
  return { extra, double, total: extra + double }
}

export const ars = (value: number) =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(value)
