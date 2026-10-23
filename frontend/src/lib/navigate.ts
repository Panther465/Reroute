// Following a leg: which instruction comes next, how far it is, how far is left, and whether the traveller
// has left the route. Positions come from the phone (lib/location.ts) and never leave it.
import type { LegPath } from '@/api/types'
import type { LngLat } from './geo'
import { metres } from './progress'
import { instruction, roughInstruction, type Instruction } from './turns'

/** A fix less accurate than this can't tell one street from the next: it's ignored. */
export const WORST_ACCURACY_M = 100
/** Further than this from the route (or the fix's own accuracy, if that's more), twice running: off route. */
export const OFF_ROUTE_WALK_M = 40
export const OFF_ROUTE_RIDE_M = 60

export interface NavStep extends Instruction {
  /** The stretch it belongs to (an index into the leg's segments). */
  segment: number
  /** Metres along the whole leg where it starts. */
  atM: number
  at: LngLat
}

/** The leg as one line with the metres along it at each point, and its instructions in order. */
export interface Course {
  line: LngLat[]
  along: number[]
  steps: NavStep[]
  totalM: number
  /** On foot all the way: closer tolerances for "off route". */
  walking: boolean
}

export function course(path: LegPath, to: string): Course {
  const line: LngLat[] = []
  const along: number[] = []
  const steps: NavStep[] = []
  let total = 0
  path.segments.forEach((s, si) => {
    // Where each of the segment's own points landed on the leg's line (a shared joint lands once).
    const landed = s.coords.map((c) => {
      const p: LngLat = [c[0], c[1]]
      const last = line[line.length - 1]
      if (!last || last[0] !== p[0] || last[1] !== p[1]) {
        if (last) total += metres(last, p)
        line.push(p)
        along.push(total)
      }
      return line.length - 1
    })
    const end = path.segments[si + 1]?.stops[0]?.name ?? to
    if (s.source === 'approximate' || s.steps.length === 0) {
      const i = landed[0] ?? Math.max(0, line.length - 1)
      steps.push({ ...roughInstruction(s, end), segment: si, atM: along[i] ?? 0, at: line[i] })
      return
    }
    for (const st of s.steps) {
      // Joins between stretches aren't instructions: only the leg's own start and end are.
      if ((st.kind === 'depart' && si > 0) || (st.kind === 'arrive' && si < path.segments.length - 1)) continue
      const i = landed[Math.min(st.at ?? 0, landed.length - 1)] ?? 0
      steps.push({ ...instruction(st, s, end), segment: si, atM: along[i], at: line[i] })
    }
  })
  return { line, along, steps, totalM: total, walking: path.segments.every((s) => s.mode === 'walk') }
}

export interface Tracker {
  /** The line point last matched: the next match looks around it first, so a route that doubles back doesn't jump. */
  index: number
  offCount: number
  offRoute: boolean
}

export const START: Tracker = { index: 0, offCount: 0, offRoute: false }

export interface Where {
  tracker: Tracker
  /** The instruction to follow next: an index into the course's steps. */
  next: number
  toNextM: number
  remainingM: number
  snapped: LngLat
}

/** Where a fix puts the traveller on the course. A fix too rough to place keeps the last answer (null at first). */
export function follow(c: Course, t: Tracker, fix: { lng: number; lat: number; accuracy: number }, previous: Where | null = null): Where | null {
  if (c.line.length < 2) return null
  if (fix.accuracy > WORST_ACCURACY_M) return previous
  const at: LngLat = [fix.lng, fix.lat]
  const kx = Math.cos((at[1] * Math.PI) / 180)
  const xy = (p: LngLat) => [p[0] * kx * 111_320, p[1] * 110_540] as const
  const [px, py] = xy(at)
  let best = { d: Infinity, i: 0, f: 0 }
  for (let i = Math.max(0, t.index - 3); i < c.line.length - 1; i++) {
    const [ax, ay] = xy(c.line[i])
    const [bx, by] = xy(c.line[i + 1])
    const dx = bx - ax
    const dy = by - ay
    const len = dx * dx + dy * dy
    const f = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0
    const d = Math.hypot(px - ax - f * dx, py - ay - f * dy)
    if (d < best.d) best = { d, i, f }
  }
  const a = c.line[best.i]
  const b = c.line[best.i + 1]
  const snapped: LngLat = [a[0] + (b[0] - a[0]) * best.f, a[1] + (b[1] - a[1]) * best.f]
  const doneM = c.along[best.i] + metres(a, snapped)
  const off = best.d > Math.max(fix.accuracy, c.walking ? OFF_ROUTE_WALK_M : OFF_ROUTE_RIDE_M)
  const offCount = off ? t.offCount + 1 : 0
  const tracker = { index: off ? t.index : best.i, offCount, offRoute: offCount >= 2 }
  // The next instruction is the first that starts ahead of the traveller (a few metres of slack).
  const ahead = c.steps.findIndex((s) => s.atM > doneM + 5)
  const next = ahead === -1 ? c.steps.length - 1 : ahead
  return { tracker, next, toNextM: Math.max(0, (c.steps[next]?.atM ?? c.totalM) - doneM), remainingM: Math.max(0, c.totalM - doneM), snapped }
}
