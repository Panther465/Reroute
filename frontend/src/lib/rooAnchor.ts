// Where Roo rides on Today: the timeline's "Now" line registers a spot, and Roo renders into it, so it
// moves along the day with the traveller. With no spot (other screens, a finished day) Roo floats.
import { useSyncExternalStore } from 'react'

let anchor: HTMLElement | null = null
const listeners = new Set<() => void>()

export function setRooAnchor(el: HTMLElement | null) {
  if (el === anchor) return
  anchor = el
  listeners.forEach((l) => l())
}

export function useRooAnchor() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => anchor,
  )
}
