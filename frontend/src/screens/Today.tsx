import { BellRing, CircleCheck, Share2, X } from 'lucide-react'
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { useCurrentTripId, useDay, useTrip } from '@/api/queries'
import type { Trip } from '@/api/types'
import { NextCard } from '@/components/NextCard'
import { RerouteLog } from '@/components/RerouteLog'
import { StatusPill } from '@/components/StatusPill'
import { Timeline } from '@/components/timeline/Timeline'
import { Button, ButtonLink } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { Banner, EmptyState, ErrorState, LoadingRegion, Skeleton } from '@/components/ui/States'
import { Tag } from '@/components/ui/Tag'
import { checkIn, undo, undoVersionOf } from '@/lib/actions'
import { legLines, type PlaceIndex } from '@/lib/geo'
import { useIsDesktop, useOnline, useStatus, useTripClock, type Status } from '@/lib/hooks'
import { useT } from '@/lib/i18n'
import { useOpenLate } from '@/lib/late'
import { useQueued } from '@/lib/offlineQueue'
import { setState, useStore } from '@/lib/store'
import { addDays, dayLabel, localMinutes, type LegView, type StopView } from '@/lib/timeline'
import { LegDetailContent } from './LegDetail'
import { ShareSheet } from './ShareSheet'
import { TaskSheet } from './TaskSheet'

const MapCard = lazy(() => import('@/components/MapCard'))

export function TodaySkeleton() {
  return (
    <LoadingRegion label="Loading your plan">
      <div className="px-5 pt-6 lg:px-8">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="mt-2 h-5 w-56" />
        <Skeleton className="mt-6 h-40 w-full rounded-card" />
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="mt-6 grid grid-cols-[3.5rem_1.5rem_1fr] gap-x-3">
            <Skeleton className="h-6 w-12" />
            <Skeleton className="mx-auto h-24 w-1.5 rounded-full" />
            <div>
              <Skeleton className="h-5 w-32" />
              <Skeleton className="mt-2 h-4 w-24" />
            </div>
          </div>
        ))}
      </div>
    </LoadingRegion>
  )
}

export function TodayHeader({ trip, status, onLog, onShare }: { trip: Trip; status: Status; onLog: () => void; onShare: () => void }) {
  const demo = useStore((s) => s.demo.enabled)
  return (
    <header className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="t-display-1 text-ink">{trip.cityName}</h1>
          {demo && <Tag tone="sunken">Demo</Tag>}
          {trip.sample && <Tag tone="grey-outline">Sample trip</Tag>}
        </div>
        <p className="mt-1 t-body text-ink-2">
          {dayLabel(trip.day)}, day {trip.dayIndex} of {trip.dayCount}
        </p>
        <div className="mt-3 flex">
          <StatusPill live={status} onOpen={onLog} />
        </div>
      </div>
      <IconButton label="Share live trip" onClick={onShare} className="-mr-2 shrink-0">
        <Share2 size={24} strokeWidth={1.75} aria-hidden="true" />
      </IconButton>
    </header>
  )
}

export function placeIndex(trip: Trip): PlaceIndex {
  const index: PlaceIndex = new Map([[trip.stayPlace.placeId, [trip.stayPlace.lng, trip.stayPlace.lat]]])
  for (const t of trip.tasks) index.set(t.placeId, [t.place.lng, t.place.lat])
  return index
}

