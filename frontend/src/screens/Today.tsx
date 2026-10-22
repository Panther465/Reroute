import { BellRing, Car, CarTaxiFront, ChevronDown, CircleCheck, LocateFixed, Map as MapIcon, MapPin, MapPinned, Navigation, Plus, Route, Scale, Share2, Ticket, TrainFront, TriangleAlert, X } from 'lucide-react'
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation as useRouterLocation, useNavigate } from 'react-router'
import { useAiHelperEnabled, useBookings, useBookingsEnabled, useCurrentTripId, useDay, useTrip } from '@/api/queries'
import type { Booking, Task, Trip } from '@/api/types'
import { NextCard } from '@/components/NextCard'
import { LazyMap } from '@/components/LazyMap'
import { StatusPill } from '@/components/StatusPill'
import { Timeline } from '@/components/timeline/Timeline'
import { TodaySkeleton } from '@/components/TodaySkeleton'
import { Button, ButtonLink } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { Banner, EmptyState, ErrorState, Skeleton } from '@/components/ui/States'
import { Tag } from '@/components/ui/Tag'
import { ApiError } from '@/api/client'
import { applyServerChange, checkIn, moveTaskToDay, playLater, playTaskEdit, replanDay, undo, undoVersionOf } from '@/lib/actions'
import { duration, lowerFirst } from '@/lib/format'
import { stopIcon } from '@/lib/stopIcon'
import { activeBooking, isTrainTask } from '@/lib/bookings'
import type { MapPoint } from '@/components/MapCard'
import { legLines, type MapLine } from '@/lib/geo'
import { useDayGuide } from '@/lib/dayAlerts'
import { geolocationSupported, getLocation, startTracking, useLocation } from '@/lib/location'
import { distanceLabel, splitPath } from '@/lib/progress'
import { useDocumentTitle, useIsDesktop, useOnline, useStatus, useTripClock, type Status } from '@/lib/hooks'
import { T, useTl } from '@/lib/i18n'
import { useOpenLate } from '@/lib/late'
import { useQueued } from '@/lib/offlineQueue'
import { setState, showToast, useStore } from '@/lib/store'
import { addDays, dayLabel, localMinutes, samePlace, weekday, type DayView, type LegView, type StopView } from '@/lib/timeline'

// Sheets and the embedded leg detail load the first time they open, so Today itself stays small.
const LegDetailContent = lazy(() => import('./LegDetail').then((m) => ({ default: m.LegDetailContent })))
const ShareSheet = lazy(() => import('./ShareSheet').then((m) => ({ default: m.ShareSheet })))
const TaskSheet = lazy(() => import('./TaskSheet').then((m) => ({ default: m.TaskSheet })))
const RerouteLog = lazy(() => import('@/components/RerouteLog').then((m) => ({ default: m.RerouteLog })))
const CheckInConfirm = lazy(() => import('./CheckInConfirm').then((m) => ({ default: m.CheckInConfirm })))
const TrainBookingSheet = lazy(() => import('./BookingSheets').then((m) => ({ default: m.TrainBookingSheet })))
const CabBookingSheet = lazy(() => import('./BookingSheets').then((m) => ({ default: m.CabBookingSheet })))
const BookingSheet = lazy(() => import('./BookingSheets').then((m) => ({ default: m.BookingSheet })))
const AiPlannerSheet = lazy(() => import('./AiPlannerSheet').then((m) => ({ default: m.AiPlannerSheet })))
const TripSwitcher = lazy(() => import('@/components/TripSwitcher').then((m) => ({ default: m.TripSwitcher })))

/** True from the first time `open` is true: a lazy sheet mounts then and stays, so it can animate closed. */
function useLoadedOnce(open: boolean) {
  const [loaded, setLoaded] = useState(open)
  if (open && !loaded) setLoaded(true)
  return loaded || open
}

