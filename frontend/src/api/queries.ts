// TanStack Query hooks for both APIs. The query cache is persisted, so the active plan still renders offline.
import { QueryClient, useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useStore } from '@/lib/store'
import { buildDay } from '@/lib/timeline'
import { api, ApiError } from './client'
import type { Contribution, ContributionsPage, Job, Place, RaastaLegOptions, RaastaRoute, SharedTrip, StandsPage, Summary, Trip, TripsPage, User } from './types'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Serve the cache first, so a reload with no signal still shows the plan.
      networkMode: 'offlineFirst',
      staleTime: 30_000,
      gcTime: 7 * 24 * 3600_000,
      refetchOnWindowFocus: true,
      retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && !(err instanceof ApiError && err.offline) && count < 2,
    },
    mutations: { networkMode: 'always' },
  },
})

export const keys = {
  me: ['me'] as const,
  trips: ['trips'] as const,
  trip: (id: string) => ['trip', id] as const,
  summary: (id: string, day?: string) => ['summary', id, day ?? ''] as const,
  shared: (token: string) => ['shared', token] as const,
  places: (q: string, city: string) => ['places', city, q] as const,
  job: (id: string) => ['job', id] as const,
  route: (id: string) => ['raasta', 'route', id] as const,
  legOptions: (from: string, to: string) => ['raasta', 'options', from, to] as const,
  stands: (near: string) => ['raasta', 'stands', near] as const,
  queue: (status: string) => ['raasta', 'queue', status] as const,
}

/** Which queries survive a reload (the rest are cheap to refetch). */
export function persistable(key: readonly unknown[]) {
  return ['me', 'trips', 'trip', 'summary', 'raasta'].includes(String(key[0]))
}

export function useMe(enabled = true) {
  return useQuery({ queryKey: keys.me, queryFn: () => api.get<User>('/v1/me'), enabled })
}

export function useTrips(enabled = true) {
  return useQuery({ queryKey: keys.trips, queryFn: () => api.get<TripsPage>('/v1/trips', { query: { limit: 20 } }), enabled })
}

/** The trip the app shows: the most recent one. */
export function useCurrentTripId(): { tripId: string | null; isPending: boolean; isError: boolean; error: unknown; refetch: () => void } {
  const q = useTrips()
  return { tripId: q.data?.items[0]?.tripId ?? null, isPending: q.isPending, isError: q.isError, error: q.error, refetch: () => void q.refetch() }
}

export function useTrip(tripId: string | null) {
  return useQuery({
    queryKey: keys.trip(tripId ?? 'none'),
    queryFn: () => api.get<Trip>(`/v1/trips/${tripId}`),
    enabled: !!tripId,
    // Live events invalidate this; the interval is a safety net for missed events.
    refetchInterval: 60_000,
  })
}

/** The day view for a trip, with optimistic check-ins applied. */
export function useDay(trip: Trip | undefined) {
  const optimistic = useStore((s) => s.optimisticDone)
  return useMemo(() => {
    if (!trip) return null
    if (!optimistic.length) return buildDay(trip)
    const tasks = trip.tasks.map((t) => (optimistic.includes(t.taskId) && t.state !== 'done' ? { ...t, state: 'done' as const } : t))
    return buildDay({ ...trip, tasks })
  }, [trip, optimistic])
}

export function useSummary(tripId: string | null) {
  return useQuery({ queryKey: keys.summary(tripId ?? 'none'), queryFn: () => api.get<Summary>(`/v1/trips/${tripId}/summary`), enabled: !!tripId })
}

export function useShared(token: string) {
  return useQuery({
    queryKey: keys.shared(token),
    queryFn: () => api.get<SharedTrip>(`/v1/shared/${encodeURIComponent(token)}`),
    staleTime: 0,
    refetchInterval: 30_000,
    retry: false,
  })
}

export function usePlaceSearch(q: string, city: string, cityName: string) {
  const query = q.trim()
  return useQuery({
    queryKey: keys.places(query.toLowerCase(), city),
    queryFn: () => api.get<Place[]>('/v1/places', { query: { q: query, city, cityName } }),
    enabled: query.length >= 2,
    staleTime: 5 * 60_000,
  })
}

export function useJob(jobId: string | null) {
  return useQuery({
    queryKey: keys.job(jobId ?? 'none'),
    queryFn: () => api.get<Job>(`/v1/jobs/${jobId}`),
    enabled: !!jobId,
    refetchInterval: (q) => (q.state.data && (q.state.data.status === 'finished' || q.state.data.status === 'failed') ? false : 500),
  })
}

/** Poll a planning job until it finishes. */
export async function waitForJob(jobId: string, timeoutMs = 20_000): Promise<Job> {
  const started = Date.now()
  for (;;) {
    const job = await api.get<Job>(`/v1/jobs/${jobId}`)
    if (job.status === 'finished' || job.status === 'failed') return job
    if (Date.now() - started > timeoutMs) throw new ApiError(504, 'TIMEOUT', 'Planning is taking longer than usual. Your timeline updates when it finishes.')
    await new Promise((r) => setTimeout(r, 500))
  }
}

// ---------- Raasta ----------

export function useRaastaRoute(routeId: string | null | undefined) {
  return useQuery({ queryKey: keys.route(routeId ?? 'none'), queryFn: () => api.get<RaastaRoute>(`/v1/raasta/routes/${routeId}`), enabled: !!routeId, staleTime: 5 * 60_000 })
}

export function useLegOptions(from: string | null, to: string | null) {
  return useQuery({
    queryKey: keys.legOptions(from ?? '', to ?? ''),
    queryFn: () => api.get<RaastaLegOptions>('/v1/raasta/routes', { query: { from, to } }),
    enabled: !!from && !!to,
  })
}

export function useStands(near: string | null, radius = 1500) {
  return useQuery({
    queryKey: keys.stands(`${near}:${radius}`),
    queryFn: () => api.get<StandsPage>('/v1/raasta/stands', { query: { near, radius, limit: 12 } }),
    enabled: !!near,
    staleTime: 5 * 60_000,
  })
}

export function useQueue(status: string, enabled = true) {
  return useQuery({ queryKey: keys.queue(status), queryFn: () => api.get<ContributionsPage>('/v1/raasta/contributions', { query: { status, limit: 50 } }), enabled })
}

export type { Contribution }
