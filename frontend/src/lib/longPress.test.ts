import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { longPress } from './longPress'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('press and hold on the map', () => {
  it('adds a place where the finger stayed, once it has been held long enough', () => {
    const onPress = vi.fn()
    const hold = longPress<[number, number]>(onPress, 550, 10)
    hold.start(100, 200, [77.6, 12.93])
    vi.advanceTimersByTime(500)
    hold.move(104, 203) // a finger is never quite still
    expect(onPress).not.toHaveBeenCalled()
    vi.advanceTimersByTime(50)
    expect(onPress).toHaveBeenCalledExactlyOnceWith([77.6, 12.93])
    vi.advanceTimersByTime(2000)
    expect(onPress).toHaveBeenCalledOnce()
  })

  it('is a pan, not a press, once the finger moves away', () => {
    const onPress = vi.fn()
    const hold = longPress(onPress, 550, 10)
    hold.start(100, 200, 'here')
    hold.move(100, 215)
    vi.advanceTimersByTime(1000)
    expect(onPress).not.toHaveBeenCalled()
  })

  it('stops when the finger lifts, a second finger lands or the map moves, and starts over on the next press', () => {
    const onPress = vi.fn()
    const hold = longPress(onPress, 550)
    hold.start(0, 0, 'first')
    vi.advanceTimersByTime(300)
    hold.cancel()
    vi.advanceTimersByTime(1000)
    expect(onPress).not.toHaveBeenCalled()
    hold.start(0, 0, 'second')
    vi.advanceTimersByTime(300)
    hold.start(5, 5, 'third')
    vi.advanceTimersByTime(300)
    expect(onPress).not.toHaveBeenCalled()
    vi.advanceTimersByTime(250)
    expect(onPress).toHaveBeenCalledExactlyOnceWith('third')
  })
})
