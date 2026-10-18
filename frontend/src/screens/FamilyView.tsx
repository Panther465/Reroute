import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router'
import { ApiError } from '@/api/client'
import { useShared } from '@/api/queries'
import { RouteMark } from '@/components/icons'
import { Timeline } from '@/components/timeline/Timeline'
import { Banner, ErrorState, LoadingRegion, Skeleton } from '@/components/ui/States'
import { useOnline } from '@/lib/hooks'
import { addDays, dayLabel, sharedToDay } from '@/lib/timeline'

function useMinutesAgo(iso: string | undefined) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])
  if (!iso) return ''
  const m = Math.max(0, Math.floor((now - Date.parse(iso)) / 60000))
  return m === 0 ? 'Updated just now' : m === 1 ? 'Updated 1 min ago' : m < 60 ? `Updated ${m} min ago` : `Updated ${Math.floor(m / 60)} h ago`
}

/** Public, read-only page at /shared/:token. No navigation, no edit controls, no exact location. */
export default function FamilyView() {
  const { token = '' } = useParams()
  const q = useShared(token)
  const online = useOnline()
  const view = useMemo(() => (q.data ? sharedToDay(q.data) : null), [q.data])
  const updated = useMinutesAgo(q.data?.updatedAt)
  const gone = q.error instanceof ApiError && (q.error.status === 410 || q.error.status === 404)

  return (
    <div className="min-h-dvh bg-ground text-ink">
      <main className="mx-auto max-w-[560px] px-5 pb-12 pt-6">
        <p className="flex items-center gap-2 t-small text-muted">
          <RouteMark size={20} />
          Shared with Reroute
        </p>
        {q.isPending ? (
          <LoadingRegion label="Loading the trip">
            <Skeleton className="mt-4 h-8 w-64" />
            <Skeleton className="mt-2 h-5 w-32" />
            <Skeleton className="mt-8 h-72 w-full" />
          </LoadingRegion>
        ) : gone ? (
          <div className="mt-6">
            <h1 className="t-display-1 text-ink">This trip is no longer shared.</h1>
            <p className="mt-2 t-body text-ink-2">Ask the traveller for a new link if you'd like to follow along.</p>
          </div>
        ) : q.isError && !q.data ? (
          <div className="mt-6">{online ? <ErrorState message="Couldn't load this trip. Check your connection and try again." onRetry={() => q.refetch()} /> : <Banner tone="offline">You're offline. Connect to see the latest on this trip.</Banner>}</div>
        ) : q.data && view ? (
          <>
            <h1 className="mt-3 t-display-1 text-ink">
              {q.data.travellerFirstName}'s trip in {q.data.cityName}
            </h1>
            <p className="mt-1 t-body text-ink-2" aria-live="polite">
              {dayLabel(q.data.day)}. {updated}.
            </p>
            {(!online || q.isError) && (
              <div className="mt-4">
                <Banner tone="offline">You're offline. This is the last update we have.</Banner>
              </div>
            )}
            <p className="mt-4 t-small text-muted">You can see stops and progress. Exact location isn't shared. Times are estimates.</p>
            <div className="mt-6">
              <Timeline view={view} clock={view.now} change={null} reveal={false} onLeg={() => {}} onStop={() => {}} readOnly tomorrowLabel={dayLabel(addDays(q.data.day, 1))} />
            </div>
          </>
        ) : null}
      </main>
    </div>
  )
}
