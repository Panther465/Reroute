import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTripClock } from './hooks'

const NOW = 10 * 60 + 55 // 10:55, as the server sent it

describe('useTripClock', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-14T05:30:00Z'))
  })
  afterEach(() => vi.useRealTimers())

  it('counts from when the server sent the time, not from when the page loaded', () => {
    // Reopened from the saved copy two hours after it was fetched (for example, offline).
    const fetchedAt = Date.now() - 2 * 60 * 60_000
    const { result } = renderHook(() => useTripClock(NOW, fetchedAt, false))
    expect(result.current).toBe(NOW + 120)
  })

  it('keeps running while the screen is open', () => {
    const fetchedAt = Date.now()
    const { result } = renderHook(() => useTripClock(NOW, fetchedAt, false))
    expect(result.current).toBe(NOW)
    act(() => {
      vi.advanceTimersByTime(5 * 60_000)
    })
    expect(result.current).toBe(NOW + 5)
  })

  it('holds a simulated demo clock where it was set', () => {
    const fetchedAt = Date.now() - 2 * 60 * 60_000
    const { result } = renderHook(() => useTripClock(NOW, fetchedAt, true))
    act(() => {
      vi.advanceTimersByTime(5 * 60_000)
    })
    expect(result.current).toBe(NOW)
  })

  it('has no time before the trip loads', () => {
    const { result } = renderHook(() => useTripClock(null, 0, false))
    expect(result.current).toBeNull()
  })
})
