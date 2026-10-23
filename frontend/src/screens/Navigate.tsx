import {
  ArrowUp,
  ArrowUpLeft,
  ArrowUpRight,
  CornerLeftDown,
  CornerRightDown,
  CornerUpLeft,
  CornerUpRight,
  ExternalLink,
  LocateFixed,
  LogIn,
  LogOut,
  MapPin,
  Navigation,
  RotateCw,
  TrainFront,
  Undo2,
  Volume2,
  VolumeX,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router'
import { useCurrentTripId, useTrip } from '@/api/queries'
import { BackButton, useBack } from '@/components/BackButton'
import { LazyMap } from '@/components/LazyMap'
import type { MapPoint } from '@/components/MapCard'
import { Button, ButtonLink, buttonClass } from '@/components/ui/Button'
import { Banner, EmptyState, LoadingRegion, Skeleton } from '@/components/ui/States'
import { useDayGuide } from '@/lib/dayAlerts'
import { duration, lowerFirst } from '@/lib/format'
import { googleMapsUrl, travelMode } from '@/lib/gmaps'
import { destName } from '@/lib/guide'
import { useDocumentTitle, useTripClock } from '@/lib/hooks'
import { geolocationSupported, startTracking } from '@/lib/location'
import { course, follow, START, type NavStep, type Tracker, type Where } from '@/lib/navigate'
import { pathLines, stationDots } from '@/lib/paths'
import { distanceLabel } from '@/lib/progress'
import { phoneSay } from '@/lib/speech/phoneVoice'
import { getState, setState, showToast, useStore } from '@/lib/store'
import { localMinutes, samePlace } from '@/lib/timeline'
import type { TurnIcon } from '@/lib/turns'
import { PushedScreen } from './LegDetail'

const ICONS: Record<TurnIcon, LucideIcon> = {
  depart: Navigation,
  straight: ArrowUp,
  left: CornerUpLeft,
  right: CornerUpRight,
  'slight-left': ArrowUpLeft,
  'slight-right': ArrowUpRight,
  'sharp-left': CornerLeftDown,
  'sharp-right': CornerRightDown,
  uturn: Undo2,
  // India drives on the left: roundabouts go clockwise.
  roundabout: RotateCw,
  arrive: MapPin,
  board: LogIn,
  alight: LogOut,
}

/** Say an instruction this far ahead of it on foot (on a ride, as soon as it's the next one). */
const SAY_WITHIN_M = 150

function StepIcon({ step, size = 20 }: { step: NavStep; size?: number }) {
  const Icon = step.icon === 'board' && /\bLine\b/.test(step.text) ? TrainFront : ICONS[step.icon]
  return <Icon size={size} strokeWidth={2} aria-hidden="true" />
}

/**
 * Turn by turn for one leg: the next instruction large, every step in order, the map following you, and
 * Google Maps a tap away. Your position stays on the phone, and turns are spoken with the phone's own voice.
 */
export default function Navigate() {
  const { seq } = useParams()
  const back = useBack(`/leg/${seq}`)
  const current = useCurrentTripId()
  const tripQ = useTrip(current.tripId)
  const trip = tripQ.data
  const serverNow = trip ? localMinutes(trip.now, trip.day, trip.utcOffset) : null
  const tripClock = useTripClock(serverNow, tripQ.dataUpdatedAt, trip?.clockSimulated ?? false)
  const { view, guide, places, fix, paths } = useDayGuide(trip, tripClock)
  const leg = view?.legs.find((l) => String(l.seq) === seq)
  const to = leg && view ? view.stops.find((s) => s.id === leg.toId) : undefined
  const drawn = leg ? paths.get(leg.seq) : undefined
  const toName = to ? destName(to) : 'the next stop'
  useDocumentTitle(to ? `To ${to.title}` : 'Directions')

  const c = useMemo(() => (drawn?.segments.length ? course(drawn, toName) : null), [drawn, toName])
  const tracker = useRef<Tracker>(START)
  const [where, setWhere] = useState<Where | null>(null)
  useEffect(() => {
    tracker.current = START
    setWhere(null)
  }, [c])
  useEffect(() => {
    if (!c || !fix) return
    const w = follow(c, tracker.current, fix, where)
    if (w && w !== where) {
      tracker.current = w.tracker
      setWhere(w)
    }
    // A new fix moves the traveller along.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c, fix?.lng, fix?.lat, fix?.accuracy])

  const tripId = current.tripId
  const startedTo = useStore((s) => (s.started && s.started.tripId === tripId ? s.started.toId : null))
  const here = guide?.leg.seq === leg?.seq ? guide : null
  const riding = !!here?.riding || (!!leg && startedTo === leg.toId)
  const arrived = !!here?.arrived
  const next = c ? c.steps[where?.next ?? 0] : null

  // Spoken turns: the phone's own voice, so no street name ever goes to a server with your position.
  const [speak, setSpeak] = useState(false)
  const said = useRef(-1)
  useEffect(() => {
    if (!speak || !next || !where || said.current === where.next) return
    if (c?.walking && where.toNextM > SAY_WITHIN_M) return
    said.current = where.next
    phoneSay(where.toNextM > 30 ? `In ${distanceLabel(where.toNextM)}, ${lowerFirst(next.text)}` : next.text, getState().alerts)
  }, [speak, next, where, c])

  if (tripQ.isPending) {
    return (
      <PushedScreen>
        <LoadingRegion label="Loading the directions">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="mt-6 h-64 w-full" />
        </LoadingRegion>
      </PushedScreen>
    )
  }
  if (!trip || !leg || !to) {
    return (
      <PushedScreen>
        <BackButton onClick={back} className="mb-2" />
        <EmptyState title="This leg isn't in your plan" body="Your day may have changed since you opened it." action={<ButtonLink to="/">Go to Today</ButtonLink>} />
      </PushedScreen>
    )
  }

  const a = places.get(leg.fromPlaceId)
  const b = places.get(leg.toPlaceId)
  const gmaps = a && b ? googleMapsUrl(fix ? [fix.lng, fix.lat] : a, b, travelMode(leg.segments.map((s) => s.mode)), riding) : null
  const lines = pathLines(leg, drawn, places)
  const points: MapPoint[] = b ? [{ id: 'to', lngLat: b, kind: 'stop', label: to.title, icon: MapPin, caption: to.title, state: 'next' }] : []
  const offRoute = !!where?.tracker.offRoute && !arrived
  const left = () => {
    if (!tripId) return
    setState({ started: { tripId, toId: leg.toId, day: trip.day, at: localMinutes(trip.now, trip.day, trip.utcOffset) } })
    showToast({ title: 'On your way. Follow the steps below.' })
  }

  return (
    <PushedScreen wide>
      {/* On a phone the map comes right after the next instruction (the column's children join this flex box);
          on a desktop it sits beside the steps. */}
      <div className="flex flex-col lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] lg:items-start lg:gap-10">
        <div className="contents lg:block lg:min-w-0">
          <header className="order-1 flex items-start gap-2">
            <BackButton onClick={back} />
            <div className="min-w-0 pt-1">
              <h1 tabIndex={-1} className="t-display-1 text-ink">
                To {to.title}
              </h1>
              <p className="mt-1 t-body text-ink-2">
                {leg.label}, arrive around {leg.arriveAt}
              </p>
            </div>
          </header>

          {/* The next thing to do, large. Announced politely when it changes, not on every fix. */}
          <section aria-labelledby="next-step-h" className="order-2 mt-5 rounded-card border border-line bg-surface p-5">
            <h2 id="next-step-h" className="sr-only">
              Next
            </h2>
            {arrived ? (
              <p className="flex items-center gap-3 t-display-2 text-green-ink">
                <MapPin size={28} strokeWidth={2} aria-hidden="true" />
                You’ve arrived at {toName}
              </p>
            ) : next ? (
              <div className="flex items-start gap-4">
                <span className="flex size-14 shrink-0 items-center justify-center rounded-full bg-blue text-on-blue" aria-hidden="true">
                  <StepIcon step={next} size={28} />
                </span>
                <div className="min-w-0">
                  {where && where.toNextM > 30 && <p className="t-title text-blue tnum">In {distanceLabel(where.toNextM)}</p>}
                  <p className="t-display-2 text-ink">{next.text}</p>
                  {where && (
                    <p className="mt-1 t-small text-ink-2 tnum">
                      {distanceLabel(where.remainingM)} left{here?.etaMin ? `, about ${duration(here.etaMin)}` : ''}
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <p className="t-body text-ink-2">Drawing this leg along the roads… The steps appear in a moment.</p>
            )}
            <p aria-live="polite" className="sr-only">
              {arrived ? `You've arrived at ${toName}.` : next ? next.text : ''}
            </p>
          </section>

          {offRoute && gmaps && (
            <div className="order-2 mt-4">
              <Banner tone="blocked">
                You’re off the route.{' '}
                <a href={gmaps} target="_blank" rel="noopener noreferrer" className="font-bold underline underline-offset-4">
                  Google Maps can find a way from here<span className="sr-only"> (opens in a new tab)</span>
                </a>
                .
              </Banner>
            </div>
          )}

          <div className="order-4 mt-4 flex flex-wrap gap-3">
            {!fix && geolocationSupported && (
              <Button variant="primary" icon={<LocateFixed size={20} strokeWidth={1.75} aria-hidden="true" />} onClick={() => void startTracking()}>
                Follow my location
              </Button>
            )}
            {!riding && !samePlace(leg) && leg.status !== 'done' && (
              <Button variant={fix ? 'primary' : 'secondary'} icon={<Navigation size={20} strokeWidth={1.75} aria-hidden="true" />} onClick={left}>
                I’ve left
              </Button>
            )}
            <Button
              variant="secondary"
              aria-pressed={speak}
              icon={speak ? <Volume2 size={20} strokeWidth={1.75} aria-hidden="true" /> : <VolumeX size={20} strokeWidth={1.75} aria-hidden="true" />}
              onClick={() => setSpeak((on) => !on)}
            >
              Speak turns
            </Button>
            {gmaps && (
              <a href={gmaps} target="_blank" rel="noopener noreferrer" className={buttonClass('tertiary')}>
                <ExternalLink size={20} strokeWidth={1.75} aria-hidden="true" />
                Open in Google Maps<span className="sr-only"> (opens in a new tab)</span>
              </a>
            )}
          </div>
          {!fix && <p className="order-4 mt-2 t-small text-ink-2">Your location stays on this phone. It’s only used to show where you are on the way.</p>}

          {c && (
            <section aria-labelledby="steps-h" className="order-5 mt-6">
              <h2 id="steps-h" className="t-title text-ink">
                Every step
              </h2>
              <ol className="mt-3 flex flex-col gap-1">
                {c.steps.map((step, i) => {
                  const now = i === (where?.next ?? -1) && !arrived
                  const done = !!where && i < where.next
                  return (
                    <li
                      key={i}
                      aria-current={now ? 'step' : undefined}
                      className={`flex items-start gap-3 rounded-control px-2 py-2 ${now ? 'bg-blue-tint' : ''} ${done ? 'text-muted' : 'text-ink'}`}
                    >
                      <span className={`mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full ${now ? 'bg-blue text-on-blue' : 'bg-sunken'}`} aria-hidden="true">
                        <StepIcon step={step} size={16} />
                      </span>
                      <span className="t-body">
                        {done && <span className="sr-only">Done: </span>}
                        {step.text}
                      </span>
                    </li>
                  )
                })}
              </ol>
            </section>
          )}
          <p className="order-5 mt-4 t-small text-muted">Roads from OpenStreetMap. Times are the plan’s estimates; a dashed line has no road directions.</p>
        </div>

        <div className="order-3 mt-4 lg:sticky lg:top-24 lg:order-none lg:mt-0">
          <LazyMap
            lines={lines}
            points={points}
            stations={stationDots([drawn])}
            label={`Map to ${to.title}`}
            className="h-[42vh] min-h-64 lg:h-[min(640px,calc(100dvh-8rem))]"
            me={fix}
            followByDefault
          />
        </div>
      </div>
    </PushedScreen>
  )
}
