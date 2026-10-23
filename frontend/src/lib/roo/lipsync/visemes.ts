// Mouth shapes for English sounds, from spelling. Good enough for a cartoon mouth: what people notice is
// the lips closing on b, m and p, rounding on o and oo, and widening on ee, in time with the voice.

import type { MouthParams } from './mouth'

export type Viseme = 'rest' | 'MBP' | 'AI' | 'E' | 'O' | 'U' | 'FV' | 'L'

export const POSES: Record<Viseme, MouthParams> = {
  rest: { open: 0, wide: 0, round: 0, smile: 0.35 },
  MBP: { open: 0, wide: -0.1, round: 0, smile: 0.1 },
  AI: { open: 0.85, wide: 0.2, round: 0, smile: 0.15 },
  E: { open: 0.45, wide: 0.7, round: 0, smile: 0.3 },
  O: { open: 0.7, wide: -0.35, round: 0.9, smile: 0 },
  U: { open: 0.35, wide: -0.6, round: 1, smile: 0 },
  FV: { open: 0.15, wide: 0.25, round: 0, smile: 0.05 },
  L: { open: 0.4, wide: 0.2, round: 0, smile: 0.1 },
}

/** One shape in a word: which, how long relative to the others, and how strongly (a weak consonant
 *  barely opens the mouth). */
export interface Shape {
  v: Viseme
  weight: number
  amp: number
}

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen']
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']

/** "45" as it's said: "forty five". Long numbers are read digit by digit. */
export function spellNumber(digits: string): string {
  const n = Number(digits)
  if (!Number.isFinite(n) || digits.length > 4) return digits.split('').map((d) => ONES[Number(d)] ?? '').join(' ')
  if (n < 20) return ONES[n]
  if (n < 100) return `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${spellNumber(String(n % 100))}` : ''}`
  return `${spellNumber(digits.slice(0, -2))} hundred${n % 100 ? ` ${spellNumber(String(n % 100))}` : ''}`
}

// Longest first: two letters that make one sound.
const PAIRS: Record<string, Shape> = {
  th: { v: 'L', weight: 0.8, amp: 0.6 },
  ph: { v: 'FV', weight: 0.8, amp: 1 },
  sh: { v: 'U', weight: 0.8, amp: 0.6 },
  ch: { v: 'U', weight: 0.8, amp: 0.6 },
  wh: { v: 'U', weight: 0.7, amp: 0.8 },
  qu: { v: 'U', weight: 0.9, amp: 0.8 },
  oo: { v: 'U', weight: 1.2, amp: 1 },
  ou: { v: 'O', weight: 1.1, amp: 1 },
  ow: { v: 'O', weight: 1.1, amp: 1 },
  oa: { v: 'O', weight: 1.1, amp: 1 },
  oi: { v: 'O', weight: 1.1, amp: 1 },
  ee: { v: 'E', weight: 1.1, amp: 1 },
  ea: { v: 'E', weight: 1.1, amp: 1 },
  ie: { v: 'E', weight: 1, amp: 1 },
  ai: { v: 'AI', weight: 1.1, amp: 1 },
  ay: { v: 'AI', weight: 1.1, amp: 1 },
  ei: { v: 'E', weight: 1.1, amp: 1 },
  ey: { v: 'E', weight: 1, amp: 1 },
  ng: { v: 'E', weight: 0.6, amp: 0.35 },
  ck: { v: 'E', weight: 0.5, amp: 0.35 },
}

function single(c: string, next: string, last: boolean): Shape | null {
  switch (c) {
    case 'a':
      return { v: 'AI', weight: 1, amp: 1 }
    case 'e':
      return { v: 'E', weight: 1, amp: 0.9 }
    case 'i':
      return { v: 'E', weight: 1, amp: 0.8 }
    case 'o':
      return { v: 'O', weight: 1, amp: 1 }
    case 'u':
      return { v: next === 'r' ? 'O' : 'AI', weight: 0.9, amp: 0.7 }
    case 'y':
      return last ? { v: 'E', weight: 0.9, amp: 0.9 } : { v: 'E', weight: 0.5, amp: 0.4 }
    case 'b':
    case 'm':
    case 'p':
      return { v: 'MBP', weight: 0.7, amp: 0 }
    case 'f':
    case 'v':
      return { v: 'FV', weight: 0.8, amp: 1 }
    case 'w':
      return { v: 'U', weight: 0.8, amp: 0.8 }
    case 'l':
      return { v: 'L', weight: 0.6, amp: 0.7 }
    case 'r':
      return { v: 'O', weight: 0.5, amp: 0.4 }
    case 'h':
      return null
    default:
      // t d n s z k g c j x: the teeth nearly together, the mouth barely open.
      return /[a-z]/.test(c) ? { v: 'E', weight: 0.5, amp: 0.35 } : null
  }
}

/** The shapes a word makes, in order. Numbers are spelled out; letters a word doesn't say (the final e
 *  of "time", the k of "know") make none; text in another script gets an even talking rhythm. */
export function wordToVisemes(word: string): Shape[] {
  const spelled = word.toLowerCase().replace(/\d+/g, (d) => ` ${spellNumber(d)} `)
  const letters = spelled.replace(/[^a-z]/g, '')
  if (!letters) {
    // Not Latin letters (Hindi, say): open and close by syllable.
    const syllables = Math.max(1, Math.round([...word.trim()].length / 2))
    return Array.from({ length: syllables }, (_, i) => ({ v: i % 2 ? 'E' : 'AI', weight: 1, amp: 0.8 }) as Shape)
  }
  let w = letters
  if (/^(kn|wr)/.test(w)) w = w.slice(1)
  if (w.endsWith('mb')) w = w.slice(0, -1)
  if (w.length > 2 && w.endsWith('e') && !/[aeiou]e$/.test(w)) w = w.slice(0, -1)
  const out: Shape[] = []
  for (let i = 0; i < w.length; ) {
    const pair = PAIRS[w.slice(i, i + 2)]
    const shape = pair ?? single(w[i], w[i + 1] ?? '', i === w.length - 1)
    i += pair ? 2 : 1
    if (!shape) continue
    const prev = out[out.length - 1]
    if (prev && prev.v === shape.v) {
      prev.weight += shape.weight * 0.6
      prev.amp = Math.max(prev.amp, shape.amp)
    } else out.push({ ...shape })
  }
  return out.length ? out : [{ v: 'E', weight: 1, amp: 0.4 }]
}
