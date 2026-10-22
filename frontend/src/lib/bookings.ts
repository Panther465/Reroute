// Simulated bookings (a class-project demo): train tickets for train tasks, flights, cabs for legs.
// Nothing real is booked; the wallet's simulated money pays, and every screen says so.
import { api, newKey } from '@/api/client'
import { keys, queryClient } from '@/api/queries'
import type { Body, Booking, BookingIn, Task } from '@/api/types'

export const DEMO_NOTE = 'Demo booking: nothing real is booked. Your wallet’s simulated money pays.'

/** A task that is catching a train: by its name, or a station as its place. */
export function isTrainTask(task: Pick<Task, 'title' | 'place'>) {
  return /\b(train|railway|rail|express|station)\b/i.test(task.title) || /station/i.test(task.place.name)
}

/** A task that is catching a flight: by its name, or an airport as its place. */
export function isFlightTask(task: Pick<Task, 'title' | 'place'>) {
  return /\b(flight|fly|flying|airport|plane)\b/i.test(task.title) || /airport/i.test(task.place.name)
}

export function activeBooking(bookings: Booking[] | undefined, match: { taskId?: string; toId?: string }) {
  return bookings?.find((b) => b.status === 'confirmed' && (match.taskId ? b.taskId === match.taskId : b.toId === match.toId)) ?? null
}

export async function book(tripId: string, body: Body<BookingIn>, idempotencyKey = newKey('bkg')) {
  const booking = await api.post<Booking>(`/v1/trips/${tripId}/bookings`, body, { idempotencyKey })
  await Promise.all([queryClient.invalidateQueries({ queryKey: keys.bookings(tripId) }), queryClient.invalidateQueries({ queryKey: keys.wallet })])
  return booking
}

export async function cancelBooking(tripId: string, bookingId: string) {
  const booking = await api.post<Booking>(`/v1/trips/${tripId}/bookings/${bookingId}/cancel`, {}, { idempotencyKey: newKey('cnl') })
  await Promise.all([queryClient.invalidateQueries({ queryKey: keys.bookings(tripId) }), queryClient.invalidateQueries({ queryKey: keys.wallet })])
  return booking
}

/** A pause for the "processing" step, so the flow reads like a real booking (shorter with reduced motion). */
export const pause = (ms: number) => new Promise((r) => setTimeout(r, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? Math.min(ms, 300) : ms))
