import { ChevronLeft, Clock, History, IndianRupee, Navigation, ShieldCheck, TriangleAlert } from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'
import { lazy, Suspense, useMemo, useState, type ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router'
import { api, ApiError, newKey } from '@/api/client'
import { keys, queryClient, useCurrentTripId, useDay, useRaastaRoute, useTrip } from '@/api/queries'
import type { RaastaRoute, Trip } from '@/api/types'
import { MODE_META, ModeIcon } from '@/components/icons'
import { ModeChain } from '@/components/timeline/ModeChain'
import { Button, ButtonLink } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'
import { Sheet } from '@/components/ui/Sheet'
import { Banner, EmptyState, ErrorState, LoadingRegion, Skeleton } from '@/components/ui/States'
import { Tag } from '@/components/ui/Tag'
import { duration, lowerFirst, rupees } from '@/lib/format'
import { legLines, placeIndex, routeLine, type LngLat, type MapLine } from '@/lib/geo'
import { useDocumentTitle, useIsDesktop } from '@/lib/hooks'
import { T } from '@/lib/i18n'
import { setState, showToast, useStore } from '@/lib/store'
import type { LegView } from '@/lib/timeline'
import type { Mode } from '@/lib/types'

const MapCard = lazy(() => import('@/components/MapCard'))

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

function modelForLeg(trip: Trip, leg: LegView, route?: RaastaRoute): DetailModel {
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
    lines: legLines(leg, places, false, path),
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

export function DetailBody({ model, embedded, onBack, nowIso }: { model: DetailModel; embedded?: boolean; onBack?: () => void; nowIso?: string }) {
  const navigate = useNavigate()
  const [confirmed, setConfirmed] = useState<number | null>(null)
  const [report, setReport] = useState(false)
  const [fare, setFare] = useState('')
  const [fareError, setFareError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [sendingFare, setSendingFare] = useState(false)
  const [confirmKey] = useState(() => newKey('cnf'))
  // One key per fare report: a retry of the same report reuses it; the next report gets a new one.
  const [fareKey, setFareKey] = useState(() => newKey('fare'))
  const r = model.route
  const leg = model.leg
  const started = useStore((s) => s.startedSeq)

  const start = () => {
    if (!leg) return
    setState({ startedSeq: leg.seq })
    showToast({ title: `Leg started. Get off at ${model.alight}.` })
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
      setFareKey(newKey('fare'))
      setReport(false)
      setFare('')
      setFareError(undefined)
      showToast({ title: `Thanks. We'll check the ${rupees(n)} fare.` })
    } catch (err) {
      setFareError(err instanceof ApiError ? err.message : "Couldn't send the fare. Try again.")
    } finally {
      setSendingFare(false)
    }
  }

  return (
    <div className={embedded ? 'rounded-card border border-line bg-surface p-6' : ''}>
      <header className="flex items-start gap-2">
        {onBack && (
          <button type="button" onClick={onBack} aria-label="Back" className="-ml-3 flex size-12 shrink-0 items-center justify-center rounded-control text-ink [@media(hover:hover)]:hover:bg-sunken">
            <ChevronLeft size={24} strokeWidth={1.75} aria-hidden="true" />
          </button>
        )}
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
        <StandLine board={model.board} alight={model.alight} alightNote={model.alightNote} mode={model.segments[0].mode} />
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
      <p className="mt-2 t-small text-muted">Times and fares are estimates.</p>

      <div className="mt-6 flex flex-wrap gap-3">
        {r && (
          <Button variant="secondary" disabled={confirmed !== null} loading={busy} loadingLabel="Sending…" onClick={confirm}>
            {confirmed !== null ? 'Confirmed' : <T k="It still runs" />}
          </Button>
        )}
        {leg && leg.status !== 'done' && (
          <Button variant="primary" icon={<Navigation size={20} strokeWidth={1.75} aria-hidden="true" />} onClick={start} disabled={started === leg.seq}>
            {started === leg.seq ? 'Leg started' : <T k="Start this leg" />}
          </Button>
        )}
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
          <Suspense fallback={<Skeleton className="h-64 w-full rounded-card" />}>
            <MapCard lines={model.lines} points={model.points} label={`Map of ${model.title}`} className="h-64" />
          </Suspense>
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

export function LegDetailContent({ trip, leg, embedded }: { trip: Trip; leg: LegView; embedded?: boolean }) {
  const route = useRaastaRoute(leg.raasta?.routeId)
  const model = useMemo(() => modelForLeg(trip, leg, route.data), [trip, leg, route.data])
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.24 }}>
      <DetailBody model={model} embedded={embedded} nowIso={trip.now} />
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
      transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
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
  const navigate = useNavigate()
  const leg = view?.legs.find((l) => String(l.seq) === seq)
  const route = useRaastaRoute(leg?.raasta?.routeId)
  const back = () => (window.history.state?.idx > 0 ? navigate(-1) : navigate('/'))
  const model = useMemo(() => (leg && tripQ.data ? modelForLeg(tripQ.data, leg, route.data) : null), [leg, tripQ.data, route.data])
  useDocumentTitle(model?.title ?? 'Leg')
  return (
    <PushedScreen>
      {tripQ.isPending || (leg?.raasta && route.isPending) ? (
        <DetailSkeleton />
      ) : tripQ.isError && !tripQ.data ? (
        <ErrorState message="Couldn't load this leg. Check your connection and try again." onRetry={() => tripQ.refetch()} />
      ) : model ? (
        <>
          {leg?.raasta && route.isError && (
            <div className="mb-4">
              <Banner tone="offline">Couldn't load the route's latest details. The directions below still work.</Banner>
            </div>
          )}
          <DetailBody model={model} onBack={back} nowIso={tripQ.data?.now} />
        </>
      ) : (
        <EmptyState title="This leg isn't in your plan" body="Your day may have changed since you opened it." action={<ButtonLink to="/">Go to Today</ButtonLink>} />
      )}
    </PushedScreen>
  )
}
