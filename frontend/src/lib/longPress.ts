/**
 * Press and hold: `onPress` runs once a finger has stayed down for `ms` without moving more than `slop` pixels.
 * Lifting it, moving it, or calling `cancel` (a second finger, the map starting to pan) stops it. Kept apart
 * from the map so the timing can be tested without one.
 */
export function longPress<T>(onPress: (at: T) => void, ms = 550, slop = 10) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let from: { x: number; y: number } | null = null
  const cancel = () => {
    clearTimeout(timer)
    timer = undefined
    from = null
  }
  return {
    start(x: number, y: number, at: T) {
      cancel()
      from = { x, y }
      timer = setTimeout(() => {
        cancel()
        onPress(at)
      }, ms)
    },
    move(x: number, y: number) {
      if (from && Math.hypot(x - from.x, y - from.y) > slop) cancel()
    },
    cancel,
  }
}
