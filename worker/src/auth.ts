const encoder = new TextEncoder()

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))
}

/** Compara en tiempo constante los SHA-256 de la clave recibida y la esperada. */
export async function authorized(request: Request, key: string): Promise<boolean> {
  const header = request.headers.get('authorization')
  if (!header || !header.startsWith('Bearer ') || !key) return false
  const [received, expected] = await Promise.all([digest(header.slice(7)), digest(key)])
  let difference = 0
  for (let i = 0; i < expected.length; i++) difference |= received[i] ^ expected[i]
  return difference === 0
}