export function TodayHeader({
  trip,
  status,
  onLog,
  onShare,
  onAdd,
  onTrips,
}: {
  trip: Trip
  status: Status
  onLog: () => void
  onShare: () => void
  onAdd?: () => void
  onTrips?: () => void
}) {
  const day = `${dayLabel(trip.day)}, day ${trip.dayIndex} of ${trip.dayCount}`
  return (
    <header className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h1 tabIndex={-1} className="t-display-1 text-ink">
            {trip.cityName}
          </h1>
          {/* The demo bar above says "Demo"; the trip only says what it is. */}
          {trip.sample && <Tag tone="grey-outline">Sample trip</Tag>}
        </div>
        {onTrips ? (
          <button type="button" onClick={onTrips} className="-mx-1 mt-0.5 block min-h-12 rounded-control px-1 py-1 text-left t-body text-ink-2 [@media(hover:hover)]:hover:bg-sunken">
            {`${dayLabel(trip.day)}, `}
            {/* "day 1 of 2" and the chevron wrap together, never split across lines. */}
            <span className="whitespace-nowrap">
              day {trip.dayIndex} of {trip.dayCount}
              <ChevronDown size={18} strokeWidth={1.75} aria-hidden="true" className="ml-1 inline-block align-[-3px]" />
            </span>
            <span className="sr-only">. Your trips</span>
          </button>
        ) : (
          <p className="mt-1 t-body text-ink-2">{day}</p>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-x-4">
          <StatusPill live={status} onOpen={onLog} />
          {trip.activePlan && (
            <Link to="/why" className="inline-flex min-h-12 items-center gap-1.5 rounded-control t-small font-bold text-ink-2 underline decoration-line-strong decoration-2 underline-offset-4 [@media(hover:hover)]:hover:text-ink">
              <Scale size={16} strokeWidth={2} aria-hidden="true" />
              Why this plan?
            </Link>
          )}
        </div>
      </div>
      <div className="-mr-2 flex shrink-0 items-center">
        {onAdd && (
          <IconButton label="Add to today" onClick={onAdd}>
            <Plus size={24} strokeWidth={1.75} aria-hidden="true" />
          </IconButton>
        )}
        <IconButton label="Share live trip" onClick={onShare}>
          <Share2 size={24} strokeWidth={1.75} aria-hidden="true" />
        </IconButton>
      </div>
    </header>
  )
}

/** Today's tasks that aren't on the timeline, and why, so nothing quietly disappears. */
function NotInPlan({ trip, view }: { trip: Trip; view: DayView }) {
  const tripId = trip.tripId
  const [updating, setUpdating] = useState(false)
  const [moving, setMoving] = useState<string | null>(null)
  const items = [...view.leftOut.map((t) => ({ ...t, leftOut: true })), ...view.notPlanned.map((t) => ({ ...t, reason: 'Added after this plan was made.', leftOut: false }))]
  if (!items.length) return null
  // On a multi-day trip, the usual fix for a task that doesn't fit is the next day.
  const nextDay = addDays(trip.day, 1) <= trip.endDate ? addDays(trip.day, 1) : null
  const move = async (taskId: string, title: string) => {
    if (!nextDay) return
    setMoving(taskId)
    try {
      await moveTaskToDay(tripId, taskId, nextDay, view)
      showToast({ title: `The ${lowerFirst(title)} moved to ${weekday(nextDay)}.` })
    } catch (err) {
      showToast({ title: err instanceof ApiError ? err.message : "Couldn't move it. Try again." })
    } finally {
      setMoving(null)
    }
  }
  const update = async () => {
    setUpdating(true)
    try {
      await replanDay(tripId, view)
    } catch (err) {
      showToast({ title: err instanceof ApiError ? err.message : "Couldn't update your plan. Try again." })
    } finally {
      setUpdating(false)
    }
  }
  return (
    <section aria-labelledby="not-in-plan" className="rounded-card border border-line bg-surface p-4">
      <h2 id="not-in-plan" className="flex items-center gap-2 t-title text-ink">
        <TriangleAlert size={20} strokeWidth={2} aria-hidden="true" className="shrink-0 text-red-ink" />
        {items.length === 1 ? '1 task isn’t in today’s plan' : `${items.length} tasks aren’t in today’s plan`}
      </h2>
      <ul className="mt-3 flex flex-col divide-y divide-line">
        {items.map((t) => (
          <li key={t.taskId} className="py-2.5 first:pt-0">
            <p className="t-small text-ink-2">
              <span className="font-bold text-ink">{t.title}</span>: {t.reason}
            </p>
            {t.leftOut && nextDay && (
              <Button variant="secondary" size="md" className="mt-2" loading={moving === t.taskId} loadingLabel="Moving…" disabled={!!moving} onClick={() => void move(t.taskId, t.title)}>
                Move to {weekday(nextDay)}
              </Button>
            )}
          </li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap gap-2">
        {view.notPlanned.length > 0 && (
          <Button size="md" loading={updating} loadingLabel="Updating…" onClick={update}>
            Update the plan
          </Button>
        )}
        <ButtonLink to="/plan" variant="secondary" size="md">
          Edit tasks
        </ButtonLink>
      </div>
    </section>
  )
}

const dismissButton = (onClick: () => void) => (
  <button type="button" aria-label="Dismiss" className="flex size-12 items-center justify-center rounded-control" onClick={onClick}>
    <X size={20} strokeWidth={1.75} aria-hidden="true" />
  </button>
)

export default function Today() {
  const tl = useTl()
  const current = useCurrentTripId()
  const tripQ = useTrip(current.tripId)
  const trip = tripQ.data
  const serverNow = trip ? localMinutes(trip.now, trip.day, trip.utcOffset) : null
  const tripClock = useTripClock(serverNow, tripQ.dataUpdatedAt, trip?.clockSimulated ?? false)
  const clock = tripClock ?? 0
  // The view follows the running trip clock: where the traveller is, late tags and the end of the day.
  const view = useDay(trip, tripClock)
  const change = useStore((s) => s.change)
  const reveal = useStore((s) => s.reveal)
  const autoBanner = useStore((s) => s.autoBanner)
  const leaveNow = useStore((s) => s.leaveNow)
  const startedTo = useStore((s) => s.started)
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
  const [confirmEarly, setConfirmEarly] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  // What Roo heard ("remind me to buy flowers in Jayanagar"), for Describe your day to read at once.
  const [addText, setAddText] = useState<{ text: string; key: number } | null>(null)
  const addLoaded = useLoadedOnce(addOpen)
  const addBefore = useRef<DayView | null>(null)
  const [tripsOpen, setTripsOpen] = useState(false)
  const [mapSeq, setMapSeq] = useState<number | null>(null)
  // Simulated bookings: the train ticket or cab being booked, and the booking being viewed.
  const bookingsOn = useBookingsEnabled()
  const ai = useAiHelperEnabled()
  const bookings = useBookings(bookingsOn ? current.tripId : null)
  const [trainFor, setTrainFor] = useState<Task | null>(null)
  const [cabFor, setCabFor] = useState<{ toId: string; name: string } | null>(null)
  const [viewing, setViewing] = useState<Booking | null>(null)
  const bookingLoaded = useLoadedOnce(!!trainFor || !!cabFor || !!viewing)
  const tripsLoaded = useLoadedOnce(tripsOpen)
  const logLoaded = useLoadedOnce(logOpen)
  const shareLoaded = useLoadedOnce(shareOpen)
  const stopLoaded = useLoadedOnce(!!stop)
  const confirmLoaded = useLoadedOnce(confirmEarly)
  useDocumentTitle(trip ? `Today in ${trip.cityName}` : 'Today')

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

  // The automatic-shift banner belongs to the plan it announced: a newer plan clears it.
  const planVersion = view?.version ?? null
  useEffect(() => {
    if (autoBanner?.version != null && planVersion != null && planVersion > autoBanner.version) setState({ autoBanner: null })
  }, [autoBanner, planVersion])

  // "Leave now" is about one leg: once its leave-by time has passed on the trip clock, it goes.
  const leaveLeg = leaveNow?.seq != null ? (view?.legs.find((l) => l.seq === leaveNow.seq) ?? null) : null
  const leaveExpired = !!leaveNow && leaveNow.seq != null && !!view && (!leaveLeg || leaveLeg.status === 'done' || clock > leaveLeg.leaveMin)
  useEffect(() => {
    if (leaveExpired) setState({ leaveNow: null })
  }, [leaveExpired])

  // Roo on the timeline asks for "Add a task" or "Edit this stop"; do it here, then clear the request.
  const routerLocation = useRouterLocation()
  useEffect(() => {
    const ask = routerLocation.state as { add?: number; addText?: string; stop?: string; bookTrain?: string } | null
    if (!ask || !view) return
    // Without the AI helper, a task is added with the form on Plan (and the request goes with it).
    if (ask.add && !ai) return void navigate('/plan', { state: { addTask: true } })
    if (ask.add) {
      addBefore.current = view
      setAddText(ask.addText ? { text: ask.addText, key: ask.add } : null)
      setAddOpen(true)
    }
    if (ask.stop) setStop(view.stops.find((s) => s.id === ask.stop) ?? null)
    if (ask.bookTrain) setTrainFor(trip?.tasks.find((t) => t.taskId === ask.bookTrain) ?? null)
    navigate(routerLocation.pathname, { replace: true, state: null })
  }, [routerLocation.state, view]) // eslint-disable-line react-hooks/exhaustive-deps

  const { guide, roads, places, fix } = useDayGuide(trip, tripClock)
  const { tracking } = useLocation()
  const activeSeq = guide?.leg.seq ?? view?.nextLeg?.seq ?? view?.legs[view.legs.length - 1]?.seq ?? null
  const selectedSeq = desktop ? (selected && view?.legs.some((l) => l.seq === selected) ? selected : activeSeq) : null
  const selectedLeg = view?.legs.find((l) => l.seq === selectedSeq) ?? null

  // Legs along the roads; on the leg being ridden, what's behind the traveller is greyed.
  const rideLines = (l: LegView): MapLine[] => {
    // The leg that matters now carries the moving flow.
    const active = guide?.leg.seq === l.seq
    if (guide?.riding && active && guide.progress && guide.progress.offRouteM < 300) {
      const { behind, ahead } = splitPath(guide.path, guide.progress)
      const mode = l.segments.find((s) => s.mode !== 'walk')?.mode ?? l.segments[0]?.mode ?? 'cab'
      return [
        { id: `${l.seq}-behind`, coords: behind, mode, dim: true },
        { id: `${l.seq}-ahead`, coords: ahead, mode, active: true },
      ]
    }
    return legLines(l, places, l.status === 'done', roads.get(l.seq)).map((line) => ({ ...line, active }))
  }
  const mapLines = useMemo(() => (view ? view.legs.flatMap(rideLines) : []), [view, places, roads, guide]) // eslint-disable-line react-hooks/exhaustive-deps
  // Stops as pins: what's done fades, where you are is yellow, the next stop is green and pulses.
  const pinState = (s: StopView) => (s.status === 'done' ? 'done' : guide?.to.id === s.id ? 'next' : s.status === 'now' ? 'current' : 'later') as MapPoint['state']
  const mapPoints = useMemo(() => {
    if (!view) return []
    const pts: MapPoint[] = view.stops
      .filter((s) => s.kind !== 'end' && places.has(s.placeId))
      .map((s) => ({ id: s.id, lngLat: places.get(s.placeId)!, kind: 'stop' as const, label: `${s.title}, ${s.area}`, icon: stopIcon(s.title, s.kind), caption: s.title, state: pinState(s) }))
    // With the phone's location on, the live blue dot shows where the traveller is instead.
    const here = places.get(view.stops[view.nowIndex]?.placeId ?? '')
    return here && !fix ? [...pts, { id: 'me', lngLat: here, kind: 'user' as const, label: 'Where you are, by your check-ins' }] : pts
  }, [view, places, fix, guide?.to.id]) // eslint-disable-line react-hooks/exhaustive-deps
  // While riding, a card on the map says how far is left and when you'll get there.
  const eta = guide?.riding
    ? {
        primary: guide.remainingM != null ? `${distanceLabel(guide.remainingM)} · ${duration(guide.etaMin!)}` : `Arrive around ${guide.leg.arriveAt}`,
        secondary: `To ${guide.to.kind === 'end' ? 'your stay' : `the ${lowerFirst(guide.to.title)}`}${guide.remainingM != null ? `, arrive around ${guide.leg.arriveAt}` : ''}`,
      }
    : null
  const focus = useMemo(() => (selectedLeg ? (roads.get(selectedLeg.seq) ?? legLines(selectedLeg, places).flatMap((l) => l.coords)) : undefined), [selectedLeg, places, roads])
  // The phone's mini map: just the leg that matters now.
  const miniLines = useMemo(() => (guide ? rideLines(guide.leg) : []), [guide, places, roads]) // eslint-disable-line react-hooks/exhaustive-deps
  const miniPoints = useMemo(() => {
    if (!guide) return []
    return [guide.leg.fromPlaceId, guide.leg.toPlaceId].flatMap((id, i) => {
      const p = places.get(id)
      const stop = view?.stops.find((s) => s.id === (i ? guide.leg.toId : guide.leg.fromId))
      return p
        ? [{ id: `mini-${i}`, lngLat: p, kind: 'stop' as const, label: i ? guide.to.title : 'Start of this leg', icon: stop ? stopIcon(stop.title, stop.kind) : MapPin, state: (i ? 'next' : 'later') as MapPoint['state'] }]
        : []
    })
  }, [guide, places])

  if (current.isPending || (tripQ.isPending && !!current.tripId)) return <TodaySkeleton />
  if ((current.isError || tripQ.isError) && !trip) {
    return (
      <div className="mx-auto max-w-[560px] px-5 pt-6">
        <h1 tabIndex={-1} className="t-display-1 text-ink">
          <T k="Today" />
        </h1>
        <div className="mt-6">
          {online ? (
            <ErrorState message={<T k="Couldn't load your plan. Check your connection and try again." />} onRetry={() => (current.tripId ? tripQ.refetch() : current.refetch())} />
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
        <h1 tabIndex={-1} className="t-display-1 text-ink">
          <T k="Today" />
        </h1>
        <EmptyState
          illustration={
            <span className="inline-flex size-14 items-center justify-center rounded-full bg-green-tint">
              <MapPinned size={28} strokeWidth={1.75} className="text-green-ink" aria-hidden="true" />
            </span>
          }
          title="No trip yet"
          body="Add your tasks and Reroute works out the order, when to leave and what it costs."
          action={
            <ButtonLink to="/plan">
              <T k="Plan my day" />
            </ButtonLink>
          }
        />
      </div>
    )
  }

  const onLeg = (leg: LegView) => (desktop ? setSelected(leg.seq) : navigate(`/leg/${leg.seq}`))
  // The day as it looked when "Add to today" opened, so the change plays once the tasks are in.
  const openAdd = () => {
    // Without the AI helper, a task is added with the form on Plan, and the day re-plans from there.
    if (!ai) return navigate('/plan', { state: { addTask: true } })
    addBefore.current = view
    setAddOpen(true)
  }
  const header = (
    <TodayHeader trip={trip} status={status} onLog={() => setLogOpen(true)} onShare={() => setShareOpen(true)} onAdd={online ? openAdd : undefined} onTrips={() => setTripsOpen(true)} />
  )
  const tripSheets = (
    <Suspense fallback={null}>
      {bookingLoaded && trainFor && (
        <TrainBookingSheet
          key={trainFor.taskId}
          trip={trip}
          task={trainFor}
          open
          onOpenChange={(o) => !o && setTrainFor(null)}
          onBooked={(b) => {
            setTrainFor(null)
            setViewing(b)
          }}
        />
      )}
      {bookingLoaded && cabFor && (
        <CabBookingSheet
          key={cabFor.toId}
          trip={trip}
          toId={cabFor.toId}
          toName={cabFor.name}
          open
          onOpenChange={(o) => !o && setCabFor(null)}
          onBooked={(b) => {
            setCabFor(null)
            setViewing(b)
          }}
        />
      )}
      {bookingLoaded && <BookingSheet trip={trip} booking={viewing} onOpenChange={(o) => !o && setViewing(null)} />}
      {tripsLoaded && <TripSwitcher open={tripsOpen} onOpenChange={setTripsOpen} />}
      {logLoaded && <RerouteLog trip={trip} open={logOpen} onOpenChange={setLogOpen} />}
      {shareLoaded && <ShareSheet trip={trip} open={shareOpen} onOpenChange={setShareOpen} />}
      {addLoaded && (
        <AiPlannerSheet
          key={addText?.key ?? 'add'}
          trip={trip}
          initialText={addText?.text}
          open={addOpen}
          onOpenChange={setAddOpen}
          onAdded={(n, outcome) => {
            setAddOpen(false)
            const what = `Added ${n === 1 ? '1 task' : `${n} tasks`}.`
            if (outcome === 'replanned') playLater(() => applyServerChange(trip.tripId, addBefore.current, { kind: 'reroute', toast: `${what} Your day is updated.`, undo: true }))
            else if (outcome === 'pending') playLater(() => playTaskEdit(trip.tripId, addBefore.current, 'pending'))
            else {
              showToast({ title: `${what} Plan the day to fit ${n === 1 ? 'it' : 'them'} in.` })
              navigate('/plan')
            }
          }}
        />
      )}
    </Suspense>
  )

  if (!view) {
    return (
      <div className="mx-auto max-w-[560px] px-5 pt-6 lg:max-w-[720px] lg:px-8">
        {header}
        <EmptyState
          illustration={
            <span className="inline-flex size-14 items-center justify-center rounded-full bg-green-tint">
              <Route size={28} strokeWidth={1.75} className="text-green-ink" aria-hidden="true" />
            </span>
          }
          title="No plan for today yet"
          body="Add your tasks and Reroute works out the order, when to leave and what it costs."
          action={
            <ButtonLink to="/plan">
              <T k="Plan my day" />
            </ButtonLink>
          }
        />
        {tripSheets}
      </div>
    )
  }

  const started = !!startedTo && startedTo.tripId === trip.tripId && startedTo.toId === view.nextLeg?.toId
  const bannerUndo = undoVersionOf(trip)
  const track = async () => {
    const ok = await startTracking()
    if (!ok)
      showToast({
        title:
          getLocation().error === 'denied'
            ? 'Location is off for Reroute in your browser settings. Your plan works without it.'
            : "Couldn't find your location. Your plan works without it.",
      })
  }

  // The mini map on phones (desktop has the big map beside), and the switch to show the traveller on it.
  const miniMap = guide && (
    <div className="flex flex-col gap-3">
      {!desktop && (
        // The map is a picture of the leg; the link laid over it (not around it) opens the full map and directions.
        <div className="relative">
          <LazyMap compact lines={miniLines} points={miniPoints} label={`Map to ${guide.to.title}`} className="h-36" me={fix} />
          <Link to={`/leg/${guide.leg.seq}`} aria-label={`Map and directions to ${guide.to.title}`} className="absolute inset-x-0 top-0 h-36 rounded-card" />
        </div>
      )}
      {guide.riding && !tracking && geolocationSupported && (
        <Button variant="secondary" size="md" className="self-start" icon={<LocateFixed size={20} strokeWidth={1.75} aria-hidden="true" />} onClick={() => void track()}>
          Show me on the map
        </Button>
      )}
    </div>
  )

  const banners = (
    <div className="flex flex-col gap-2 empty:hidden">
      {!online && (
        <Banner tone="offline">
          <T k="You're offline. Your plan still works, and changes sync when you're back." />
        </Banner>
      )}
      {queued.length > 0 && <Banner tone="info">{queued.length === 1 ? 'One check-in is waiting to sync.' : `${queued.length} check-ins are waiting to sync.`}</Banner>}
      {trip.openOptions && (
        <Banner
          tone="blocked"
          action={
            <Button variant="destructive" size="md" onClick={() => openLate(null, 'options')}>
              <T k="See the options" />
            </Button>
          }
        >
          {trip.openOptions.explanation || 'Your later stops no longer fit. Choose how to fix the rest of today.'}
        </Banner>
      )}
      {leaveNow && !leaveExpired && (
        <Banner tone="info" action={dismissButton(() => setState({ leaveNow: null }))}>
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
            <span className="flex items-center">
              {bannerUndo !== null && (
                <button type="button" className="min-h-12 rounded-control px-3 t-title underline decoration-2 underline-offset-4" onClick={() => void undo(trip.tripId, bannerUndo)}>
                  <T k="Undo" />
                </button>
              )}
              {dismissButton(() => setState({ autoBanner: null }))}
            </span>
          }
        >
          {autoBanner.text}
        </Banner>
      )}
    </div>
  )

  // One button, one meaning. Still at the last stop: "I've left". On the way or there: "Mark done".
  const target = view.checkInTask
  const targetStop = target ? (view.stops.find((s) => s.id === target.taskId) ?? null) : null
  const leg = view.nextLeg
  const leaving = !!leg && !started && targetStop?.status !== 'now'
  // Marking a task done long before it starts is more likely a slip than a fact: ask first.
  const early = !!targetStop && targetStop.time - clock > 10
  const doCheckIn = () => (early ? setConfirmEarly(true) : checkIn(trip.tripId, view, clock))
  const leave = () => {
    if (!leg) return
    setState({ started: { tripId: trip.tripId, toId: leg.toId, day: trip.day, at: clock } })
    showToast({ title: leg.toId === 'end' ? 'On your way back. Safe travels.' : `On your way. You should arrive around ${leg.arriveAt}.` })
    // Follow the ride on the map, and say when they're nearly there. Asks for location once.
    if (geolocationSupported && !tracking) void track()
  }
  const doneName = target ? tl('the {task}', { task: lowerFirst(target.title) }) : null

  const primary = leaving ? (
    <Button variant="primary" onClick={leave} icon={<Navigation size={20} strokeWidth={1.75} aria-hidden="true" />}>
      <T k="I've left" />
    </Button>
  ) : target ? (
    <Button variant="primary" onClick={doCheckIn} icon={<CircleCheck size={20} strokeWidth={1.75} aria-hidden="true" />}>
      <T k="Mark done" />
      <span className="sr-only" lang={doneName?.lang}>
        : {doneName?.text}
      </span>
    </Button>
  ) : (
    <Button variant="secondary" disabled>
      On your way back
    </Button>
  )

  const actions = !view.done && (
    <div className="grid grid-cols-2 gap-3">
      <Button variant="destructive" onClick={() => openLate()} disabled={!target}>
        <T k="Running late" />
      </Button>
      {primary}
    </div>
  )

  // Each leg's own mini map on phones (desktop shows the selected leg on the big map beside the
  // timeline). One at a time: phones only allow a few live maps at once.
  const legPins = (leg: LegView): MapPoint[] =>
    [leg.fromId, leg.toId].flatMap((id, i) => {
      const stop = view.stops.find((s) => s.id === id)
      const at = places.get(i ? leg.toPlaceId : leg.fromPlaceId)
      return stop && at ? [{ id: `leg-${leg.seq}-${i}`, lngLat: at, kind: 'stop' as const, label: stop.title, icon: stopIcon(stop.title, stop.kind), state: i ? 'next' : 'later' }] : []
    })
  const linkButton = '-ml-1 inline-flex min-h-12 items-center gap-1.5 rounded-control px-1 t-small font-bold text-ink underline decoration-2 underline-offset-4'
  const legMap = (leg: LegView) => {
    if (leg.status === 'done') return null
    const open = mapSeq === leg.seq
    const to = view.stops.find((s) => s.id === leg.toId)
    const regionId = `leg-map-${leg.seq}`
    // A booked ride shows its driver, plate and OTP; otherwise the leg offers a (demo) cab.
    const ride = activeBooking(bookings.data, { toId: leg.toId })
    // Only the next leg carries its actions on the timeline, so the day reads as a line, not a list of
    // buttons. Every other leg's map and cab are a tap away in its leg details.
    if (!ride && !open && leg.seq !== activeSeq) return null
    if (samePlace(leg)) return null
    return (
      <div className="mt-1.5">
        <div className="flex flex-wrap items-center gap-x-4">
          {!desktop && (
            <button type="button" aria-expanded={open} aria-controls={open ? regionId : undefined} onClick={() => setMapSeq(open ? null : leg.seq)} className={linkButton}>
              <MapIcon size={18} strokeWidth={1.75} aria-hidden="true" />
              {open ? 'Hide map' : 'Map'}
            </button>
          )}
          {ride ? (
            <button type="button" onClick={() => setViewing(ride)} className="inline-flex min-h-12 items-center gap-2 rounded-full border border-green bg-green-tint px-3 t-small font-bold text-ink">
              <CarTaxiFront size={18} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
              {String(ride.details.providerLabel)}, {String(ride.details.plate)}, OTP {String(ride.details.otp)}
            </button>
          ) : bookingsOn && (
            <button type="button" onClick={() => setCabFor({ toId: leg.toId, name: to?.title ?? 'the next stop' })} className={linkButton}>
              <Car size={18} strokeWidth={1.75} aria-hidden="true" />
              Book a cab
            </button>
          )}
        </div>
        {open && (
          <div id={regionId} className="relative mt-1">
            <LazyMap compact lines={rideLines(leg)} points={legPins(leg)} label={`Map to ${to?.title ?? 'the next stop'}`} className="h-44" me={fix} />
            <Link to={`/leg/${leg.seq}`} aria-label={`Full map and directions to ${to?.title ?? 'the next stop'}`} className="absolute inset-x-0 top-0 h-44 rounded-card" />
          </div>
        )}
      </div>
    )
  }

  // A train task offers its (demo) ticket; once booked, the stop shows the PNR and status.
  const trainExtra = (taskId: string) => {
    const task = trip.tasks.find((t) => t.taskId === taskId)
    if (!bookingsOn || !task || !isTrainTask(task) || task.state === 'done') return null
    const ticket = activeBooking(bookings.data, { taskId: task.taskId })
    return ticket ? (
      <button type="button" onClick={() => setViewing(ticket)} className="mt-1 inline-flex min-h-12 items-center gap-2 rounded-full border border-green bg-green-tint px-3 t-small font-bold text-ink">
        <Ticket size={18} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
        PNR {ticket.reference}, {String(ticket.details.bookingStatus)}
      </button>
    ) : (
      <button type="button" onClick={() => setTrainFor(task)} className={`mt-1 ${linkButton}`}>
        <TrainFront size={18} strokeWidth={1.75} aria-hidden="true" />
        Book train ticket
      </button>
    )
  }

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
      departedFrom={guide?.riding ? guide.leg.fromId : null}
      legExtra={legMap}
      taskExtra={trainExtra}
    />
  )
  const estimates = <p className="mt-2 t-small text-muted">Times and fares are estimates.</p>

  const sheets = (
    <>
      {tripSheets}
      <Suspense fallback={null}>
        {stopLoaded && <TaskSheet trip={trip} view={view} clock={clock} stop={stop} onClose={() => setStop(null)} />}
        {confirmLoaded && target && targetStop && (
          <CheckInConfirm
            open={confirmEarly}
            onOpenChange={setConfirmEarly}
            title={target.title}
            start={targetStop.time}
            clock={clock}
            onConfirm={() => {
              setConfirmEarly(false)
              checkIn(trip.tripId, view, clock)
            }}
          />
        )}
      </Suspense>
    </>
  )

  if (desktop) {
    return (
      <div className="mx-auto grid max-w-[1440px] grid-cols-[420px_minmax(0,1fr)] gap-8 px-8">
        <section aria-label="Your day" className="flex min-h-[calc(100dvh-64px)] flex-col pt-8">
          {header}
          <div className="mt-5 flex flex-col gap-4">
            {banners}
            <NextCard view={view} clock={clock} guide={guide} miniMap={miniMap} />
            <NotInPlan trip={trip} view={view} />
          </div>
          <div className="mt-8 flex-1">
            {timeline}
            {estimates}
          </div>
          <div className="sticky bottom-0 z-20 -mx-8 mt-4 border-t border-line bg-ground px-8 py-4">
            {actions || (
              <ButtonLink to="/summary">
                <T k="See the day summary" />
              </ButtonLink>
            )}
          </div>
        </section>
        <section aria-label="Map and leg detail" className="sticky top-16 flex h-[calc(100dvh-64px)] flex-col gap-4 overflow-y-auto py-8">
          <LazyMap lines={mapLines} points={mapPoints} focus={focus} label="Map of today's route" className="h-[44vh] min-h-72 shrink-0" draw={revealing} me={fix} eta={eta} />
          {selectedLeg && (
            <Suspense fallback={<Skeleton className="h-96 w-full shrink-0 rounded-card" />}>
              <LegDetailContent key={selectedLeg.seq} trip={trip} leg={selectedLeg} embedded />
            </Suspense>
          )}
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
          <NextCard view={view} clock={clock} guide={guide} miniMap={miniMap} />
          <NotInPlan trip={trip} view={view} />
        </div>
        <div className="mt-8">
          {timeline}
          {estimates}
        </div>
        {view.done && (
          <div className="mt-2 pb-6">
            <ButtonLink to="/summary" variant="secondary" full>
              <T k="See the day summary" />
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
