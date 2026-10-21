import { ApiError } from '@/api/client'

export function placeSearchError(err: unknown) {
  if (err instanceof ApiError && err.status === 422) return err.message
  return "Place search needs a connection. Try again when you're online."
}
