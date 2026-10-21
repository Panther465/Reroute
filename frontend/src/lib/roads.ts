// Road paths for drawing legs: fetched once per leg (the server caches them for 30 days) and kept on
// the phone, so maps stay right offline. Until one arrives, or when routing is unavailable, the leg
// is drawn as a gentle curve between its two ends.
import { useQueries } from '@tanstack/react-query'
import { useMemo } from 'react'
import { api } from '@/api/client'
import { keys } from '@/api/queries'
import type { RoadPath } from '@/api/types'
import type { LngLat, PlaceIndex } from './geo'
import type { LegView } from './timeline'

type LegEnds = Pick<LegView, 'seq' | 'fromPlaceId' | 'toPlaceId' | 'segments'>

export function roadProfile(leg: Pick<LegView, 'segments'>): 'foot' | 'driving' {
  return leg.segments.length > 0 && leg.segments.every((s) => s.mode === 'walk') ? 'foot' : 'driving'
}

const ll = (p: LngLat) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`

/** Road paths by leg number; a leg is missing until its path has loaded (or when there's no road path). */
export function useRoadPaths(legs: LegEnds[], places: PlaceIndex): Map<number, LngLat[]> {
  const wanted = legs.flatMap((leg) => {
    const a = places.get(leg.fromPlaceId)
    const b = places.get(leg.toPlaceId)
    return a && b ? [{ seq: leg.seq, from: ll(a), to: ll(b), profile: roadProfile(leg) }] : []
  })
  const results = useQueries({
    queries: wanted.map((w) => ({
      queryKey: keys.roadPath(w.from, w.to, w.profile),
      queryFn: () => api.get<RoadPath>('/v1/road-path', { query: { from: w.from, to: w.to, profile: w.profile } }),
      staleTime: Infinity,
      gcTime: 30 * 24 * 3600_000,
      retry: 1,
    })),
  })
  const key = results.map((r) => (r.data ? `${r.data.source}${r.data.coords.length}` : '-')).join('|') + wanted.map((w) => w.seq).join(',')
  return useMemo(() => {
    const out = new Map<number, LngLat[]>()
    results.forEach((r, i) => {
      if (r.data?.source === 'road' && r.data.coords.length > 1) out.set(wanted[i].seq, r.data.coords as LngLat[])
    })
    return out
    // `key` stands for the results by value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
}
