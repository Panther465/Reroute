import { describe, expect, it } from 'vitest'
import { backoff, parseSse } from './live'

describe('parseSse', () => {
  it('reads named events with JSON data and keeps an incomplete tail', () => {
    const text = 'event: ready\ndata: {"tripId":"trip-001"}\n\n: ping\n\nevent: plan_updated\ndata: {"version":2,"trigger":"late"}\n\nevent: leave_now\ndata: {"seq"'
    const { events, rest } = parseSse(text)
    expect(events).toEqual([
      { event: 'ready', data: { tripId: 'trip-001' } },
      { event: 'plan_updated', data: { version: 2, trigger: 'late' } },
    ])
    expect(rest).toBe('event: leave_now\ndata: {"seq"')
  })

  it('handles CRLF line endings', () => {
    const { events } = parseSse('event: checkin_recorded\r\ndata: {"taskId":"task-meet"}\r\n\r\n')
    expect(events[0]).toEqual({ event: 'checkin_recorded', data: { taskId: 'task-meet' } })
  })
})

describe('backoff', () => {
  it('grows, stays under 30 s and is jittered', () => {
    expect(backoff(1, () => 0)).toBe(1000)
    expect(backoff(1, () => 1)).toBe(2000)
    expect(backoff(3, () => 0.5)).toBe(6000)
    expect(backoff(10, () => 1)).toBe(30_000)
    expect(backoff(10, () => 0)).toBe(15_000)
  })
})

describe('useLive', () => {
  it('reconnects when the stream goes silent (a connection that died without closing)', async () => {
    const { renderHook } = await import('@testing-library/react')
    const { vi } = await import('vitest')
    const { IDLE_MS, useLive } = await import('./live')
    vi.useFakeTimers()
    // A stream that opens and then never sends another byte, not even a ping.
    const silent = () => new Response(new ReadableStream({ start: () => {} }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    const fetchMock = vi.fn(async () => silent())
    vi.stubGlobal('fetch', fetchMock)
    const hook = renderHook(() => useLive('trip-001', true))
    await vi.advanceTimersByTimeAsync(10)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // Past the idle limit the watchdog cancels the read, and after the backoff the stream opens again.
    await vi.advanceTimersByTimeAsync(IDLE_MS + IDLE_MS / 3 + 2_500)
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2)
    hook.unmount()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })
})
