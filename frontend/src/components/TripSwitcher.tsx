import { Check, Plus } from 'lucide-react'
import { useNavigate } from 'react-router'
import { useCurrentTripId, useTrips } from '@/api/queries'
import type { TripSummary } from '@/api/types'
import { Button } from '@/components/ui/Button'
import { Sheet } from '@/components/ui/Sheet'
import { ErrorState, Skeleton } from '@/components/ui/States'
import { Tag } from '@/components/ui/Tag'
import { setState } from '@/lib/store'
import { dayLabel } from '@/lib/timeline'

function localToday() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function when(t: TripSummary, today: string) {
  if (t.startDate <= today && today <= t.endDate) return { label: 'Today', tone: 'green' as const }
  if (t.startDate > today) return { label: 'Upcoming', tone: 'grey-outline' as const }
  return { label: 'Past', tone: 'sunken' as const }
}

/** Every trip, the one on screen ticked; pick one to show it, or start a new one. */
export function TripSwitcher({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const trips = useTrips(open)
  const current = useCurrentTripId().tripId
  const navigate = useNavigate()
  const today = localToday()

  const pick = (tripId: string) => {
    // The reroute banner and choreography belong to the trip that was on screen.
    setState({ tripId, change: null, autoBanner: null })
    onOpenChange(false)
    navigate('/')
  }
  const startNew = () => {
    onOpenChange(false)
    navigate('/plan', { state: { newTrip: true } })
  }

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Your trips"
      footer={
        <Button full variant="secondary" icon={<Plus size={20} strokeWidth={1.75} aria-hidden="true" />} onClick={startNew}>
          Start a new trip
        </Button>
      }
    >
      {trips.isPending ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-20 w-full rounded-card" />
          <Skeleton className="h-20 w-full rounded-card" />
        </div>
      ) : trips.isError && !trips.data ? (
        <ErrorState message="Couldn't load your trips. Check your connection and try again." onRetry={() => trips.refetch()} />
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-card border border-line bg-surface">
          {trips.data?.items.map((t) => {
            const showing = t.tripId === current
            // The sample trip runs on its own demo clock, so the calendar says nothing about it.
            const w = t.sample ? null : when(t, today)
            return (
              <li key={t.tripId}>
                <button
                  type="button"
                  onClick={() => pick(t.tripId)}
                  aria-current={showing ? 'true' : undefined}
                  className="flex w-full items-start gap-3 px-4 py-4 text-left [@media(hover:hover)]:hover:bg-sunken/60"
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="t-title text-ink">{t.cityName}</span>
                      {w && <Tag tone={w.tone}>{w.label}</Tag>}
                      {t.sample && <Tag tone="grey-outline">Sample trip</Tag>}
                    </span>
                    <span className="mt-1 block t-small text-ink-2">
                      {t.startDate === t.endDate ? dayLabel(t.startDate) : `${dayLabel(t.startDate)} to ${dayLabel(t.endDate)}`}
                    </span>
                    <span className="block t-small text-muted">Staying at {t.stayLabel}</span>
                  </span>
                  {showing && (
                    <span className="mt-1 flex items-center gap-1 t-small font-bold text-green-ink">
                      <Check size={18} strokeWidth={2} aria-hidden="true" />
                      Showing
                    </span>
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </Sheet>
  )
}
