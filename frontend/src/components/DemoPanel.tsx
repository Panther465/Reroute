import * as Popover from '@radix-ui/react-popover'
import { SlidersHorizontal, X } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { api, ApiError, setForcedOffline } from '@/api/client'
import { keys, queryClient, useTrips } from '@/api/queries'
import type { CheckinResult, ShareLink, Trip } from '@/api/types'
import { Button } from '@/components/ui/Button'
import { Switch } from '@/components/ui/Choice'
import { inputClass } from '@/components/ui/Field'
import { applyServerChange } from '@/lib/actions'
import { hhmm, lowerFirst } from '@/lib/format'
import { useDayGuide } from '@/lib/dayAlerts'
import { simulateRide, stopTracking, useLocation } from '@/lib/location'
import { setState, showToast, useStore } from '@/lib/store'
import { buildDay, localMinutes } from '@/lib/timeline'

/**
 * The demo bar (?demo=1, or the demo account): the demo time and a Simulate button that opens the panel
 * driving the API's demo clock. A slim bar at the top of the page on phones and in the top bar on
 * desktop, so nothing floats over the day.
 */
export function DemoPanel({ trip, onLate, inTopBar = false }: { trip: Trip | undefined; onLate: (delay: number | null, mode?: 'late' | 'options') => void; inTopBar?: boolean }) {
  const demo = useStore((s) => s.demo)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const navigate = useNavigate()
  const trips = useTrips(demo.enabled)
  const { guide } = useDayGuide(trip, trip ? localMinutes(trip.now, trip.day, trip.utcOffset) : null)
  const { simulated } = useLocation()
  if (!demo.enabled || !trip) return null
  // Reset always restores the sample trip, even while another trip is on screen.
  const sampleId = trips.data?.items.find((t) => t.sample)?.tripId ?? trip.tripId
  const tripId = trip.tripId
  const clock = localMinutes(trip.now, trip.day, trip.utcOffset)
  // One-tap jumps to the moments worth seeing: the next departure, and the end of the task under way.
  const view = buildDay(trip, clock)
  const nextLeave = view?.legs.find((l) => l.status !== 'done' && l.leaveMin > clock)?.leaveMin ?? null
  const current = view?.stops.find((s) => s.status === 'now' && s.kind === 'task' && s.end > clock) ?? null
  const plus15 = Math.min(clock + 15, 23 * 60 + 59)

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(true)
    try {
      await fn()
    } catch (err) {
      showToast({ title: err instanceof ApiError ? err.message : `Couldn't ${label}.` })
    } finally {
      setBusy(false)
    }
  }

  const setClock = (value: string) =>
    run('set the time', async () => {
      const now = `${trip.day}T${value}:00${trip.utcOffset}`
      const next = await api.post<Trip>(`/v1/trips/${tripId}/demo/clock`, { now })
      queryClient.setQueryData(keys.trip(tripId), next)
    })

  const check = () =>
    run('run the check', async () => {
      const before = buildDay(trip)
      const res = await api.post<CheckinResult>(`/v1/trips/${tripId}/demo/check`, {})
      setOpen(false)
      if (res.result === 'shifted') {
        await applyServerChange(tripId, before, { kind: 'reroute', toast: res.explanation, undo: true, banner: true })
      } else if (res.result === 'options') {
        await queryClient.invalidateQueries({ queryKey: keys.trip(tripId) })
        navigate('/')
        onLate(null, 'options')
      } else {
        await queryClient.invalidateQueries({ queryKey: keys.trip(tripId) })
        showToast({ title: res.explanation || "You're on time. Nothing changed." })
      }
    })

  const reset = () =>
    run('reset the demo', async () => {
      const next = await api.post<Trip>(`/v1/trips/${sampleId}/demo/reset`, {})
      queryClient.setQueryData(keys.trip(sampleId), next)
      // Trips started during the demo are gone now.
      await queryClient.invalidateQueries({ queryKey: keys.trips })
      setState({ change: null, autoBanner: null, optimisticDone: [], started: null, tripId: sampleId })
      setOpen(false)
      navigate('/plan')
      showToast({ title: 'Demo reset. Plan the day to start again.' })
    })

  const expireShare = () =>
    run('expire the link', async () => {
      const links = await api.get<ShareLink[]>(`/v1/trips/${tripId}/share-links`)
      await Promise.all(links.filter((l) => !l.revokedAt).map((l) => api.delete(`/v1/share-links/${l.shareId}`)))
      showToast({ title: 'Share links stopped.' })
    })

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      {/* data-demo-bar: product screenshots leave the demo chrome out. */}
      <div data-demo-bar="" className={inTopBar ? 'ml-auto flex items-center gap-2' : 'flex min-h-12 items-center justify-between gap-3 border-b border-line bg-sunken px-5'}>
        <p className="t-small text-ink-2 tnum">
          <span className="font-bold text-ink">Demo</span> time {hhmm(clock)}
        </p>
        <Popover.Trigger asChild>
          <button
            type="button"
            className="-mr-2 inline-flex min-h-12 items-center gap-2 rounded-control px-3 t-small font-bold text-ink transition-colors duration-[var(--dur-quick)] [@media(hover:hover)]:hover:bg-surface active:bg-surface"
          >
            <SlidersHorizontal size={18} strokeWidth={1.75} aria-hidden="true" />
            Simulate
          </button>
        </Popover.Trigger>
      </div>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={8} collisionPadding={16} className="z-[70] max-h-[80vh] w-[min(360px,calc(100vw-32px))] overflow-y-auto rounded-card border border-line bg-surface p-5 text-ink shadow-[var(--shadow-toast)]">
          <div className="flex items-start justify-between">
            <h2 className="t-display-2">Simulate</h2>
            <Popover.Close aria-label="Close" className="-mr-2 -mt-2 flex size-12 items-center justify-center rounded-control">
              <X size={24} strokeWidth={1.75} aria-hidden="true" />
            </Popover.Close>
          </div>
          <p className="mt-1 t-small text-muted">For the demo only. Demo time stands still until you move it here.</p>
          <label className="mt-4 block t-title" htmlFor="demo-clock">
            Current time
          </label>
          <input
            id="demo-clock"
            type="time"
            className={`${inputClass} mt-2 tnum`}
            defaultValue={hhmm(clock)}
            key={trip.now}
            onBlur={(e) => e.target.value && e.target.value !== hhmm(clock) && setClock(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.value && e.currentTarget.value !== hhmm(clock) && setClock(e.currentTarget.value)}
            disabled={busy}
          />
          <div className="mt-2 flex flex-wrap gap-2">
            <Button variant="secondary" size="md" disabled={busy || plus15 === clock} onClick={() => setClock(hhmm(plus15))}>
              +15 min
            </Button>
            {nextLeave !== null && (
              <Button variant="secondary" size="md" disabled={busy} onClick={() => setClock(hhmm(nextLeave))}>
                Next departure, {hhmm(nextLeave)}
              </Button>
            )}
            {current && (
              <Button variant="secondary" size="md" disabled={busy} onClick={() => setClock(hhmm(current.end))}>
                End of the {lowerFirst(current.title)}, {hhmm(current.end)}
              </Button>
            )}
          </div>
          {guide && (
            <div className="mt-4">
              <Button
                variant="secondary"
                size="md"
                full
                disabled={busy}
                onClick={() => {
                  if (simulated) return stopTracking()
                  // As if the traveller left and rode the leg: the dot moves along the road, then arrives.
                  setState({ started: { tripId, toId: guide.leg.toId, day: trip.day, at: localMinutes(trip.now, trip.day, trip.utcOffset) } })
                  simulateRide(guide.path)
                  setOpen(false)
                  navigate('/')
                }}
              >
                {simulated ? 'Stop the simulated ride' : `Simulate the ride to the ${lowerFirst(guide.to.title)}`}
              </Button>
              <p className="mt-1 t-small text-muted">Moves your location along the road in about 40 seconds, for the tracking and arrival alerts.</p>
            </div>
          )}
          <div className="mt-4 grid grid-cols-2 gap-2">
            <Button variant="secondary" size="md" disabled={busy} onClick={() => { setOpen(false); navigate('/'); onLate(15) }}>
              15 min delay
            </Button>
            <Button variant="secondary" size="md" disabled={busy} onClick={() => { setOpen(false); navigate('/'); onLate(40) }}>
              40 min delay
            </Button>
          </div>
          <Button variant="secondary" size="md" full className="mt-2" loading={busy} loadingLabel="Checking…" onClick={check}>
            Run the 5-minute check
          </Button>
          <div className="mt-4 divide-y divide-line">
            <Switch
              label="Go offline"
              description="Calls fail as if there were no signal"
              checked={demo.offline}
              onChange={(v) => {
                setForcedOffline(v)
                setState((s) => ({ demo: { ...s.demo, offline: v } }))
                if (!v) window.dispatchEvent(new Event('online'))
              }}
            />
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="secondary" size="md" disabled={busy} onClick={expireShare}>
              Expire share links
            </Button>
            <Button variant="tertiary" size="md" disabled={busy} onClick={reset}>
              Reset the demo
            </Button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
