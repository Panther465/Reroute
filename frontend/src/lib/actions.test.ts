import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError } from '@/api/client'
import { goldenTrip } from '@/test/fixtures'
import { CHECKIN_UNDO_MS, checkIn } from './actions'
import { queued, resetQueue } from './offlineQueue'
import { getState, getToasts, setState, settleToast } from './store'
import { buildDay } from './timeline'

beforeEach(() => {
  vi.useFakeTimers()
  resetQueue()
  setState({ optimisticDone: [], autoBanner: null })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const lastToast = () => getToasts().at(-1)!

describe('check in with Undo', () => {
  it('fills the station at once but sends nothing until the Undo toast closes', async () => {
    const trip = goldenTrip('10:55')
    const post = vi.spyOn(api, 'post').mockResolvedValue({ result: 'on_time' })
    vi.spyOn(api, 'get').mockResolvedValue({ ...trip, tasks: trip.tasks.map((t) => (t.taskId === 'task-meet' ? { ...t, state: 'done' } : t)) })

    checkIn(trip.tripId, buildDay(trip)!, 655)
    expect(getState().optimisticDone).toEqual(['task-meet'])
    expect(lastToast().title).toBe('Meeting done at 10:55.')
    expect(lastToast().onUndo).toBeTypeOf('function')
    expect(post).not.toHaveBeenCalled()

    // Still open (hovered or focused, so its timer waits): Undo stays available.
    await vi.advanceTimersByTimeAsync(CHECKIN_UNDO_MS)
    expect(post).not.toHaveBeenCalled()
    // The toast's timer runs out and it closes: now it goes.
    settleToast(lastToast().id, 'close')
    await vi.advanceTimersByTimeAsync(0)
    expect(post).toHaveBeenCalledTimes(1)
    expect(post.mock.calls[0][0]).toBe('/v1/trips/trip-001/checkins')
    expect(post.mock.calls[0][1]).toMatchObject({ taskId: 'task-meet', kind: 'done' })
    expect(getState().optimisticDone).toEqual([])
  })

  it('Undo cancels it: nothing is sent and the station empties again', async () => {
    const trip = goldenTrip('10:55')
    const post = vi.spyOn(api, 'post').mockResolvedValue({ result: 'on_time' })
    checkIn(trip.tripId, buildDay(trip)!, 655)
    settleToast(lastToast().id, 'undo')
    expect(getState().optimisticDone).toEqual([])
    await vi.advanceTimersByTimeAsync(CHECKIN_UNDO_MS * 2)
    expect(post).not.toHaveBeenCalled()
  })

  it('closing the toast sends it straight away, once', async () => {
    const trip = goldenTrip('10:55')
    const post = vi.spyOn(api, 'post').mockResolvedValue({ result: 'on_time' })
    vi.spyOn(api, 'get').mockResolvedValue(trip)
    checkIn(trip.tripId, buildDay(trip)!, 655)
    settleToast(lastToast().id, 'close')
    await vi.advanceTimersByTimeAsync(0)
    expect(post).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(CHECKIN_UNDO_MS)
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('goes out anyway if the toast never closes', async () => {
    const trip = goldenTrip('10:55')
    const post = vi.spyOn(api, 'post').mockResolvedValue({ result: 'on_time' })
    vi.spyOn(api, 'get').mockResolvedValue(trip)
    checkIn(trip.tripId, buildDay(trip)!, 655)
    await vi.advanceTimersByTimeAsync(CHECKIN_UNDO_MS * 6)
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('offline, it waits in the queue with its key, which keeps the station filled', async () => {
    const trip = goldenTrip('10:55')
    vi.spyOn(api, 'post').mockRejectedValue(new ApiError(0, 'OFFLINE', "You're offline. Try again when you have signal."))
    checkIn(trip.tripId, buildDay(trip)!, 655)
    settleToast(lastToast().id, 'close')
    await vi.advanceTimersByTimeAsync(0)
    expect(queued().map((q) => [q.taskId, q.kind])).toEqual([['task-meet', 'done']])
    expect(getState().optimisticDone).toEqual([])
  })
})
