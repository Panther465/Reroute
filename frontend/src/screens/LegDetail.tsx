import { CarTaxiFront, Clock, History, IndianRupee, Navigation, Ruler, ShieldCheck, TriangleAlert } from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'
import { EASE_OUT } from '@/lib/motion'
import { useSubmitKey } from '@/lib/submitKey'
import { lazy, Suspense, useMemo, useState, type ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router'
import { api, ApiError } from '@/api/client'
import { keys, queryClient, useBookings, useBookingsEnabled, useCurrentTripId, useDay, useRaastaRoute, useTrip } from '@/api/queries'
import type { Booking, RaastaRoute, Trip } from '@/api/types'
import { BackButton, useBack } from '@/components/BackButton'
import { LazyMap } from '@/components/LazyMap'
import { MODE_META, ModeIcon } from '@/components/icons'
import { ModeChain } from '@/components/timeline/ModeChain'
import { Button, ButtonLink } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'
import { Sheet } from '@/components/ui/Sheet'
import { Banner, EmptyState, ErrorState, LoadingRegion, Skeleton } from '@/components/ui/States'
import { Tag } from '@/components/ui/Tag'
import { duration, lowerFirst, rupees } from '@/lib/format'
import { legLines, placeIndex, routeLine, type LngLat, type MapLine } from '@/lib/geo'
import { useLocation as useLiveLocation } from '@/lib/location'
import { activeBooking } from '@/lib/bookings'
import { useRoadPaths } from '@/lib/roads'
import { useDocumentTitle, useIsDesktop } from '@/lib/hooks'
import { T } from '@/lib/i18n'
import { setState, showToast, useStore } from '@/lib/store'
import { localMinutes, samePlace, type LegView } from '@/lib/timeline'
import type { Mode } from '@/lib/types'

const CabBookingSheet = lazy(() => import('./BookingSheets').then((m) => ({ default: m.CabBookingSheet })))
const BookingSheet = lazy(() => import('./BookingSheets').then((m) => ({ default: m.BookingSheet })))

const ORDINAL = ['', '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th']

/** "3 days ago" from an ISO date-time, against the trip clock when we have one. */
function ago(iso: string | null | undefined, nowIso?: string) {
  if (!iso) return 'Not yet'
  const days = Math.floor((Date.parse(nowIso ?? new Date().toISOString()) - Date.parse(iso)) / 86_400_000)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  return `${days} days ago`
}

function StandLine({ board, alight, alightNote, mode }: { board: string; alight: string; alightNote: string; mode: Mode }) {
  const tone = MODE_META[mode].tone
  const color = tone === 'blue' ? 'bg-blue' : tone === 'green' ? 'bg-green' : 'bg-ink'
  return (
    <ol className="relative" aria-label="Stands">
      <span aria-hidden="true" className={`absolute bottom-3 left-[9px] top-3 w-1.5 ${color}`} />
      {[
        { label: 'Board here', name: board },
        { label: alightNote, name: alight },
      ].map((s, i) => (
        <li key={i} className={`relative flex gap-4 ${i === 0 ? 'pb-6' : ''}`}>
          <span aria-hidden="true" className="relative z-10 mt-1 block size-6 shrink-0 rounded-full border-[3px] border-ink bg-surface" />
          <span>
            <span className="block t-title text-ink">{s.label}</span>
            <span className="block t-small text-ink-2">{s.name}</span>
          </span>
        </li>
      ))}
    </ol>
  )
}

function Fact({ icon, term, children }: { icon: ReactNode; term: string; children: ReactNode }) {
  return (
    // dt and dd must sit directly in the div that groups them (axe: definition-list, dlitem).
    <div className="relative py-3 pl-8">
      <dt className="t-small text-muted">
        <span className="absolute left-0 top-3.5 text-muted" aria-hidden="true">
          {icon}
        </span>
        <T k={term} />
      </dt>
      <dd className="min-w-0 t-body text-ink tnum">{children}</dd>
    </div>
  )
}

interface DetailModel {
  title: string
  subtitle: string
  segments: LegView['segments']
  board: string
  alight: string
  alightNote: string
  steps: string[]
  route?: RaastaRoute
  fare: string
  leg?: LegView
  lines: MapLine[]
  points: { id: string; lngLat: LngLat; kind: 'stand' | 'stop' | 'user'; label: string }[]
}

function stopName(trip: Trip, placeId: string) {
  if (placeId === trip.stayPlace.placeId) return { name: trip.stayPlace.name, area: trip.stayPlace.area, short: 'Hotel' }
  const t = trip.tasks.find((x) => x.placeId === placeId)
  return t ? { name: t.place.name, area: t.place.area, short: t.place.area } : { name: placeId, area: '', short: placeId }
}

/** Written directions first: the map is never the only way to follow a route. */
export function directionsFor(leg: LegView, from: { name: string; area: string }, to: { name: string; area: string }, route?: RaastaRoute): string[] {
  if (route && route.stands.length >= 2) {
    const first = route.stands[0]
    const last = route.stands[route.stands.length - 1]
    const vehicle = MODE_META[route.vehicleType].label.toLowerCase()
    const between = route.stands.slice(1, -1).map((s) => s.name)
    return [
      `Walk to ${first.name}.`,
      `Board a ${vehicle} going towards ${last.name.replace(/ stand$/, '')}. Pay about ${rupees(route.fareInr)} to the driver.`,
      ...(between.length ? [`Ride past ${between.join(' and ')}.`] : []),
      `Get off at ${last.name}, the ${ORDINAL[route.stands.length - 1] ?? `${route.stands.length - 1}th`} stop.`,
      `Walk to ${to.name}.`,
    ]
  }
  const steps: string[] = []
  leg.segments.forEach((s, i) => {
    if (s.mode === 'walk') steps.push(i === leg.segments.length - 1 ? `Walk about ${duration(s.minutes)} to ${to.name}.` : `Walk about ${duration(s.minutes)}.`)
    else if (s.mode === 'metro') steps.push(`Take the metro for about ${duration(s.minutes)}${i === leg.segments.length - 1 ? `, towards ${to.area}` : ''}.`)
    else if (s.mode === 'cab') steps.push(`Book a cab from ${from.name} to ${to.name}, ${to.area}. It takes about ${duration(s.minutes)}. Check the meter or the app fare.`)
    else steps.push(`Take a ${MODE_META[s.mode].label.toLowerCase()} for the last stretch, about ${duration(s.minutes)}. Ask for ${to.area}.`)
  })
  if (leg.segments[leg.segments.length - 1]?.mode !== 'walk' && leg.segments[leg.segments.length - 1]?.mode !== 'cab') steps.push(`Get off near ${to.name}.`)
  return steps
}

function modelForLeg(trip: Trip, leg: LegView, route?: RaastaRoute, road?: LngLat[]): DetailModel {
  const from = stopName(trip, leg.fromPlaceId)
  const to = stopName(trip, leg.toPlaceId)
  const places = placeIndex(trip)
  const path: LngLat[] | undefined = route?.stands.map((s) => [s.location.lng, s.location.lat])
  const n = route ? route.stands.length - 1 : 0
  return {
    title: `${from.short} to ${to.short}`,
    subtitle: `${leg.label}, about ${duration(leg.travelMin)}`,
    segments: leg.segments,
    board: route ? route.stands[0].name : from.name,
    alight: route ? route.stands[route.stands.length - 1].name : to.name,
    alightNote: route ? `Get off here, ${ORDINAL[n] ?? `${n}th`} stop` : 'Get off here',
    steps: directionsFor(leg, from, to, route),
    route,
    fare: route ? `About ${rupees(route.fareInr)} a person` : leg.fareInr ? `About ${rupees(leg.fareInr)} in total` : 'Free',
    leg,
    // A Raasta route follows its stands; any other leg follows the roads once its path has loaded.
    lines: legLines(leg, places, false, path ?? road),
    points: [
      ...(places.get(leg.fromPlaceId) ? [{ id: 'a', lngLat: places.get(leg.fromPlaceId)!, kind: 'stop' as const, label: from.name }] : []),
      ...(route ? route.stands.map((s) => ({ id: s.standId, lngLat: [s.location.lng, s.location.lat] as LngLat, kind: 'stand' as const, label: s.name })) : []),
      ...(places.get(leg.toPlaceId) ? [{ id: 'b', lngLat: places.get(leg.toPlaceId)!, kind: 'stop' as const, label: to.name }] : []),
    ],
  }
}

export function modelForRoute(route: RaastaRoute): DetailModel {
  const first = route.stands[0]?.name ?? 'Start'
  const last = route.stands[route.stands.length - 1]?.name ?? 'End'
  const mode: Mode = route.vehicleType
  const n = route.stands.length - 1
  const seg = { mode, minutes: 0 }
  const fakeLeg = { segments: [seg] } as unknown as LegView
  return {
    title: `${first.replace(/ stand$/, '')} to ${last.replace(/ stand$/, '')}`,
    subtitle: `${MODE_META[route.vehicleType].label}, about every ${route.frequencyMin} min`,
    segments: [seg],
    board: first,
    alight: last,
    alightNote: n === 1 ? 'Get off here, next stop' : `Get off here, ${ORDINAL[n] ?? `${n}th`} stop`,
    steps: directionsFor(fakeLeg, { name: first, area: '' }, { name: last, area: '' }, route).slice(0, -1),
    route,
    fare: `About ${rupees(route.fareInr)} a person`,
    lines: routeLine(
      route.routeId,
      (route.path.length > 1 ? route.path : route.stands.map((s) => s.location)).map((p) => [p.lng, p.lat] as LngLat),
      mode,
    ),
    points: route.stands.map((s) => ({ id: s.standId, lngLat: [s.location.lng, s.location.lat] as LngLat, kind: 'stand' as const, label: s.name })),
  }
}

export function StatusTag({ status }: { status: RaastaRoute['status'] }) {
  if (status === 'verified')
    return (
      <Tag tone="green" icon={<ShieldCheck size={14} strokeWidth={1.75} aria-hidden="true" />}>
        <T k="Verified" />
      </Tag>
    )
  if (status === 'stale')
    return (
      <Tag tone="red" icon={<TriangleAlert size={14} strokeWidth={1.75} aria-hidden="true" />}>
        Not confirmed lately
      </Tag>
    )
  return (
    <Tag tone="grey-outline">
      <T k="Unverified" />
    </Tag>
  )
}

export function DetailBody({ model, embedded, onBack, nowIso, trip }: { model: DetailModel; embedded?: boolean; onBack?: () => void; nowIso?: string; trip?: Trip }) {
  const navigate = useNavigate()
  const [confirmed, setConfirmed] = useState<number | null>(null)
  const [report, setReport] = useState(false)
  const [fare, setFare] = useState('')
  const [fareError, setFareError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [sendingFare, setSendingFare] = useState(false)
  const { key: confirmKey, after: afterConfirm } = useSubmitKey('cnf')
  // One key per fare report: a retry of the same report reuses it; the next report gets a new one.
  const { key: fareKey, renew: renewFareKey, after: afterFare } = useSubmitKey('fare')
  const r = model.route
  const leg = model.leg
  const { fix } = useLiveLocation()
  const tripId = useCurrentTripId().tripId
  const startedTo = useStore((s) => (s.started && s.started.tripId === tripId ? s.started.toId : null))
  const isStarted = !!leg && startedTo === leg.toId

  const start = () => {
    if (!leg || !tripId) return
    // The trip clock, as Today records it (the server's `now` can carry microseconds, so it isn't sliced apart).
    setState({ started: { tripId, toId: leg.toId, day: trip?.day, at: trip ? localMinutes(trip.now, trip.day, trip.utcOffset) : undefined } })
    showToast({ title: `On your way. Get off at ${model.alight}.` })
    if (!embedded) navigate('/')
  }

  const confirm = async () => {
    if (!r) return
    setBusy(true)
    try {
      const res = await api.post<{ confirmationsCount: number }>(`/v1/raasta/routes/${r.routeId}/confirmations`, {}, { idempotencyKey: confirmKey })
      setConfirmed(res.confirmationsCount)
      void queryClient.invalidateQueries({ queryKey: keys.route(r.routeId) })
      showToast({ title: 'Thanks. You confirmed this route still runs.' })
    } catch (err) {
      afterConfirm(err)
      showToast({ title: err instanceof ApiError ? err.message : "Couldn't send that. Try again." })
    } finally {
      setBusy(false)
    }
  }

  const sendFare = async () => {
    if (!r) return
    const n = Number(fare)
    if (!fare || !Number.isInteger(n) || n <= 0 || n > 2000) return setFareError('Enter the fare you paid, in whole rupees, between 1 and 2,000.')
    setSendingFare(true)
    try {
      await api.post(`/v1/raasta/routes/${r.routeId}/fare-reports`, { fareInr: n }, { idempotencyKey: fareKey })
      renewFareKey()
      setReport(false)
      setFare('')
      setFareError(undefined)
      showToast({ title: `Thanks. We'll check the ${rupees(n)} fare.` })
    } catch (err) {
      afterFare(err)
      setFareError(err instanceof ApiError ? err.message : "Couldn't send the fare. Try again.")
    } finally {
      setSendingFare(false)
    }
  }

  return (
    <div className={embedded ? 'rounded-card border border-line bg-surface p-6' : ''}>
      <header className="flex items-start gap-2">
        {onBack && <BackButton onClick={onBack} />}
        <div className="min-w-0 pt-1">
          {embedded ? (
            <h2 className="t-display-2 text-ink">{model.title}</h2>
          ) : (
            <h1 tabIndex={-1} className="t-display-1 text-ink">
              {model.title}
            </h1>
          )}
          <p className="mt-1 flex items-center gap-2 t-body text-ink-2">
            <ModeChain segments={model.segments} />
            {model.subtitle}
          </p>
        </div>
      </header>

      {r && (
        <div className="mt-4 flex flex-wrap gap-2">
          <StatusTag status={r.status} />
          <Tag tone="grey-outline">From Raasta</Tag>
          {r.sample && <Tag tone="grey-outline">Sample route</Tag>}
        </div>
      )}
      {r?.status === 'stale' && (
        <div className="mt-4">
          <Banner tone="blocked">Nobody has confirmed this route lately. It may have stopped running. Ask at the stand before you wait.</Banner>
        </div>
      )}
      {r?.status === 'unverified' && <p className="mt-3 t-small text-ink-2">Riders haven't checked this route yet. Check the fare with the driver.</p>}

      <section className="mt-6" aria-labelledby="stands-h">
        <h2 id="stands-h" className="sr-only">
          Stands
        </h2>
        {model.segments.length > 0 ? (
          <StandLine board={model.board} alight={model.alight} alightNote={model.alightNote} mode={model.segments[0].mode} />
        ) : (
          <p className="t-body text-ink-2">You're already there: this stop is at the same place as the last one, so there's nothing to travel.</p>
        )}
      </section>

      <section className="mt-6" aria-labelledby="dir-h">
        <h2 id="dir-h" className="t-title text-ink">
          Directions
        </h2>
        <ol className="mt-3 flex flex-col gap-3">
          {model.steps.map((step, i) => (
            <li key={i} className="flex gap-3">
              <span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center rounded-full bg-sunken t-caption text-ink tnum">
                {i + 1}
              </span>
              <span className="measure t-body text-ink">
                <span className="sr-only">Step {i + 1}: </span>
                {step}
              </span>
            </li>
          ))}
        </ol>
      </section>

      <dl className="mt-6 grid grid-cols-1 divide-y divide-line border-y border-line sm:grid-cols-2 sm:divide-y-0">
        <Fact icon={<IndianRupee size={20} strokeWidth={1.75} />} term="Fare">
          {model.fare}
        </Fact>
        {r ? (
          <>
            <Fact icon={<Clock size={20} strokeWidth={1.75} />} term="How often">
              About every {r.frequencyMin} min
            </Fact>
            <Fact icon={<ModeIcon mode={r.vehicleType} />} term="Last one">
              Around {r.lastTrip}
            </Fact>
            <Fact icon={<History size={20} strokeWidth={1.75} />} term="Last confirmed">
              {confirmed !== null ? `Just now, by ${confirmed} riders` : `${ago(r.lastConfirmedAt, nowIso)}, by ${r.confirmationsCount} ${r.confirmationsCount === 1 ? 'rider' : 'riders'}`}
            </Fact>
          </>
        ) : (
          leg && (
            <>
              <Fact icon={<Clock size={20} strokeWidth={1.75} />} term="Leave by">
                {leg.leaveBy}
              </Fact>
              <Fact icon={<Navigation size={20} strokeWidth={1.75} />} term="Arrive">
                Around {leg.arriveAt}
              </Fact>
            </>
          )
        )}
      </dl>
      <p className="mt-2 flex gap-2 t-small text-muted">
        {leg?.rough && <Ruler size={16} strokeWidth={2} aria-hidden="true" className="mt-0.5 shrink-0" />}
        {leg?.rough
          ? 'A rough estimate from the distance: Reroute has no travel data for this place yet. Allow extra time, and check the fare in your cab app.'
          : 'Times and fares are estimates.'}
      </p>

      <div className="mt-6 flex flex-wrap gap-3">
        {r && (
          <Button variant="secondary" disabled={confirmed !== null} loading={busy} loadingLabel="Sending…" onClick={confirm}>
            {confirmed !== null ? 'Confirmed' : <T k="It still runs" />}
          </Button>
        )}
        {leg && leg.status !== 'done' && (
          <Button variant="primary" icon={<Navigation size={20} strokeWidth={1.75} aria-hidden="true" />} onClick={start} disabled={isStarted}>
            {isStarted ? 'On your way' : <T k="I've left" />}
          </Button>
        )}
        {leg && trip && <LegCab trip={trip} leg={leg} />}
      </div>
      {r && (
        <p className="mt-3">
          <Button variant="tertiary" size="md" className="-ml-2" onClick={() => setReport(true)}>
            <T k="Report a fare" />
          </Button>
        </p>
      )}

      {!embedded && (
        <div className="mt-6">
          <LazyMap lines={model.lines} points={model.points} label={`Map of ${model.title}`} className="h-64" me={fix} />
        </div>
      )}

      <Sheet
        open={report}
        onOpenChange={(o) => !sendingFare && setReport(o)}
        title={<T k="Report a fare" />}
        description={`What did you pay on ${lowerFirst(model.title)}? A moderator checks reports before the fare changes.`}
        footer={
          <Button full onClick={sendFare} loading={sendingFare} loadingLabel="Sending…">
            <T k="Send the fare" />
          </Button>
        }
      >
        <Field label="Fare you paid, in rupees" inputMode="numeric" type="number" value={fare} onChange={(e) => setFare(e.target.value)} error={fareError} />
      </Sheet>
    </div>
  )
}

/** A (demo) cab for this leg, or the ride already booked for it. Today offers it on the next leg only. */
function LegCab({ trip, leg }: { trip: Trip; leg: LegView }) {
  const bookingsOn = useBookingsEnabled()
  const bookings = useBookings(bookingsOn ? trip.tripId : null)
  const [booking, setBooking] = useState(false)
  const [viewing, setViewing] = useState<Booking | null>(null)
  const [loaded, setLoaded] = useState(false)
  if (!bookingsOn || leg.status === 'done' || samePlace(leg)) return null
  const ride = activeBooking(bookings.data, { toId: leg.toId })
  const to = leg.toId === 'end' ? trip.stayPlace.name : (trip.tasks.find((t) => t.taskId === leg.toId)?.title ?? 'the next stop')
  return (
    <>
      <Button
        variant="secondary"
        icon={<CarTaxiFront size={20} strokeWidth={1.75} aria-hidden="true" />}
        onClick={() => {
          setLoaded(true)
          if (ride) setViewing(ride)
          else setBooking(true)
        }}
      >
        {ride ? 'Your ride' : 'Book a cab'}
      </Button>
      {loaded && (
        <Suspense fallback={null}>
          {booking && (
            <CabBookingSheet
              trip={trip}
              toId={leg.toId}
              toName={to}
              open
              onOpenChange={(o) => !o && setBooking(false)}
              onBooked={(b) => {
                setBooking(false)
                setViewing(b)
              }}
            />
          )}
          <BookingSheet trip={trip} booking={viewing} onOpenChange={(o) => !o && setViewing(null)} />
        </Suspense>
      )}
    </>
  )
}

export function LegDetailContent({ trip, leg, embedded }: { trip: Trip; leg: LegView; embedded?: boolean }) {
  const route = useRaastaRoute(leg.raasta?.routeId)
  const places = useMemo(() => placeIndex(trip), [trip])
  const road = useRoadPaths([leg], places).get(leg.seq)
  const model = useMemo(() => modelForLeg(trip, leg, route.data, road), [trip, leg, route.data, road])
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.24 }}>
      <DetailBody model={model} embedded={embedded} nowIso={trip.now} trip={trip} />
    </motion.div>
  )
}

