// Live location while the app is open: one GPS watch shared by the map, the Next card and alerts.
// The position stays on this phone; Reroute never sends it anywhere. Browsers stop the watch when the
// phone locks or the tab is closed.
import { useSyncExternalStore } from 'react'
import type { LngLat } from './geo'
import { metres } from './progress'

export interface Fix {
  lng: number
  lat: number
  /** Metres. */
  accuracy: number
  heading: number | null
  /** Metres a second. */
  speed: number | null
  at: number
}

interface LocationState {
  tracking: boolean
  /** A demo ride from the Simulate panel, not the phone's GPS. */
  simulated: boolean
  fix: Fix | null
  error: 'denied' | 'unavailable' | null
}

const KEY = 'reroute:tracking'
let state: LocationState = { tracking: false, simulated: false, fix: null, error: null }
let watchId: number | null = null
let ride: ReturnType<typeof setInterval> | null = null
const listeners = new Set<() => void>()

function set(patch: Partial<LocationState>) {
  // Many phones report no heading (and the demo ride has none): work it out from the last move.
  const prev = state.fix
  const fix = patch.fix
  if (fix && (fix.heading == null || Number.isNaN(fix.heading)) && prev) {
    patch = { ...patch, fix: { ...fix, heading: metres([prev.lng, prev.lat], [fix.lng, fix.lat]) > 3 ? bearing([prev.lng, prev.lat], [fix.lng, fix.lat]) : prev.heading } }
  }
  state = { ...state, ...patch }
  listeners.forEach((l) => l())
}

/** Compass bearing from a to b, in degrees. */
function bearing(a: LngLat, b: LngLat) {
  const toRad = Math.PI / 180
  const y = Math.sin((b[0] - a[0]) * toRad) * Math.cos(b[1] * toRad)
  const x = Math.cos(a[1] * toRad) * Math.sin(b[1] * toRad) - Math.sin(a[1] * toRad) * Math.cos(b[1] * toRad) * Math.cos((b[0] - a[0]) * toRad)
  return (Math.atan2(y, x) / toRad + 360) % 360
}

export const geolocationSupported = typeof navigator !== 'undefined' && 'geolocation' in navigator

/** Start following the traveller. Resolves false when location is off or refused. */
export function startTracking(): Promise<boolean> {
  if (!geolocationSupported) {
    set({ error: 'unavailable' })
    return Promise.resolve(false)
  }
  if (watchId !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    let settled = false
    watchId = navigator.geolocation.watchPosition(
      (p) => {
        set({
          tracking: true,
          simulated: false,
          error: null,
          fix: { lng: p.coords.longitude, lat: p.coords.latitude, accuracy: p.coords.accuracy, heading: p.coords.heading, speed: p.coords.speed, at: p.timestamp },
        })
        try {
          localStorage.setItem(KEY, '1')
        } catch {
          /* private mode */
        }
        if (!settled) resolve((settled = true))
      },
      (err) => {
        const denied = err.code === err.PERMISSION_DENIED
        if (denied) stopTracking()
        set({ error: denied ? 'denied' : 'unavailable' })
        if (!settled) {
          settled = true
          resolve(false)
        }
      },
      { enableHighAccuracy: true, maximumAge: 5_000, timeout: 20_000 },
    )
  })
}

/** Demo only: move the dot along `path` over `seconds`, as if riding it, ending at its last point. */
export function simulateRide(path: LngLat[], seconds = 40) {
  stopTracking()
  if (path.length < 2) return
  const legs = path.slice(1).map((p, i) => metres(path[i], p))
  const total = legs.reduce((a, b) => a + b, 0)
  const steps = seconds * 2
  let step = 0
  const at = (fraction: number): LngLat => {
    let left = fraction * total
    for (let i = 0; i < legs.length; i++) {
      if (left <= legs[i] || i === legs.length - 1) {
        const t = legs[i] ? Math.min(1, left / legs[i]) : 1
        return [path[i][0] + (path[i + 1][0] - path[i][0]) * t, path[i][1] + (path[i + 1][1] - path[i][1]) * t]
      }
      left -= legs[i]
    }
    return path[path.length - 1]
  }
  const move = () => {
    const [lng, lat] = at(step / steps)
    set({ tracking: true, simulated: true, error: null, fix: { lng, lat, accuracy: 12, heading: null, speed: null, at: Date.now() } })
    if (++step > steps && ride) {
      clearInterval(ride)
      ride = null
    }
  }
  move()
  ride = setInterval(move, 500)
}

export function stopTracking() {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId)
  watchId = null
  if (ride) clearInterval(ride)
  ride = null
  set({ tracking: false, simulated: false, fix: null })
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* private mode */
  }
}

/** After a reload, carry on following if the traveller had it on and the browser still allows it, without asking again. */
export async function resumeTracking() {
  try {
    if (localStorage.getItem(KEY) !== '1' || !geolocationSupported) return
    const perm = await navigator.permissions?.query({ name: 'geolocation' as PermissionName })
    if (perm?.state === 'granted') void startTracking()
  } catch {
    /* no Permissions API: wait for the traveller to turn it on */
  }
}

export function useLocation(): LocationState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => state,
  )
}

export function getLocation() {
  return state
}
