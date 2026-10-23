// "Open in Google Maps": the same leg with Google's own directions and navigation. Google's link takes
// latitude first, then longitude.
import type { LngLat } from './geo'
import type { Mode } from './types'

export type TravelMode = 'walking' | 'transit' | 'driving' | 'two-wheeler'

/** How Google should route a leg: the metro as transit, on foot as walking, any road ride as driving. */
export function travelMode(modes: Mode[]): TravelMode {
  if (modes.includes('metro')) return 'transit'
  if (modes.length > 0 && modes.every((m) => m === 'walk')) return 'walking'
  return 'driving'
}

export function googleMapsUrl(from: LngLat, to: LngLat, mode: TravelMode, navigating = false): string {
  const params = new URLSearchParams({ api: '1', origin: `${from[1]},${from[0]}`, destination: `${to[1]},${to[0]}`, travelmode: mode })
  // Already on the way: straight into Google's navigation, on a phone with the app.
  if (navigating) params.set('dir_action', 'navigate')
  return `https://www.google.com/maps/dir/?${params.toString()}`
}
