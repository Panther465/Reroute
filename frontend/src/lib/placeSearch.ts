import { ApiError } from '@/api/client'

export function placeSearchError(err: unknown) {
  // 422: a city Reroute doesn't cover; 503: OpenStreetMap's search was busy, even after asking again.
  if (err instanceof ApiError && (err.status === 422 || err.status === 503)) return err.message
  return "Place search needs a connection. Try again when you're online."
}