export default function Today() {
  const t = useT()
  const current = useCurrentTripId()
  const tripQ = useTrip(current.tripId)
  const trip = tripQ.data
  const baseView = useDay(trip)
  const serverNow = trip ? localMinutes(trip.now, trip.day, trip.utcOffset) : null
  const clock = useTripClock(serverNow) ?? 0
  const view = baseView
  const change = useStore((s) => s.change)
  const reveal = useStore((s) => s.reveal)
  const autoBanner = useStore((s) => s.autoBanner)
  const leaveNow = useStore((s) => s.leaveNow)
  const startedSeq = useStore((s) => s.startedSeq)
  const queued = useQueued(current.tripId ?? undefined)
  const online = useOnline()
  const desktop = useIsDesktop()
  const navigate = useNavigate()
  const openLate = useOpenLate()
  const status = useStatus(trip, view, clock)
  const [logOpen, setLogOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [stop, setStop] = useState<StopView | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [checking, setChecking] = useState(false)

  // The first-reveal draw runs once per plan.
  const [revealing, setRevealing] = useState(false)
  const seenReveal = useRef(0)
  useEffect(() => {
    if (reveal && reveal !== seenReveal.current) {
      seenReveal.current = reveal
      setRevealing(true)
      const id = setTimeout(() => {
        setRevealing(false)
        setState({ reveal: 0 })
      }, 1000)
      return () => clearTimeout(id)
    }
  }, [reveal])

  const places = useMemo(() => (trip ? placeIndex(trip) : new Map()), [trip])
  const activeSeq = view?.nextLeg?.seq ?? view?.legs[view.legs.length - 1]?.seq ?? null
  const selectedSeq = desktop ? (selected && view?.legs.some((l) => l.seq === selected) ? selected : activeSeq) : null
  const selectedLeg = view?.legs.find((l) => l.seq === selectedSeq) ?? null

  const mapLines = useMemo(() => (view ? view.legs.flatMap((l) => legLines(l, places, l.status === 'done')) : []), [view, places])
  const mapPoints = useMemo(() => {
    if (!view) return []
    const pts = view.stops
      .filter((s) => s.kind !== 'end' && places.has(s.placeId))
      .map((s) => ({ id: s.id, lngLat: places.get(s.placeId)!, kind: 'stop' as const, label: `${s.title}, ${s.area}` }))
    const here = places.get(view.stops[view.nowIndex]?.placeId ?? '')
    return here ? [...pts, { id: 'me', lngLat: here, kind: 'user' as const, label: 'Where you are, by your check-ins' }] : pts
  }, [view, places])
  const focus = useMemo(() => (selectedLeg ? legLines(selectedLeg, places).flatMap((l) => l.coords) : undefined), [selectedLeg, places])

  if (current.isPending || (tripQ.isPending && !!current.tripId)) return <TodaySkeleton />
  if ((current.isError || tripQ.isError) && !trip) {
    return (
      <div className="mx-auto max-w-[560px] px-5 pt-6">
        <h1 className="t-display-1 text-ink">{t('Today')}</h1>
        <div className="mt-6">
          {online ? (
            <ErrorState message={t("Couldn't load your plan. Check your connection and try again.")} onRetry={() => (current.tripId ? tripQ.refetch() : current.refetch())} />
          ) : (
            <Banner tone="offline">You're offline and this plan hasn't been saved on this phone yet. Connect once to load it.</Banner>
          )}
        </div>
      </div>
    )
  }

  if (!trip) {
    return (
      <div className="mx-auto max-w-[560px] px-5 pt-6 lg:max-w-[720px] lg:px-8">
        <h1 className="t-display-1 text-ink">{t('Today')}</h1>
        <EmptyState title="No trip yet" body="Add your tasks and Reroute works out the order, when to leave and what it costs." action={<ButtonLink to="/plan">{t('Plan my day')}</ButtonLink>} />
      </div>
    )
  }

  const onLeg = (leg: LegView) => (desktop ? setSelected(leg.seq) : navigate(`/leg/${leg.seq}`))
  const header = <TodayHeader trip={trip} status={status} onLog={() => setLogOpen(true)} onShare={() => setShareOpen(true)} />

  if (!view) {
    return (
      <div className="mx-auto max-w-[560px] px-5 pt-6 lg:max-w-[720px] lg:px-8">
        {header}
        <EmptyState title="No plan for today yet" body="Add your tasks and Reroute works out the order, when to leave and what it costs." action={<ButtonLink to="/plan">{t('Plan my day')}</ButtonLink>} />
        <RerouteLog trip={trip} open={logOpen} onOpenChange={setLogOpen} />
        <ShareSheet trip={trip} open={shareOpen} onOpenChange={setShareOpen} />
      </div>
    )
  }

  const started = startedSeq !== null && startedSeq === view.nextLeg?.seq
  const bannerUndo = undoVersionOf(trip)

  const banners = (
    <div className="flex flex-col gap-2 empty:hidden">
      {!online && <Banner tone="offline">{t("You're offline. Your plan still works, and changes sync when you're back.")}</Banner>}
      {queued.length > 0 && (
        <Banner tone="info">
          {queued.length === 1 ? 'One check-in is waiting to sync.' : `${queued.length} check-ins are waiting to sync.`}
        </Banner>
      )}
      {trip.openOptions && (
        <Banner
          tone="blocked"
          action={
            <Button variant="destructive" size="md" onClick={() => openLate(null, 'options')}>
              See the options
            </Button>
          }
        >
          {trip.openOptions.explanation || 'Your later stops no longer fit. Choose how to fix the rest of today.'}
        </Banner>
      )}
      {leaveNow && (
        <Banner
          tone="info"
          action={
            <button type="button" aria-label="Dismiss" className="flex size-12 items-center justify-center rounded-control" onClick={() => setState({ leaveNow: null })}>
              <X size={20} strokeWidth={1.75} aria-hidden="true" />
            </button>
          }
        >
          <span className="inline-flex items-center gap-2">
            <BellRing size={16} strokeWidth={1.75} aria-hidden="true" />
            {leaveNow.text}
          </span>
        </Banner>
      )}
      {autoBanner && (
        <Banner
          tone="auto"
          action={
            bannerUndo !== null ? (
              <button type="button" className="min-h-12 rounded-control px-3 t-title underline decoration-2 underline-offset-4" onClick={() => void undo(trip.tripId, bannerUndo)}>
                {t('Undo')}
              </button>
            ) : undefined
          }
        >
          {autoBanner.text}
        </Banner>
      )}
    </div>
  )

  const doCheckIn = async () => {
    setChecking(true)
    try {
      await checkIn(trip.tripId, view)
    } finally {
      setChecking(false)
    }
  }

  const actions = !view.done && (
    <div className="grid grid-cols-2 gap-3">
      <Button variant="destructive" onClick={() => openLate()} disabled={!view.checkInTask}>
        {t('Running late')}
      </Button>
      <Button variant="primary" onClick={doCheckIn} loading={checking} loadingLabel="Checking in…" disabled={!view.checkInTask} icon={<CircleCheck size={20} strokeWidth={1.75} aria-hidden="true" />}>
        {t('Check in')}
      </Button>
    </div>
  )

  const timeline = (
    <Timeline
      view={view}
      clock={clock}
      change={change}
      reveal={revealing}
      onLeg={onLeg}
      onStop={setStop}
      selectedSeq={selectedSeq}
      tomorrowLabel={dayLabel(addDays(trip.day, 1))}
    />
  )
  const estimates = <p className="mt-2 t-small text-muted">Times and fares are estimates.</p>

  const sheets = (
    <>
      <RerouteLog trip={trip} open={logOpen} onOpenChange={setLogOpen} />
      <ShareSheet trip={trip} open={shareOpen} onOpenChange={setShareOpen} />
      <TaskSheet trip={trip} view={view} stop={stop} onClose={() => setStop(null)} />
    </>
  )

  if (desktop) {
    return (
      <div className="mx-auto grid max-w-[1440px] grid-cols-[420px_minmax(0,1fr)] gap-8 px-8">
        <section aria-label="Your day" className="flex min-h-[calc(100dvh-64px)] flex-col pt-8">
          {header}
          <div className="mt-5 flex flex-col gap-4">
            {banners}
            <NextCard view={view} clock={clock} started={started} />
          </div>
          <div className="mt-8 flex-1">
            {timeline}
            {estimates}
          </div>
          <div className="sticky bottom-0 -mx-8 mt-4 border-t border-line bg-ground px-8 py-4">{actions || <ButtonLink to="/summary">See the day summary</ButtonLink>}</div>
        </section>
        <section aria-label="Map and leg detail" className="sticky top-16 flex h-[calc(100dvh-64px)] flex-col gap-4 overflow-y-auto py-8">
          <Suspense fallback={<Skeleton className="h-[44vh] min-h-72 w-full shrink-0 rounded-card" />}>
            <MapCard lines={mapLines} points={mapPoints} focus={focus} label="Map of today's route" className="h-[44vh] min-h-72 shrink-0" draw={revealing} />
          </Suspense>
          {selectedLeg && <LegDetailContent key={selectedLeg.seq} trip={trip} leg={selectedLeg} embedded />}
        </section>
        {sheets}
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-[560px]">
      <div className="px-5 pt-6">
        {header}
        <div className="mt-5 flex flex-col gap-4">
          {banners}
          <NextCard view={view} clock={clock} started={started} />
        </div>
        <div className="mt-8">
          {timeline}
          {estimates}
        </div>
        {view.done && (
          <div className="mt-2 pb-6">
            <ButtonLink to="/summary" variant="secondary" full>
              See the day summary
            </ButtonLink>
          </div>
        )}
        {!view.done && (
          <p className="pb-4 pt-2">
            <ButtonLink to="/summary" variant="tertiary" size="md" className="-ml-2">
              See the day so far
            </ButtonLink>
          </p>
        )}
      </div>
      {actions && <div className="sticky bottom-[calc(64px+env(safe-area-inset-bottom))] z-20 border-t border-line bg-surface px-5 py-3">{actions}</div>}
      {sheets}
    </div>
  )
}
