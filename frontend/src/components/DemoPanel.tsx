import * as Popover from '@radix-ui/react-popover'
import { SlidersHorizontal, X } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { api, ApiError, setForcedOffline } from '@/api/client'
import { keys, queryClient } from '@/api/queries'
import type { CheckinResult, ShareLink, Trip } from '@/api/types'
import { Button } from '@/components/ui/Button'
import { Switch } from '@/components/ui/Choice'
import { inputClass } from '@/components/ui/Field'
import { applyServerChange } from '@/lib/actions'
import { hhmm } from '@/lib/format'
import { setState, showToast, useStore } from '@/lib/store'
import { buildDay, localMinutes } from '@/lib/timeline'

/** Developer-only Simulate panel (?demo=1, or the demo account). Drives the API's demo clock. On desktop its button sits bottom right, clear of the action bar. */
export function DemoPanel({ trip, onLate }: { trip: Trip | undefined; onLate: (delay: number | null, mode?: 'late' | 'options') => void }) {
  const demo = useStore((s) => s.demo)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const navigate = useNavigate()
  if (!demo.enabled || !trip) return null
  const tripId = trip.tripId
  const clock = localMinutes(trip.now, trip.day, trip.utcOffset)

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
      const next = await api.post<Trip>(`/v1/trips/${tripId}/demo/reset`, {})
      queryClient.setQueryData(keys.trip(tripId), next)
      setState({ change: null, autoBanner: null, optimisticDone: [], startedSeq: null })
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
      <Popover.Trigger asChild>
        <button type="button" className="fixed bottom-[calc(148px+env(safe-area-inset-bottom))] right-4 z-40 flex min-h-12 items-center gap-2 rounded-full border-2 border-ink bg-surface px-4 t-title text-ink lg:bottom-6 lg:right-6">
          <SlidersHorizontal size={20} strokeWidth={1.75} aria-hidden="true" />
          Simulate
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content sideOffset={8} collisionPadding={16} className="z-[70] max-h-[80vh] w-[min(360px,calc(100vw-32px))] overflow-y-auto rounded-card border border-line bg-surface p-5 text-ink shadow-[var(--shadow-toast)]">
          <div className="flex items-start justify-between">
            <h2 className="t-display-2">Simulate</h2>
            <Popover.Close aria-label="Close" className="-mr-2 -mt-2 flex size-12 items-center justify-center rounded-control">
              <X size={24} strokeWidth={1.75} aria-hidden="true" />
            </Popover.Close>
          </div>
          <p className="mt-1 t-small text-muted">For the demo only. The server keeps a simulated clock for this trip.</p>
          <label className="mt-4 block t-title" htmlFor="demo-clock">
            Current time
          </label>
          <input id="demo-clock" type="time" className={`${inputClass} mt-2 tnum`} defaultValue={hhmm(clock)} key={trip.now} onBlur={(e) => e.target.value && e.target.value !== hhmm(clock) && setClock(e.target.value)} disabled={busy} />
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
