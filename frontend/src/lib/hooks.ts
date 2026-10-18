import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Trip } from '@/api/types'
import { hhmm } from './format'
import { useStore } from './store'
import { lastReroute, type DayView } from './timeline'

export function useMediaQuery(q: string) {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(q)
      m.addEventListener('change', cb)
      return () => m.removeEventListener('change', cb)
    },
    () => window.matchMedia(q).matches,
  )
}

export const useIsDesktop = () => useMediaQuery('(min-width: 1024px)')

export function useOnline() {
  const browser = useSyncExternalStore(
    (cb) => {
      window.addEventListener('online', cb)
      window.addEventListener('offline', cb)
      return () => {
        window.removeEventListener('online', cb)
        window.removeEventListener('offline', cb)
      }
    },
    () => navigator.onLine,
  )
  const forced = useStore((s) => s.demo.offline)
  return browser && !forced
}

/**
 * The trip clock in minutes, ticking every 30 s from the server's `now` between fetches.
 * The server's clock may be simulated (demo), so the app never reads the device time directly.
 */
export function useTripClock(serverNow: number | null): number | null {
  const [offset, setOffset] = useState(0)
  const base = useRef({ now: serverNow, at: Date.now() })
  useEffect(() => {
    base.current = { now: serverNow, at: Date.now() }
    setOffset(0)
    if (serverNow === null) return
    const id = setInterval(() => setOffset(Math.floor((Date.now() - base.current.at) / 60_000)), 30_000)
    return () => clearInterval(id)
  }, [serverNow])
  return serverNow === null ? null : serverNow + offset
}

export type StatusKind = 'on_time' | 'behind' | 'rerouted' | 'offline' | 'blocked'
export interface Status {
  kind: StatusKind
  text: string
}

export function useStatus(trip: Trip | undefined, view: DayView | null, clock: number | null): Status {
  const online = useOnline()
  const pending = useStore((s) => s.pendingDelay)
  if (!online) return { kind: 'offline', text: 'Offline' }
  if (trip?.openOptions) return { kind: 'blocked', text: 'Choose a new plan' }
  if (pending) return { kind: 'behind', text: `Behind by ${pending} min` }
  const leave = view?.nextLeg ? view.nextLeg.leaveMin : null
  const behind = clock !== null && leave !== null && view?.stops[view.nowIndex]?.kind === 'task' ? clock - leave : 0
  if (behind > 5) return { kind: 'behind', text: `Behind by ${behind} min` }
  const at = trip ? lastReroute(trip.log, trip.day, trip.utcOffset) : null
  if (at !== null) return { kind: 'rerouted', text: `Rerouted at ${hhmm(at)}` }
  return { kind: 'on_time', text: 'On time' }
}

/** Value that follows `value` after `delayMs` (used for the pill at 1000 ms). `key` identifies a change. */
export function useDelayed<T>(value: T, delayMs: number, key: string): T {
  const [shown, setShown] = useState<{ key: string; value: T }>({ key, value })
  const latest = useRef(value)
  latest.current = value
  useEffect(() => {
    if (delayMs <= 0) {
      setShown({ key, value: latest.current })
      return
    }
    const t = setTimeout(() => setShown({ key, value: latest.current }), delayMs)
    return () => clearTimeout(t)
    // Only a new key starts a new delay.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return delayMs <= 0 ? value : shown.value
}
