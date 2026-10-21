// Where the traveller is along a leg's road path: the nearest point on it, how far off it they are,
// and how much is left. Local flat-earth maths is plenty at city scale.
import type { LngLat } from './geo'

const R = 6_371_000

export function metres(a: LngLat, b: LngLat): number {
  const dLat = ((b[1] - a[1]) * Math.PI) / 180
  const dLng = ((b[0] - a[0]) * Math.PI) / 180
  const h = Math.sin(dLat / 2) ** 2 + Math.cos((a[1] * Math.PI) / 180) * Math.cos((b[1] * Math.PI) / 180) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

export interface Progress {
  /** The point on the path nearest the traveller. */
  snapped: LngLat
  /** Index of the path segment it lies on. */
  segment: number
  offRouteM: number
  remainingM: number
  totalM: number
}

/** Project `at` onto the path and measure what's left to its end. */
export function progressAlong(path: LngLat[], at: LngLat): Progress | null {
  if (path.length < 2) return null
  const kx = Math.cos((at[1] * Math.PI) / 180)
  const xy = (p: LngLat) => [p[0] * kx, p[1]] as const
  const [px, py] = xy(at)
  let best = { d: Infinity, seg: 0, t: 0 }
  for (let i = 0; i < path.length - 1; i++) {
    const [ax, ay] = xy(path[i])
    const [bx, by] = xy(path[i + 1])
    const dx = bx - ax
    const dy = by - ay
    const len = dx * dx + dy * dy
    const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0
    const d = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2
    if (d < best.d) best = { d, seg: i, t }
  }
  const a = path[best.seg]
  const b = path[best.seg + 1]
  const snapped: LngLat = [a[0] + (b[0] - a[0]) * best.t, a[1] + (b[1] - a[1]) * best.t]
  let remaining = metres(snapped, b)
  for (let i = best.seg + 1; i < path.length - 1; i++) remaining += metres(path[i], path[i + 1])
  let total = 0
  for (let i = 0; i < path.length - 1; i++) total += metres(path[i], path[i + 1])
  return { snapped, segment: best.seg, offRouteM: metres(at, snapped), remainingM: remaining, totalM: total }
}

/** The path split where the traveller is: what's behind them and what's still ahead. */
export function splitPath(path: LngLat[], p: Progress): { behind: LngLat[]; ahead: LngLat[] } {
  return { behind: [...path.slice(0, p.segment + 1), p.snapped], ahead: [p.snapped, ...path.slice(p.segment + 1)] }
}

export function distanceLabel(m: number) {
  if (m < 950) return `${Math.max(10, Math.round(m / 10) * 10)} m`
  return `${(m / 1000).toFixed(m < 9_950 ? 1 : 0)} km`
}