export function PushedScreen({ children }: { children: ReactNode }) {
  const desktop = useIsDesktop()
  const reduce = useReducedMotion()
  return (
    <motion.div
      initial={desktop || reduce ? { opacity: 0 } : { x: '100%' }}
      animate={{ x: 0, opacity: 1 }}
      transition={{ duration: 0.24, ease: EASE_OUT }}
      className="mx-auto max-w-[560px] px-5 pt-4 lg:max-w-[720px] lg:px-8 lg:pt-8"
    >
      {children}
    </motion.div>
  )
}

export function DetailSkeleton() {
  return (
    <LoadingRegion label="Loading the route">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="mt-2 h-5 w-48" />
      <Skeleton className="mt-6 h-24 w-full" />
      <Skeleton className="mt-6 h-40 w-full" />
    </LoadingRegion>
  )
}

export default function LegDetail() {
  const { seq } = useParams()
  const current = useCurrentTripId()
  const tripQ = useTrip(current.tripId)
  const view = useDay(tripQ.data)
  const leg = view?.legs.find((l) => String(l.seq) === seq)
  const route = useRaastaRoute(leg?.raasta?.routeId)
  const back = useBack('/')
  const legPlaces = useMemo(() => (tripQ.data ? placeIndex(tripQ.data) : new Map()), [tripQ.data])
  const road = useRoadPaths(leg ? [leg] : [], legPlaces).get(leg?.seq ?? -1)
  const model = useMemo(() => (leg && tripQ.data ? modelForLeg(tripQ.data, leg, route.data, road) : null), [leg, tripQ.data, route.data, road])
  useDocumentTitle(model?.title ?? 'Leg')
  const loading = tripQ.isPending || (leg?.raasta && route.isPending)
  return (
    <PushedScreen>
      {model && !loading ? (
        <>
          {leg?.raasta && route.isError && (
            <div className="mb-4">
              <Banner tone="offline">Couldn't load the route's latest details. The directions below still work.</Banner>
            </div>
          )}
          <DetailBody model={model} onBack={back} nowIso={tripQ.data?.now} trip={tripQ.data} />
        </>
      ) : (
        // Every other state keeps a way back: this screen has no tab bar.
        <>
          <BackButton onClick={back} className="mb-2" />
          {loading ? (
            <DetailSkeleton />
          ) : tripQ.isError && !tripQ.data ? (
            <ErrorState message="Couldn't load this leg. Check your connection and try again." onRetry={() => tripQ.refetch()} />
          ) : (
            <EmptyState title="This leg isn't in your plan" body="Your day may have changed since you opened it." action={<ButtonLink to="/">Go to Today</ButtonLink>} />
          )}
        </>
      )}
    </PushedScreen>
  )
}
