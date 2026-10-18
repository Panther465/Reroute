// Formatting helpers. Times are minutes from midnight; output follows section 12.
export function toMin(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

export function hhmm(min: number): string {
  const m = ((Math.round(min) % 1440) + 1440) % 1440
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

export function duration(min: number): string {
  const m = Math.round(min)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  const r = m % 60
  return r ? `${h} h ${r} min` : `${h} h`
}

export function spokenDuration(min: number): string {
  const m = Math.round(min)
  if (m < 60) return `${m} minutes`
  const h = Math.floor(m / 60)
  const r = m % 60
  const hs = h === 1 ? '1 hour' : `${h} hours`
  return r ? `${hs} ${r} minutes` : hs
}

export function rupees(n: number): string {
  return `₹${n.toLocaleString('en-IN')}`
}

const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']
export function countWord(n: number): string {
  return WORDS[n] ?? String(n)
}

export function listJoin(items: string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

export function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1)
}
