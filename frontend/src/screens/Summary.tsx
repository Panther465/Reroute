import { Circle, CircleCheck } from 'lucide-react'
import { useCurrentTripId, useSummary, useTrip } from '@/api/queries'
import type { Summary as SummaryData } from '@/api/types'
import { BackButton, useBack } from '@/components/BackButton'
import { ExpenseSlip } from '@/components/ExpenseSlip'
import { modeBgClass } from '@/components/icons'
import { ButtonLink } from '@/components/ui/Button'
import { EmptyState, ErrorState, LoadingRegion, Skeleton } from '@/components/ui/States'
import { hhmm } from '@/lib/format'
import { useDocumentTitle, useOnline } from '@/lib/hooks'
import { localMinutes, weekday } from '@/lib/timeline'
import { PushedScreen } from './LegDetail'

/** A horizontal recap of the day's legs. */
function MiniLine({ summary }: { summary: SummaryData }) {
  const names = summary.legs.length ? [summary.legs[0].fromName, ...summary.legs.map((l) => l.toName)] : []
  return (
    <ol className="relative flex items-start overflow-x-auto rounded-tag pb-2" aria-label="Stops today" tabIndex={0}>
      {names.map((name, i) => {
        const leg = summary.legs[i]
        return (
          <li key={i} className="flex min-w-0 shrink-0 items-start">
            <div className="flex w-20 flex-col items-center text-center">
              <span aria-hidden="true" className="mt-1 flex size-4 items-center justify-center rounded-full border-[3px] border-ink bg-surface" />
              <span className="mt-2 t-small text-ink-2">{name}</span>
            </div>
            {leg && (
              <span aria-hidden="true" className="mt-[10px] flex h-1.5 w-8 shrink-0">
                {leg.segments.map((seg, j) => (
                  <span key={j} style={{ flexGrow: seg.minutes }} className={seg.mode === 'walk' ? 'border-t-[6px] border-dotted border-ink' : modeBgClass(seg.mode)} />
                ))}
              </span>
            )}
          </li>
        )
      })}
    </ol>
  )
}

export default function Summary() {
  const current = useCurrentTripId()
  const trip = useTrip(current.tripId)
  const q = useSummary(current.tripId)
  const online = useOnline()
  const back = useBack('/')
  const offset = trip.data?.utcOffset ?? '+05:30'
  useDocumentTitle(q.data?.legs.length ? `${weekday(q.data.day)} in ${q.data.cityName}` : 'Day summary')

  const header = (title: string, line?: string) => (
    <header className="flex items-start gap-2">
      <BackButton onClick={back} />
      <div className="pt-1">
        <h1 tabIndex={-1} className="t-display-1 text-ink">
          {title}
        </h1>
        {line && <p className="mt-1 t-body text-ink-2">{line}</p>}
      </div>
    </header>
  )

  if (q.isPending && current.tripId) {
    return (
      <PushedScreen>
        <BackButton onClick={back} className="mb-2" />
        <LoadingRegion label="Loading the summary">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="mt-2 h-5 w-48" />
          <Skeleton className="mt-6 h-16 w-full" />
          <Skeleton className="mt-6 h-64 w-full rounded-card" />
        </LoadingRegion>
      </PushedScreen>
    )
  }
  if (q.isError && !q.data) {
    return (
      <PushedScreen>
        {header('Day summary')}
        <div className="mt-6">
          <ErrorState message={online ? "Couldn't load the summary. Check your connection and try again." : "You're offline and the summary isn't saved on this phone yet."} onRetry={() => q.refetch()} />
        </div>
      </PushedScreen>
    )
  }
  const s = q.data
  if (!s || s.legs.length === 0) {
    return (
      <PushedScreen>
        {header('Day summary')}
        <EmptyState title="No day to sum up yet" body="Plan your day first. The summary and your expense slip appear here." action={<ButtonLink to="/plan">Plan my day</ButtonLink>} />
      </PushedScreen>
    )
  }

  return (
    <PushedScreen wide>
      {header(`${weekday(s.day)} in ${s.cityName}`, s.headline)}

      <div className="mt-6">
        <MiniLine summary={s} />
      </div>

      <div className="lg:mt-4 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:items-start lg:gap-12">
      <section className="mt-6" aria-labelledby="done-h">
        <h2 id="done-h" className="t-title text-ink">
          Done today
        </h2>
        <ul className="mt-3 flex flex-col gap-3">
          {s.tasks.map((task) => (
            <li key={task.taskId} className="flex items-start gap-3">
              {task.state === 'done' ? <CircleCheck size={20} strokeWidth={1.75} aria-hidden="true" className="mt-0.5 shrink-0 text-green" /> : <Circle size={20} strokeWidth={1.75} aria-hidden="true" className="mt-0.5 shrink-0 text-muted" />}
              <span>
                <span className="block t-body text-ink">
                  {task.title}, {task.area}
                </span>
                <span className="block t-small text-muted tnum">
                  {task.state === 'done' && task.start && task.end
                    ? `Done, ${hhmm(localMinutes(task.start, s.day, offset))} to ${hhmm(localMinutes(task.end, s.day, offset))}`
                    : task.state === 'moved' && task.movedTo
                      ? `Moved to ${weekday(task.movedTo.slice(0, 10))}, ${hhmm(localMinutes(task.movedTo, task.movedTo.slice(0, 10), offset))}`
                      : task.state === 'skipped'
                        ? 'Skipped'
                        : task.start
                          ? `Planned for ${hhmm(localMinutes(task.start, s.day, offset))}`
                          : 'Not in today’s plan'}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <div className="mt-8 lg:mt-6">
        <ExpenseSlip summary={s} offset={offset} />
      </div>
      </div>
    </PushedScreen>
  )
}
