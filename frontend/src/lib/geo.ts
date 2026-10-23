// Map geometry for legs and Raasta routes: lines between real coordinates from the API, never a made-up
// road. Where no road is known the line is straight and marked approximate, and the map draws it dashed.
import type { Trip } from '@/api/types'
import type { Mode } from './types'

export type LngLat = [number, number]
export interface MapLine {
  id: string
  coords: LngLat[]
  mode: Mode
  dim?: boolean
  /** The leg the traveller is on or takes next: drawn with a moving flow along it. */
  active?: boolean
  /** A straight line where no road is known: drawn dashed and lighter. */
  approximate?: boolean
  /** A metro line's own colour. */
  color?: string
}

export type PlaceIndex = Map<string, LngLat>

/** Every place in the trip (the stay and each task's place), by placeId. */
export function placeIndex(trip: Trip): PlaceIndex {
  const index: PlaceIndex = new Map([[trip.stayPlace.placeId, [trip.stayPlace.lng, trip.stayPlace.lat]]])
  for (const t of trip.tasks) index.set(t.placeId, [t.place.lng, t.place.lat])
  return index
}

/** A Raasta route's recorded GPS path; null when nobody has recorded one (Raasta then sends its stands as the path). */
export function recordedPath(route: { path: { lng: number; lat: number }[]; stands: { location: { lng: number; lat: number } }[] }): LngLat[] | null {
  const path = route.path.map((p) => [p.lng, p.lat] as LngLat)
  const stands = route.stands.map((s) => [s.location.lng, s.location.lat] as LngLat)
  const same = path.length === stands.length && path.every((p, i) => p[0] === stands[i][0] && p[1] === stands[i][1])
  return path.length > 1 && !same ? path : null
}

/** A Raasta route's line: its recorded GPS path, or straight between its stands (marked approximate). */
export function routeLine(id: string, points: LngLat[], mode: Mode, approximate = false): MapLine[] {
  return points.length < 2 ? [] : [{ id, coords: points, mode, approximate }]
}
