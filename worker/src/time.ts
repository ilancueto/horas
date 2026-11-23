const pattern = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/

function toMicros(iso: string): number {
  const match = pattern.exec(iso)
  if (!match) throw new Error('Invalid timestamp')
  const seconds = Date.parse(`${match[1]}Z`)
  if (Number.isNaN(seconds)) throw new Error('Invalid timestamp')
  return seconds * 1000 + Number((match[2] ?? '').padEnd(6, '0'))
}

function fromMicros(micros: number): string {
  const fraction = micros % 1_000_000
  const seconds = new Date((micros - fraction) / 1000).toISOString().slice(0, 19)
  return `${seconds}.${String(fraction).padStart(6, '0')}Z`
}

/** ISO UTC con microsegundos, estrictamente posterior a `previous` si se indica. */
export function nextTimestamp(now: Date, previous?: string): string {
  const current = now.getTime() * 1000
  if (previous === undefined) return fromMicros(current)
  const last = toMicros(previous)
  return fromMicros(current > last ? current : last + 1)
}
