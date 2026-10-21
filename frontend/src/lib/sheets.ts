// How many sheets are open: while any is, its buttons and Escape belong to it, so Roo stays quiet.
import { useSyncExternalStore } from 'react'

let open = 0
const listeners = new Set<() => void>()

export function sheetOpened(delta: 1 | -1) {
  open = Math.max(0, open + delta)
  listeners.forEach((l) => l())
}

export function useSheetOpen() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => open > 0,
  )
}
