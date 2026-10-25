import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError, isReachable, setAccessToken } from '@/api/client'
import { keys, queryClient } from '@/api/queries'
import { goldenTrip } from '@/test/fixtures'
import { CHECKIN_UNDO_MS, checkIn, editTask, restorePlan, skipTask, undo } from './actions'
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
  vi.unstubAllGlobals()
  vi.useRealTimers()
  setAccessToken(null)
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

  it.each([
    ['a server error', new ApiError(503, 'HTTP_503', 'Something went wrong. Try again.')],
    ['a rate limit', new ApiError(429, 'RATE_LIMITED', 'Too many requests. Wait a minute and try again.')],
    ['its first try still being processed', new ApiError(409, 'IN_PROGRESS', 'The same request is already being processed.')],
  ])('answered with %s, it waits in the queue with its key instead of being thrown away', async (_why, err) => {
    const trip = goldenTrip('10:55')
    const post = vi.spyOn(api, 'post').mockRejectedValue(err)
    checkIn(trip.tripId, buildDay(trip)!, 655)
    settleToast(lastToast().id, 'close')
    await vi.advanceTimersByTimeAsync(0)
    expect(queued().map((q) => [q.taskId, q.idempotencyKey])).toEqual([['task-meet', post.mock.calls[0][2]?.idempotencyKey]])
    expect(lastToast().title).toBe('Marked done. It syncs as soon as Reroute answers.')
  })

  it('a refusal the server kept is not queued: it would never go through', async () => {
    const trip = goldenTrip('10:55')
    vi.spyOn(api, 'post').mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'Task not found.'))
    checkIn(trip.tripId, buildDay(trip)!, 655)
    settleToast(lastToast().id, 'close')
    await vi.advanceTimersByTimeAsync(0)
    expect(queued()).toEqual([])
    expect(lastToast().title).toBe('Task not found.')
    expect(getState().optimisticDone).toEqual([])
  })

  it('timed out while the phone stays online, it goes out after the next request the server answers', async () => {
    const trip = goldenTrip('10:55')
    setAccessToken('tok')
    const keys: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL, init: RequestInit = {}) => {
        if (init.method !== 'POST') return new Response(JSON.stringify(trip), { status: 200, headers: { 'Content-Type': 'application/json' } })
        keys.push(JSON.parse(String(init.body)).idempotencyKey)
        // The first try gets no answer in time (20 s): nothing says the connection is gone.
        if (keys.length === 1) throw new DOMException('The operation timed out.', 'TimeoutError')
        return new Response(JSON.stringify({ result: 'on_time' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }),
    )
    checkIn(trip.tripId, buildDay(trip)!, 655)
    settleToast(lastToast().id, 'close')
    await vi.advanceTimersByTimeAsync(0)
    expect(queued()).toHaveLength(1)
    expect(isReachable()).toBe(true)
    // The trip's own refresh, a minute later, gets an answer: the check-in goes with it.
    await api.get(`/v1/trips/${trip.tripId}`)
    await vi.waitFor(() => expect(queued()).toEqual([]))
    expect(keys).toHaveLength(2)
    expect(keys[1]).toBe(keys[0])
    expect(lastToast().title).toBe('Your check-in is synced.')
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

describe('a change the server saved', () => {
  const offline = new ApiError(0, 'OFFLINE', "You're offline. Try again when you have signal.")

  it('stands when the day can’t be loaded after it: saved, not failed', async () => {
    const trip = goldenTrip('10:55')
    vi.spyOn(api, 'post').mockResolvedValue({ result: 'shifted' })
    vi.spyOn(api, 'get').mockRejectedValue(offline)
    await expect(skipTask(trip.tripId, 'task-bank', buildDay(trip))).resolves.toBe('saved')
    vi.spyOn(api, 'patch').mockResolvedValue({ jobId: 'job-1' })
    await expect(editTask(trip.tripId, 'task-bank', { durationMin: 90 }, buildDay(trip))).resolves.toBe('saved')
  })

  it('a re-plan the server says failed still fails, in its own words', async () => {
    const trip = goldenTrip('10:55')
    vi.spyOn(api, 'patch').mockResolvedValue({ jobId: 'job-1' })
    vi.spyOn(api, 'get').mockResolvedValue({ jobId: 'job-1', status: 'failed', error: 'Your tasks don’t fit in one day.' })
    await expect(editTask(trip.tripId, 'task-bank', { durationMin: 600 }, buildDay(trip))).rejects.toMatchObject({ code: 'REPLAN_FAILED' })
  })
})

describe('undo', () => {
  const trip = goldenTrip('10:55')
  beforeEach(() => queryClient.setQueryData(keys.trip(trip.tripId), trip))

  it('says when the server didn’t bring the earlier plan back', async () => {
    vi.spyOn(api, 'post').mockRejectedValue(new ApiError(409, 'CONFLICT', 'That plan can’t come back any more.'))
    expect(await undo(trip.tripId, 1)).toBe(false)
    expect(lastToast().title).toBe('That plan can’t come back any more.')
    await expect(restorePlan(trip.tripId, 1)).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('is undone once the server has it back, even if the day can’t be loaded after it', async () => {
    vi.spyOn(api, 'post').mockResolvedValue({})
    vi.spyOn(api, 'get').mockRejectedValue(new ApiError(0, 'OFFLINE', "You're offline. Try again when you have signal."))
    expect(await undo(trip.tripId, 1)).toBe(true)
    expect(lastToast().title).toBe('Change undone. Your timeline updates when your plan loads again.')
  })
})
