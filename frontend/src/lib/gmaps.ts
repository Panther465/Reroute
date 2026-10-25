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

/** Directions to a place from wherever the phone is: to its point, or to its name in the city when there's none. */
export function directionsTo(name: string, city: string | undefined, at: { lat: number; lng: number } | null): string {
  const params = new URLSearchParams({ api: '1', destination: at ? `${at.lat},${at.lng}` : [name, city].filter(Boolean).join(', ') })
  return `https://www.google.com/maps/dir/?${params.toString()}`
}

export function googleMapsUrl(from: LngLat, to: LngLat, mode: TravelMode, navigating = false): string {
  const params = new URLSearchParams({ api: '1', origin: `${from[1]},${from[0]}`, destination: `${to[1]},${to[0]}`, travelmode: mode })
  // Already on the way: straight into Google's navigation, on a phone with the app.
  if (navigating) params.set('dir_action', 'navigate')
  return `https://www.google.com/maps/dir/?${params.toString()}`
}
