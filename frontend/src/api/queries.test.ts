import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { enqueue, resetQueue } from '@/lib/offlineQueue'
import { resetSession } from '@/lib/session'
import { setState } from '@/lib/store'
import { goldenTrip } from '@/test/fixtures'
import { useDay, whileSignedIn } from './queries'

beforeEach(() => {
  resetQueue()
  setState({ optimisticDone: [] })
})

describe('useDay with check-ins the server has not confirmed', () => {
  it('shows check-ins queued offline as done, so they survive a reload', () => {
    // As after a reload: the queue was saved; nothing is in flight.
    enqueue({ tripId: 'trip-001', taskId: 'task-meet', kind: 'done', idempotencyKey: 'k1', queuedAt: 1 })
    const trip = goldenTrip('11:02')
    const { result } = renderHook(() => useDay(trip))
    expect(result.current!.stops[1].task?.state).toBe('done')
    expect(result.current!.checkInTask?.taskId).toBe('task-bank')
  })

  it('ignores queued check-ins for other trips', () => {
    enqueue({ tripId: 'trip-999', taskId: 'task-meet', kind: 'done', idempotencyKey: 'k2', queuedAt: 1 })
    const { result } = renderHook(() => useDay(goldenTrip('11:02')))
    expect(result.current!.stops[1].task?.state).toBe('planned')
  })

  it('adds check-ins in flight, and follows the queue as it changes', () => {
    const trip = goldenTrip('11:02')
    const { result } = renderHook(() => useDay(trip))
    expect(result.current!.checkInTask?.taskId).toBe('task-meet')
    act(() => setState({ optimisticDone: ['task-meet'] }))
    expect(result.current!.stops[1].task?.state).toBe('done')
    act(() => {
      setState({ optimisticDone: [] })
      enqueue({ tripId: 'trip-001', taskId: 'task-meet', kind: 'done', idempotencyKey: 'k3', queuedAt: 1 })
    })
    expect(result.current!.stops[1].task?.state).toBe('done')
    act(() => resetQueue())
    expect(result.current!.stops[1].task?.state).toBe('planned')
  })

  it('follows the running trip clock rather than the time the trip was fetched', () => {
    // Fetched at 10:55 (meeting under way); the clock has since run to 11:10, past the bank leg's leave-by.
    const trip = goldenTrip('10:55')
    trip.tasks[0].state = 'done'
    const { result, rerender } = renderHook(({ clock }) => useDay(trip, clock), { initialProps: { clock: 655 } })
    expect(result.current!.stops.map((s) => s.status)).toEqual(['done', 'now', 'upcoming', 'upcoming', 'upcoming'])
    rerender({ clock: 670 })
    expect(result.current!.stops.map((s) => s.status)).toEqual(['done', 'done', 'now', 'upcoming', 'upcoming'])
  })
})

describe('queries that need the session', () => {
  /** A screen's query as it rendered while signed in, then signing out (the cache emptied) before its effect ran. */
  async function signOutUnder(enabled: boolean | (() => boolean)) {
    resetSession('signedIn')
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const queryFn = vi.fn(async () => ({ name: 'Asha' }))
    const options = { queryKey: ['me'], queryFn, enabled }
    const observer = new QueryObserver(client, options)
    const stop = observer.subscribe(() => {})
    await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1))
    resetSession('signedOut')
    client.clear()
    // The effect of the render from before signing out.
    observer.setOptions(options)
    await new Promise((r) => setTimeout(r, 0))
    stop()
    return queryFn.mock.calls.length
  }

  it('fetch nothing after signing out, even from a screen rendered just before', async () => {
    expect(await signOutUnder(whileSignedIn(true))).toBe(1)
    // What happened before: the same render fetched its data again, without a session (a 401 in the console).
    expect(await signOutUnder(true)).toBe(2)
    resetSession()
  })

  it('stay off while the screen is signed out', () => {
    expect(whileSignedIn(false)).toBe(false)
  })
})
