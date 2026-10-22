import { Hotel, MapPin, Plus, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router'
import { api, ApiError } from '@/api/client'
import { useCurrentTripId, useDay, useRaastaRoute, useStands, useTrip } from '@/api/queries'
import type { Place, RaastaLegOption, RaastaLegOptions } from '@/api/types'
import { BackButton, useBack } from '@/components/BackButton'
import { LazyMap } from '@/components/LazyMap'
import type { MapPoint } from '@/components/MapCard'
import { AutoRickshaw, ModeIcon, MODE_META, modeTextClass } from '@/components/icons'
import { Button, ButtonLink } from '@/components/ui/Button'
import { Field, FieldError } from '@/components/ui/Field'
import { Banner, EmptyState, ErrorState, LoadingRegion, Skeleton } from '@/components/ui/States'
import { Tag } from '@/components/ui/Tag'
import { rupees } from '@/lib/format'
import { useDocumentTitle, useIsDesktop, useOnline, useTripClock } from '@/lib/hooks'
import { T, useTl } from '@/lib/i18n'
import { localMinutes } from '@/lib/timeline'
import { DetailBody, DetailSkeleton, modelForRoute, PushedScreen, StatusTag } from './LegDetail'

function distanceLabel(m: number) {
  return m < 1000 ? `${Math.round(m / 50) * 50} m` : `${(m / 1000).toFixed(1)} km`
}

function OptionRow({ o, extra }: { o: RaastaLegOption; extra?: boolean }) {
  return (
    <li>
      <Link to={`/raasta/route/${o.routeId}`} className="flex items-start gap-3 px-4 py-4 [@media(hover:hover)]:hover:bg-sunken/60">
        <ModeIcon mode={o.vehicleType} size={24} className={`mt-0.5 shrink-0 ${modeTextClass(o.vehicleType)}`} />
        <span className="min-w-0 flex-1">
          <span className="block t-title text-ink">
            {o.board.name} to {o.alight.name}
          </span>
          <span className="mt-1 flex flex-wrap gap-x-3 t-small text-ink-2 tnum">
            <span>{MODE_META[o.vehicleType].label}</span>
            <span>About {rupees(o.fareInr)} a person</span>
            <span>About every {o.frequencyMin} min</span>
            <span>Last one around {o.lastTrip}</span>
            <span>
              Walk about {o.walkFromMin} min, then {o.walkToMin} min
            </span>
          </span>
          <span className="mt-2 flex flex-wrap gap-2">
            <StatusTag status={o.status} />
            {extra && <Tag tone="grey-outline">Shown as an extra</Tag>}
            {o.sample && <Tag tone="grey-outline">Sample route</Tag>}
          </span>
        </span>
      </Link>
    </li>
  )
}

/** Turn typed text into a point: the first place search match in the trip's city. */
async function resolve(text: string, city: string): Promise<Place | null> {
  const found = await api.get<Place[]>('/v1/places', { query: { q: text, city } })
  return found[0] ?? null
}

export default function RaastaHome() {
  const tl = useTl()
  const online = useOnline()
  const current = useCurrentTripId()
  const tripQ = useTrip(current.tripId)
  const trip = tripQ.data
  const serverNow = trip ? localMinutes(trip.now, trip.day, trip.utcOffset) : null
  const clock = useTripClock(serverNow, tripQ.dataUpdatedAt, trip?.clockSimulated ?? false)
  const view = useDay(trip, clock)
  useDocumentTitle('Raasta')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [fromPoint, setFromPoint] = useState<{ name: string; lng: number; lat: number } | null>(null)
  const [results, setResults] = useState<{ from: string; to: string; data: RaastaLegOptions } | null>(null)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string>()

  const city = trip?.citySlug ?? 'bengaluru'
  const cityName = trip?.cityName ?? 'Bengaluru'
  const here = useMemo(() => {
    if (!trip) return null
    const stop = view?.stops[view.nowIndex]
    const task = trip.tasks.find((x) => x.placeId === stop?.placeId)
    const p = task?.place ?? trip.stayPlace
    return { name: p.area, near: `${p.lng},${p.lat}`, lng: p.lng, lat: p.lat, stay: !task }
  }, [trip, view])
  const stands = useStands(here?.near ?? null, 2000)
  // A desktop has room for the stands on a map, next to their list.
  const desktop = useIsDesktop()
  const standPoints = useMemo<MapPoint[]>(() => {
    if (!here || !stands.data) return []
    return [
      { id: 'here', kind: 'stop', lngLat: [here.lng, here.lat], label: here.name, caption: here.name, icon: here.stay ? Hotel : MapPin, state: 'current' },
      ...stands.data.items.map((st): MapPoint => ({
        id: st.standId,
        kind: 'stand',
        lngLat: [st.location.lng, st.location.lat],
        label: st.name,
        onClick: () => {
          setFrom(st.name)
          setFromPoint({ name: st.name, lng: st.location.lng, lat: st.location.lat })
        },
      })),
    ]
  }, [here, stands.data])

  type Point = { name: string; lng: number; lat: number }
  const searchBetween = async (resolveEnds: () => Promise<[Point | null, Point | null]>) => {
    setError(undefined)
    setSearching(true)
    try {
      const [a, b] = await resolveEnds()
      if (!a || !b) {
        setError(`We couldn't find ${!a ? from : to} in ${cityName}. Try an area name, like Koramangala.`)
        return
      }
      // "Last one has gone" follows the trip clock (the demo clock too), not the phone's.
      const at = trip && serverNow !== null && clock !== null ? new Date(Date.parse(trip.now) + (clock - serverNow) * 60_000).toISOString() : new Date().toISOString()
      const data = await api.get<RaastaLegOptions>('/v1/raasta/routes', { query: { from: `${a.lng},${a.lat}`, to: `${b.lng},${b.lat}`, at } })
      setResults({ from: a.name, to: b.name, data })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't search. Try again.")
    } finally {
      setSearching(false)
    }
  }

  const find = (e: React.FormEvent) => {
    e.preventDefault()
    if (!from.trim() || !to.trim()) return setError('Enter where you start and where you want to go.')
    void searchBetween(async () => [fromPoint && fromPoint.name === from ? fromPoint : await resolve(from, city), await resolve(to, city)])
  }

  // The leg the traveller takes next, ready to search: Raasta in service of the day, not beside it.
  const next = useMemo(() => {
    const leg = view?.nextLeg
    if (!trip || !leg) return null
    const placeOf = (id: string) => (trip.stayPlace.placeId === id ? trip.stayPlace : (trip.tasks.find((t) => t.placeId === id)?.place ?? null))
    const a = placeOf(leg.fromPlaceId)
    const b = placeOf(leg.toPlaceId)
    return a && b ? { a, b, leaveBy: leg.leaveBy } : null
  }, [trip, view])
  const searchNext = () => {
    if (!next) return
    setFrom(next.a.area)
    setTo(next.b.area)
    setFromPoint({ name: next.a.area, lng: next.a.lng, lat: next.a.lat })
    void searchBetween(async () => [
      { name: next.a.area, lng: next.a.lng, lat: next.a.lat },
      { name: next.b.area, lng: next.b.lng, lat: next.b.lat },
    ])
  }

  return (
    // On a desktop: find a route on the left; the stands around you, on a map, on the right.
    <div className="mx-auto max-w-[560px] px-5 pb-10 pt-6 lg:grid lg:max-w-[1200px] lg:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)] lg:items-start lg:gap-x-12 lg:px-8 lg:pt-8">
      <div className="min-w-0">
      <h1 tabIndex={-1} className="t-display-1 text-ink">
        <T k="Raasta" />
      </h1>
      <p className="measure mt-1 t-body text-ink-2">Shared autos, e-rickshaws and tempos, mapped and checked by riders. Reroute uses the verified ones when it plans your day: they're often the cheapest way across town.</p>
      {!online && (
        <div className="mt-4">
          <Banner tone="offline">You're offline. Routes you've already opened still work.</Banner>
        </div>
      )}
      {next && (
        <button
          type="button"
          onClick={searchNext}
          disabled={!online || searching}
          className="mt-6 flex w-full items-center gap-3 rounded-card border border-green bg-surface p-4 text-left transition-colors duration-[var(--dur-quick)] [@media(hover:hover)]:hover:enabled:bg-green-tint active:enabled:bg-green-tint disabled:opacity-60"
        >
          <AutoRickshaw size={28} className="shrink-0 text-green" />
          <span className="min-w-0 flex-1">
            <span className="block t-caption text-green-ink">Your next leg, leave {next.leaveBy}</span>
            <span className="block t-title text-ink">
              {next.a.area} to {next.b.area}
            </span>
          </span>
          <span className="t-small font-bold text-ink underline decoration-2 underline-offset-4">Find routes</span>
        </button>
      )}

      <form className="mt-6 rounded-card border border-line bg-surface p-5" role="search" onSubmit={find}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={tl('Where from?').text} labelLang={tl('Where from?').lang} value={from} onChange={(e) => setFrom(e.target.value)} autoComplete="off" hint="A stand or area, like Koramangala" />
          <Field label={tl('Where to?').text} labelLang={tl('Where to?').lang} value={to} onChange={(e) => setTo(e.target.value)} autoComplete="off" hint="Like Jayanagar" />
        </div>
        {error && <FieldError id="raasta-err">{error}</FieldError>}
        <Button type="submit" className="mt-4" loading={searching} loadingLabel="Finding routes…" icon={<Search size={20} strokeWidth={1.75} aria-hidden="true" />} disabled={!online}>
          <T k="Find routes" />
        </Button>
      </form>

      {results && (
        <section className="mt-8" aria-labelledby="results-h" aria-live="polite">
          <h2 id="results-h" className="t-display-2 text-ink">
            {results.data.items.length ? `${results.data.items.length} ${results.data.items.length === 1 ? 'route' : 'routes'}` : 'No checked routes yet'}
          </h2>
          <p className="mt-1 t-small text-muted">
            {results.from} to {results.to}
          </p>
          {results.data.items.length > 0 && (
            <ul className="mt-4 divide-y divide-line overflow-hidden rounded-card border border-line bg-surface">
              {results.data.items.map((o) => (
                <OptionRow key={o.routeId} o={o} />
              ))}
            </ul>
          )}
          {results.data.lastTripPassed.length > 0 && <p className="mt-3 t-small text-ink-2">{results.data.lastTripPassed.length === 1 ? 'One more route serves this trip, but its last one has gone for today.' : `${results.data.lastTripPassed.length} more routes serve this trip, but their last ones have gone for today.`}</p>}
          {results.data.extras.length > 0 && (
            <>
              <h3 className="mt-6 t-title text-ink">Not checked yet</h3>
              <p className="t-small text-ink-2">Riders added these but they aren't verified, or nobody has confirmed them lately. Ask at the stand.</p>
              <ul className="mt-3 divide-y divide-line overflow-hidden rounded-card border border-line bg-surface">
                {results.data.extras.map((o) => (
                  <OptionRow key={o.routeId} o={o} extra />
                ))}
              </ul>
            </>
          )}
          {results.data.items.length === 0 && results.data.extras.length === 0 && (
            <EmptyState title="Nobody has added this route yet" body="If you know the shared auto or e-rickshaw, add it. Riders check every route before it's verified." action={
                <ButtonLink to="/raasta/add">
                  <T k="Add a route" />
                </ButtonLink>
              } />
          )}
        </section>
      )}

      </div>

      <div className="min-w-0 lg:sticky lg:top-24">
      <section className="mt-8 lg:mt-2" aria-labelledby="nearby-h">
        <h2 id="nearby-h" className="t-display-2 text-ink">
          <T k="Nearby stands" />
        </h2>
        {here && <p className="mt-1 t-small text-muted">Near {here.name}. Tap one to search from it.</p>}
        {desktop && standPoints.length > 1 && <LazyMap lines={[]} points={standPoints} label={`Map of stands near ${here?.name ?? 'you'}`} className="mt-4 h-72" />}
        {stands.isPending && here ? (
          <LoadingRegion label="Loading stands">
            <Skeleton className="mt-4 h-48 w-full rounded-card" />
          </LoadingRegion>
        ) : stands.isError && !stands.data ? (
          <div className="mt-4">{online ? <ErrorState message="Couldn't load nearby stands. Check your connection and try again." onRetry={() => stands.refetch()} /> : <Banner tone="offline">You're offline and no stands are saved on this phone yet.</Banner>}</div>
        ) : stands.data && stands.data.items.length > 0 ? (
          <ul className="mt-4 divide-y divide-line overflow-hidden rounded-card border border-line bg-surface">
            {stands.data.items.map((s) => (
              <li key={s.standId}>
                <button
                  type="button"
                  onClick={() => {
                    setFrom(s.name)
                    setFromPoint({ name: s.name, lng: s.location.lng, lat: s.location.lat })
                  }}
                  className="flex w-full items-start gap-3 px-4 py-4 text-left [@media(hover:hover)]:hover:bg-sunken/60"
                >
                  <MapPin size={20} strokeWidth={1.75} aria-hidden="true" className="mt-0.5 shrink-0 text-muted" />
                  <span className="min-w-0 flex-1">
                    <span className="block t-title text-ink">{s.name}</span>
                    <span className="block t-small text-ink-2">
                      {distanceLabel(s.distanceM)} away{s.sample ? ', sample stand' : ''}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 t-body text-ink-2">No stands mapped within 2 km yet.</p>
        )}
      </section>

      <div className="mt-8 lg:mt-6">
        <ButtonLink to="/raasta/add" variant="primary" icon={<Plus size={20} strokeWidth={1.75} aria-hidden="true" />}>
          <T k="Add a route" />
        </ButtonLink>
      </div>
      </div>
    </div>
  )
}

export function RaastaRoute() {
  const { routeId } = useParams()
  const q = useRaastaRoute(routeId)
  const model = useMemo(() => (q.data ? modelForRoute(q.data) : null), [q.data])
  useDocumentTitle(model?.title ?? 'Raasta route')
  const back = useBack('/raasta')
  const notFound = q.error instanceof ApiError && q.error.status === 404
  return (
    <PushedScreen wide={!!model}>
      {model ? (
        <DetailBody model={model} onBack={back} />
      ) : (
        // Every other state keeps a way back: this screen has no tab bar.
        <>
          <BackButton onClick={back} className="mb-2" />
          {q.isPending ? (
            <DetailSkeleton />
          ) : notFound ? (
            <EmptyState title="This route isn't on Raasta" body="It may have been removed after checking." action={<ButtonLink to="/raasta">Go to Raasta</ButtonLink>} />
          ) : (
            <ErrorState message="Couldn't load this route. Check your connection and try again." onRetry={() => q.refetch()} />
          )}
        </>
      )}
    </PushedScreen>
  )
}
