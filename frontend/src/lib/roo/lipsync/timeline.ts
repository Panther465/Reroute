// When each shape happens: a track built from the voice's word timings (or estimated, for the phone's own
// voice and for typing), sampled every frame into one mouth shape.

import { mix, REST, type MouthParams } from './mouth'
import { POSES, wordToVisemes, type Viseme } from './visemes'

export interface TimedWord {
  text: string
  offsetMs: number
  durationMs: number
}

export interface Key {
  t: number
  end: number
  v: Viseme
  amp: number
}

/** A pause longer than this between words is a breath: the mouth closes. */
const GAP_MS = 120
/** Lips must stay shut this long on b, m and p, or the eye doesn't see them close. */
const SHUT_MS = 60
/** How long one shape takes to blend into the next; lips snap shut faster, or b, m and p never close. */
const BLEND_MS = 70
const SHUT_BLEND_MS = 25

/** The track for a line: each word's shapes share its time by weight, a little early (`leadMs`), since the
 *  mouth moves just before the sound is heard. */
export function buildTrack(words: TimedWord[], leadMs = 60): Key[] {
  const keys: Key[] = []
  let prevEnd = 0
  for (const word of words) {
    const start = Math.max(0, word.offsetMs - leadMs)
    if (keys.length && start - prevEnd > GAP_MS) keys.push({ t: prevEnd, end: start, v: 'rest', amp: 0 })
    const shapes = wordToVisemes(word.text)
    const dur = Math.max(word.durationMs, shapes.length * 40)
    const minShut = shapes.filter((s) => s.v === 'MBP').length * SHUT_MS
    const spare = Math.max(0, dur - minShut)
    const total = shapes.reduce((sum, s) => sum + (s.v === 'MBP' ? 0 : s.weight), 0) || 1
    let t = start
    for (const s of shapes) {
      const len = s.v === 'MBP' ? Math.max(SHUT_MS, (spare * s.weight) / total / 2) : (spare * s.weight) / total
      keys.push({ t, end: t + len, v: s.v, amp: s.amp })
      t += len
    }
    prevEnd = t
  }
  if (keys.length) keys.push({ t: prevEnd, end: prevEnd + 400, v: 'rest', amp: 0 })
  return keys
}

/** Words spread over `totalMs` by length, with pauses at commas and full stops: for a voice that doesn't
 *  say when each word is spoken, and for Roo's mouth moving as it types. */
export function estimateWords(text: string, totalMs: number): TimedWord[] {
  const parts = text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w))
  if (!parts.length || totalMs <= 0) return []
  const pauses: number[] = parts.map((w) => (/[.!?]$/.test(w) ? 3 : /[,;:]$/.test(w) ? 1.5 : 0))
  const weights = parts.map((w) => Math.max(1, w.replace(/[^\p{L}\p{N}]/gu, '').length))
  const units = weights.reduce((a, b) => a + b, 0) + pauses.reduce((a, b) => a + b, 0)
  const unit = totalMs / units
  let t = 0
  return parts.map((w, i) => {
    const word = { text: w, offsetMs: Math.round(t), durationMs: Math.round(weights[i] * unit) }
    t += (weights[i] + pauses[i]) * unit
    return word
  })
}

const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x))

function pose(k: Key | undefined, loud: number, strength: number): MouthParams {
  if (!k || k.v === 'rest') return REST
  const p = POSES[k.v]
  if (k.v === 'MBP') return p
  return { ...p, open: p.open * k.amp * (0.35 + 0.65 * loud) * strength, wide: p.wide * Math.min(1, 0.5 + k.amp), round: p.round * strength }
}

/** The mouth at `t` ms into the line. `loud` (0–1) is how loud the voice is right then; `strength` scales
 *  the whole movement (half for murmuring along with typing). */
export function sampleTrack(track: Key[], t: number, loud = 1, strength = 1): MouthParams {
  if (!track.length || t < track[0].t || t >= track[track.length - 1].end) return REST
  let i = 0
  while (i < track.length - 1 && track[i].end <= t) i++
  const k = track[i]
  const now = pose(k, loud, strength)
  const into = t - k.t
  const blend = k.v === 'MBP' ? SHUT_BLEND_MS : BLEND_MS
  if (i === 0 || into >= blend) return now
  return mix(pose(track[i - 1], loud, strength), now, smooth(into / blend))
}
