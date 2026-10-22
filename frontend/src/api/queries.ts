// TanStack Query hooks for both APIs. The query cache is persisted, so the active plan still renders offline.
import { QueryClient, useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useQueued } from '@/lib/offlineQueue'
import { useStore } from '@/lib/store'
import { buildDay } from '@/lib/timeline'
import { api, ApiError } from './client'
import type { Booking, Contribution, ContributionsPage, Job, Place, RaastaLegOptions, RaastaRoute, SharedTrip, StandsPage, Summary, Trip, TripsPage, User } from './types'
import { useSessionStatus } from '@/lib/session'

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
  roadPath: (from: string, to: string, profile: string) => ['road', from, to, profile] as const,
  bookings: (tripId: string) => ['bookings', tripId] as const,
}

/** Which queries survive a reload (the rest are cheap to refetch). */
export function persistable(key: readonly unknown[]) {
  return ['me', 'trips', 'trip', 'summary', 'raasta', 'road', 'bookings'].includes(String(key[0]))
}

export function useMe(enabled = true) {
  return useQuery({ queryKey: keys.me, queryFn: () => api.get<User>('/v1/me'), enabled })
}

/** Simulated bookings are a demo: the server says whether they're on, and only then does the app offer them. */
export function useBookingsEnabled() {
  return useMe().data?.features?.bookings === true
}

export function useTrips(enabled = true) {
  return useQuery({ queryKey: keys.trips, queryFn: () => api.get<TripsPage>('/v1/trips', { query: { limit: 20 } }), enabled })
}

/** The trip the app shows: the one the traveller chose, else the most recent one. */
export function useCurrentTripId(): { tripId: string | null; isPending: boolean; isError: boolean; error: unknown; refetch: () => void } {
  // Nothing is fetched until the session is known: an unauthenticated request would only bounce.
  const q = useTrips(useSessionStatus() === 'signedIn')
  const chosen = useStore((s) => s.tripId)
  const items = q.data?.items ?? []
  const tripId = (chosen && items.some((t) => t.tripId === chosen) ? chosen : items[0]?.tripId) ?? null
  return { tripId, isPending: q.isPending, isError: q.isError, error: q.error, refetch: () => void q.refetch() }
}

/** The trip's simulated tickets and rides (kept on the phone, so a ticket shows offline). */
export function useBookings(tripId: string | null | undefined) {
  const signedIn = useSessionStatus() === 'signedIn'
  return useQuery({ queryKey: keys.bookings(tripId ?? 'none'), queryFn: () => api.get<Booking[]>(`/v1/trips/${tripId}/bookings`), enabled: !!tripId && signedIn })
}

export function useTrip(tripId: string | null) {
  const signedIn = useSessionStatus() === 'signedIn'
  return useQuery({
    queryKey: keys.trip(tripId ?? 'none'),
    queryFn: () => api.get<Trip>(`/v1/trips/${tripId}`),
    enabled: !!tripId && signedIn,
    // The saved copy renders at once (and offline); on every load, confirm it with the server.
    refetchOnMount: 'always',
    // Live events invalidate this; the interval is a safety net for missed events.
    refetchInterval: 60_000,
  })
}

/**
 * The day view for a trip, with check-ins the server hasn't confirmed yet applied: the ones in flight
 * (or inside their Undo window) and the ones queued offline, which survive a reload. `clock` is the
 * running trip clock, so where the traveller is and what runs late follow it between fetches.
 */
export function useDay(trip: Trip | undefined, clock?: number | null) {
  const inFlight = useStore((s) => s.optimisticDone)
  const waiting = useQueued(trip?.tripId)
  const key = [...inFlight, ...waiting.map((q) => `${q.kind}:${q.taskId}`)].join('|')
  return useMemo(() => {
    if (!trip) return null
    const now = clock ?? undefined
    const states = new Map<string, Trip['tasks'][number]['state']>()
    waiting.forEach((q) => q.kind !== 'delay' && states.set(q.taskId, q.kind === 'skipped' ? 'skipped' : 'done'))
    inFlight.forEach((id) => states.set(id, 'done'))
    if (!states.size) return buildDay(trip, now)
    const tasks = trip.tasks.map((t) => (states.has(t.taskId) && t.state !== 'done' && t.state !== 'skipped' ? { ...t, state: states.get(t.taskId)! } : t))
    return buildDay({ ...trip, tasks }, now)
    // `key` stands for the optimistic sets by value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trip, key, clock])
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

/** Place search in the trip's city. The server knows each city's name, and answers 422 for a city it doesn't cover. */
export function usePlaceSearch(q: string, city: string) {
  const query = q.trim()
  return useQuery({
    queryKey: keys.places(query.toLowerCase(), city),
    queryFn: () => api.get<Place[]>('/v1/places', { query: { q: query, city } }),
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
