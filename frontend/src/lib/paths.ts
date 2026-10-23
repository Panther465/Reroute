// Each leg along real roads, metro lines and recorded paths: the server draws them after planning
// (GET /v1/trips/:id/plans/:version/paths). Asked once per plan version and kept on the phone, so maps
// work offline; asked again every 15 s while the server is still drawing, and when it says it's done.
// Never a made-up road: a leg not drawn yet, or a stretch nothing better is known for, is a straight line,
// marked approximate (the map draws it dashed).
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { api } from '@/api/client'
import { keys } from '@/api/queries'
import type { LegPath, PlanPaths, Trip } from '@/api/types'
import type { LngLat, MapLine, PlaceIndex } from './geo'
import type { LegView } from './timeline'

export function usePlanPaths(trip: Trip | undefined): Map<number, LegPath> {
  const version = trip?.activePlan?.version ?? null
  const q = useQuery({
    queryKey: keys.paths(trip?.tripId ?? '', version ?? 0),
    queryFn: () => api.get<PlanPaths>(`/v1/trips/${trip!.tripId}/plans/${version}/paths`),
    enabled: !!trip && version != null,
    // A plan version's paths never change once drawn; until then, ask again.
    staleTime: Infinity,
    gcTime: 7 * 24 * 3600_000,
    refetchInterval: (query) => (query.state.data && !query.state.data.complete ? 15_000 : false),
    retry: 1,
  })
  return useMemo(() => new Map((q.data?.legs ?? []).map((leg) => [leg.seq, leg])), [q.data])
}

/** The whole leg as one line, start to end: its segments joined. */
export function legCoords(path: LegPath | undefined): LngLat[] {
  const out: LngLat[] = []
  for (const segment of path?.segments ?? [])
    for (const c of segment.coords) {
      const last = out[out.length - 1]
      if (!last || last[0] !== c[0] || last[1] !== c[1]) out.push([c[0], c[1]])
    }
  return out
}

/** Each drawn leg's line by leg number, for the guide: distance left, progress, the simulated ride. */
export function roadsOf(paths: Map<number, LegPath>): Map<number, LngLat[]> {
  const out = new Map<number, LngLat[]>()
  paths.forEach((path, seq) => {
    const coords = legCoords(path)
    if (coords.length > 1) out.set(seq, coords)
  })
  return out
}

type LegEnds = Pick<LegView, 'seq' | 'fromPlaceId' | 'toPlaceId' | 'segments'>

/** A leg's lines for the map: each drawn segment as it is, or a straight dashed line until it's drawn. */
export function pathLines(leg: LegEnds, path: LegPath | undefined, places: PlaceIndex, dim = false): MapLine[] {
  if (path?.segments.length)
    return path.segments.map((s, i) => ({ id: `${leg.seq}-${i}`, coords: s.coords as LngLat[], mode: s.mode, dim, approximate: s.source === 'approximate', color: s.line?.colour }))
  const a = places.get(leg.fromPlaceId)
  const b = places.get(leg.toPlaceId)
  if (!a || !b) return []
  const mode = leg.segments.find((s) => s.mode !== 'walk')?.mode ?? leg.segments[0]?.mode ?? 'cab'
  return [{ id: `${leg.seq}-0`, coords: [a, b], mode, dim, approximate: true }]
}

export interface StationDot {
  lngLat: LngLat
  name: string
  color: string
}

/** Metro stations along drawn rides, for small dots on the line. */
export function stationDots(paths: (LegPath | undefined)[]): StationDot[] {
  return paths.flatMap((path) =>
    (path?.segments ?? []).filter((s) => s.source === 'rail').flatMap((s) => s.stops.map((stop) => ({ lngLat: [stop.lng, stop.lat] as LngLat, name: stop.name, color: s.line?.colour ?? '' }))),
  )
}
