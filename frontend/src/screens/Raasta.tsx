import { ChevronLeft, MapPin, Plus, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { api, ApiError } from '@/api/client'
import { useCurrentTripId, useDay, useRaastaRoute, useStands, useTrip } from '@/api/queries'
import type { Place, RaastaLegOption, RaastaLegOptions } from '@/api/types'
import { ModeIcon, MODE_META, modeTextClass } from '@/components/icons'
import { Button, ButtonLink } from '@/components/ui/Button'
import { Field, FieldError } from '@/components/ui/Field'
import { Banner, EmptyState, ErrorState, LoadingRegion, Skeleton } from '@/components/ui/States'
import { Tag } from '@/components/ui/Tag'
import { rupees } from '@/lib/format'
import { useOnline } from '@/lib/hooks'
import { useT } from '@/lib/i18n'
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
async function resolve(text: string, city: string, cityName: string): Promise<Place | null> {
  const found = await api.get<Place[]>('/v1/places', { query: { q: text, city, cityName } })
  return found[0] ?? null
}

export default function RaastaHome() {
  const t = useT()
  const online = useOnline()
  const current = useCurrentTripId()
  const tripQ = useTrip(current.tripId)
  const trip = tripQ.data
  const view = useDay(trip)
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
    return { name: p.area, near: `${p.lng},${p.lat}` }
  }, [trip, view])
  const stands = useStands(here?.near ?? null, 2000)

  const find = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!from.trim() || !to.trim()) return setError('Enter where you start and where you want to go.')
    setError(undefined)
    setSearching(true)
    try {
      const a = fromPoint && fromPoint.name === from ? fromPoint : await resolve(from, city, cityName)
      const b = await resolve(to, city, cityName)
      if (!a || !b) {
        setError(`We couldn't find ${!a ? from : to} in ${cityName}. Try an area name, like Koramangala.`)
        return
      }
      const data = await api.get<RaastaLegOptions>('/v1/raasta/routes', { query: { from: `${a.lng},${a.lat}`, to: `${b.lng},${b.lat}`, at: new Date().toISOString() } })
      setResults({ from: a.name, to: b.name, data })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't search. Try again.")
    } finally {
      setSearching(false)
    }
  }

  return (
    <div className="mx-auto max-w-[560px] px-5 pb-10 pt-6 lg:max-w-[720px] lg:px-8 lg:pt-8">
      <h1 className="t-display-1 text-ink">{t('Raasta')}</h1>
      <p className="measure mt-1 t-body text-ink-2">Shared autos, e-rickshaws and tempos, mapped and checked by riders.</p>
      {!online && (
        <div className="mt-4">
          <Banner tone="offline">You're offline. Routes you've already opened still work.</Banner>
        </div>
      )}

      <form className="mt-6 rounded-card border border-line bg-surface p-5" role="search" onSubmit={find}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('Where from?')} value={from} onChange={(e) => setFrom(e.target.value)} autoComplete="off" hint="A stand or area, like Koramangala" />
          <Field label={t('Where to?')} value={to} onChange={(e) => setTo(e.target.value)} autoComplete="off" hint="Like Jayanagar" />
        </div>
        {error && <FieldError id="raasta-err">{error}</FieldError>}
        <Button type="submit" className="mt-4" loading={searching} loadingLabel="Finding routes…" icon={<Search size={20} strokeWidth={1.75} aria-hidden="true" />} disabled={!online}>
          Find routes
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
            <EmptyState title="Nobody has added this route yet" body="If you know the shared auto or e-rickshaw, add it. Riders check every route before it's verified." action={<ButtonLink to="/raasta/add">{t('Add a route')}</ButtonLink>} />
          )}
        </section>
      )}

      <section className="mt-8" aria-labelledby="nearby-h">
        <h2 id="nearby-h" className="t-display-2 text-ink">
          {t('Nearby stands')}
        </h2>
        {here && <p className="mt-1 t-small text-muted">Near {here.name}. Tap one to search from it.</p>}
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

      <div className="mt-8">
        <ButtonLink to="/raasta/add" variant="primary" icon={<Plus size={20} strokeWidth={1.75} aria-hidden="true" />}>
          {t('Add a route')}
        </ButtonLink>
      </div>
    </div>
  )
}

export function RaastaRoute() {
  const { routeId } = useParams()
  const q = useRaastaRoute(routeId)
  const navigate = useNavigate()
  const model = useMemo(() => (q.data ? modelForRoute(q.data) : null), [q.data])
  const back = () => (window.history.state?.idx > 0 ? navigate(-1) : navigate('/raasta'))
  const notFound = q.error instanceof ApiError && q.error.status === 404
  return (
    <PushedScreen>
      {q.isPending ? (
        <DetailSkeleton />
      ) : notFound ? (
        <EmptyState title="This route isn't on Raasta" body="It may have been removed after checking." action={<ButtonLink to="/raasta">Go to Raasta</ButtonLink>} />
      ) : q.isError && !q.data ? (
        <>
          <button type="button" onClick={back} aria-label="Back" className="-ml-3 flex size-12 items-center justify-center rounded-control text-ink">
            <ChevronLeft size={24} strokeWidth={1.75} aria-hidden="true" />
          </button>
          <ErrorState message="Couldn't load this route. Check your connection and try again." onRetry={() => q.refetch()} />
        </>
      ) : model ? (
        <DetailBody model={model} onBack={back} />
      ) : null}
    </PushedScreen>
  )
}
