import qrcode from 'qrcode-generator'

/** Matriz de módulos del QR (true = oscuro), sin margen. Se carga aparte, solo al pedir el enlace. */
export function qrModules(text: string): boolean[][] {
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  const size = qr.getModuleCount()
  return Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, col) => qr.isDark(row, col)),
  )
}
