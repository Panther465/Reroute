// Map geometry for legs and Raasta routes. Lines are drawn between real coordinates from the API;
// the gentle bend only makes a straight-line estimate read as a route, not a ruler.
import type { Mode } from './types'
import type { LegView } from './timeline'

export type LngLat = [number, number]
export interface MapLine {
  id: string
  coords: LngLat[]
  mode: Mode
  dim?: boolean
}

export type PlaceIndex = Map<string, LngLat>

function lerp(a: LngLat, b: LngLat, t: number): LngLat {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
}

/** A gently bent path between two points. */
export function bentPath(a: LngLat, b: LngLat, bend = 0.12, steps = 24): LngLat[] {
  const mid = lerp(a, b, 0.5)
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const ctrl: LngLat = [mid[0] - dy * bend, mid[1] + dx * bend]
  const out: LngLat[] = []
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    out.push(lerp(lerp(a, ctrl, t), lerp(ctrl, b, t), t))
  }
  return out
}

export function polylineThrough(points: LngLat[], steps = 8): LngLat[] {
  const out: LngLat[] = []
  for (let i = 0; i < points.length - 1; i++) {
    const seg = bentPath(points[i], points[i + 1], 0.08, steps)
    out.push(...(i === 0 ? seg : seg.slice(1)))
  }
  return out
}

function splitBy(coords: LngLat[], weights: number[]): LngLat[][] {
  const total = weights.reduce((a, b) => a + b, 0) || 1
  const parts: LngLat[][] = []
  let start = 0
  let acc = 0
  weights.forEach((w, i) => {
    acc += w
    const end = i === weights.length - 1 ? coords.length - 1 : Math.max(start + 1, Math.round((acc / total) * (coords.length - 1)))
    parts.push(coords.slice(start, end + 1))
    start = end
  })
  return parts
}

/** A leg's line, split into its mode segments. `path` is a known route path (Raasta) when we have one. */
export function legLines(leg: Pick<LegView, 'seq' | 'fromPlaceId' | 'toPlaceId' | 'segments'>, places: PlaceIndex, dim = false, path?: LngLat[]): MapLine[] {
  const a = places.get(leg.fromPlaceId)
  const b = places.get(leg.toPlaceId)
  if (!a || !b) return []
  const coords = path && path.length > 1 ? [a, ...path, b] : bentPath(a, b, leg.seq % 2 ? 0.12 : -0.1, 32)
  const parts = splitBy(
    coords,
    leg.segments.map((s) => s.minutes),
  )
  return parts.map((c, i) => ({ id: `${leg.seq}-${i}`, coords: c, mode: leg.segments[i].mode, dim }))
}

export function routeLine(id: string, points: LngLat[], mode: Mode): MapLine[] {
  return points.length < 2 ? [] : [{ id, coords: points.length > 2 ? points : polylineThrough(points), mode }]
}
