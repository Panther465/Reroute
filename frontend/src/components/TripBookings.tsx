import { Bike, CarTaxiFront, Plane, TrainFront } from 'lucide-react'
import { lazy, Suspense, useState } from 'react'
import { useBookings, useBookingsEnabled } from '@/api/queries'
import type { Booking, Trip } from '@/api/types'
import { AutoRickshaw } from '@/components/icons'
import { Button } from '@/components/ui/Button'
import { Tag } from '@/components/ui/Tag'
import { rupees } from '@/lib/format'

const FlightBookingSheet = lazy(() => import('@/screens/BookingSheets').then((m) => ({ default: m.FlightBookingSheet })))
const BookingSheet = lazy(() => import('@/screens/BookingSheets').then((m) => ({ default: m.BookingSheet })))

function title(b: Booking) {
  const d = b.details as Record<string, string | number>
  if (b.kind === 'flight') return `Flight ${d.flightNo}, ${d.originCity} to ${d.destinationCity}`
  if (b.kind === 'train') return `${d.trainName}`
  return `${d.providerLabel} ${String(d.vehicleLabel).toLowerCase()}, ${d.driverName}`
}

function KindIcon({ b }: { b: Booking }) {
  const d = b.details as Record<string, string>
  if (b.kind === 'flight') return <Plane size={20} strokeWidth={1.75} />
  if (b.kind === 'train') return <TrainFront size={20} strokeWidth={1.75} />
  if (d.vehicle === 'auto') return <AutoRickshaw size={20} />
  if (d.vehicle === 'bike') return <Bike size={20} strokeWidth={1.75} />
  return <CarTaxiFront size={20} strokeWidth={1.75} />
}

/** The trip's (simulated) tickets and rides, and a way to book a flight. Only where bookings are on. */
export function TripBookings({ trip, className = '' }: { trip: Trip; className?: string }) {
  const on = useBookingsEnabled()
  const bookings = useBookings(on ? trip.tripId : null)
  const [flight, setFlight] = useState(false)
  const [viewing, setViewing] = useState<Booking | null>(null)
  const [loaded, setLoaded] = useState(false)
  if (!on) return null
  const list = bookings.data ?? []
  return (
    <section aria-labelledby="bookings-h" className={className}>
      <h2 id="bookings-h" className="t-display-2 text-ink">
        Bookings
      </h2>
      <p className="mt-1 t-small text-muted">Simulated tickets and rides, paid from your wallet.</p>
      {list.length > 0 ? (
        <ul className="mt-3 divide-y divide-line overflow-hidden rounded-card border border-line bg-surface">
          {list.map((b) => (
            <li key={b.bookingId}>
              <button
                type="button"
                onClick={() => {
                  setLoaded(true)
                  setViewing(b)
                }}
                className="flex w-full items-center gap-3 px-4 py-3 text-left [@media(hover:hover)]:hover:bg-sunken/60"
              >
                <span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center rounded-full bg-sunken text-ink">
                  <KindIcon b={b} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate t-title text-ink">{title(b)}</span>
                  <span className="block t-small text-ink-2 tnum">
                    {b.kind === 'cab' ? `Ride ${b.reference}` : `PNR ${b.reference}`}, {rupees(b.fareInr)}
                  </span>
                </span>
                {b.status === 'cancelled' && <Tag tone="sunken">Cancelled</Tag>}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 rounded-card border border-dashed border-line-strong px-4 py-3 t-small text-ink-2">No bookings yet. Book a cab or a train from Today, or a flight here.</p>
      )}
      <Button
        variant="secondary"
        size="md"
        className="mt-3"
        icon={<Plane size={18} strokeWidth={1.75} aria-hidden="true" />}
        onClick={() => {
          setLoaded(true)
          setFlight(true)
        }}
      >
        Book a flight
      </Button>
      {loaded && (
        <Suspense fallback={null}>
          {flight && (
            <FlightBookingSheet
              trip={trip}
              open
              onOpenChange={(o) => !o && setFlight(false)}
              onBooked={(b) => {
                setFlight(false)
                setViewing(b)
              }}
            />
          )}
          <BookingSheet trip={trip} booking={viewing} onOpenChange={(o) => !o && setViewing(null)} />
        </Suspense>
      )}
    </section>
  )
}
