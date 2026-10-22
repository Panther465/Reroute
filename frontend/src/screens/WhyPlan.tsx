import { useCurrentTripId, useInsight, useTrip } from '@/api/queries'
import type { DayAlternative, LegInsight, PlanInsight, Trip } from '@/api/types'
import { BackButton, useBack } from '@/components/BackButton'
import { ModeIcon, modeTextClass } from '@/components/icons'
import { ButtonLink } from '@/components/ui/Button'
import { EmptyState, ErrorState, LoadingRegion, Skeleton } from '@/components/ui/States'
import { RoughTag, Tag } from '@/components/ui/Tag'
import { ApiError } from '@/api/client'
import { duration, hhmm, lowerFirst, rupees } from '@/lib/format'
import { useDocumentTitle, useOnline } from '@/lib/hooks'
import { localMinutes, weekday } from '@/lib/timeline'
import { PushedScreen } from './LegDetail'

const listJoin = (items: string[]) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`)

/** When the day ends, in minutes, or null for a day that doesn't fit. */
function ends(day: DayAlternative, trip: Trip) {
  return day.endsAt ? localMinutes(day.endsAt, trip.day, trip.utcOffset) : null
}

/** The plan in one or two sentences, against the other days the planner weighed. */
function verdict(days: DayAlternative[], trip: Trip): string[] {
  const [chosen, cabs, noCabs] = days
  const chosenEnd = ends(chosen, trip)
  const lines: string[] = []
  if (cabs?.feasible && chosenEnd !== null) {
    const saved = cabs.fareInr - chosen.fareInr
    const later = chosenEnd - (ends(cabs, trip) ?? chosenEnd)
    if (saved > 0) {
      lines.push(
        later > 0
          ? `Your plan costs ${rupees(saved)} less than taking cabs door to door, and gets you back ${duration(later)} later.`
          : `Your plan costs ${rupees(saved)} less than taking cabs door to door, and gets you back just as soon.`,
      )
    } else lines.push('Cabs door to door would cost the same as your plan, so Reroute kept the quicker day.')
  }
  if (noCabs) {
    const same = noCabs.feasible && noCabs.fareInr === chosen.fareInr && noCabs.order.join() === chosen.order.join()
    if (same) lines.push('It already uses no cabs.')
    else if (!noCabs.feasible) lines.push('Without cabs the day wouldn’t keep its fixed times.')
    else if (noCabs.leftOut.length) lines.push(`Without cabs, ${listJoin(noCabs.leftOut.map(lowerFirst))} wouldn’t fit today.`)
    else {
      const later = (ends(noCabs, trip) ?? 0) - (chosenEnd ?? 0)
      lines.push(`Without any cabs it would save ${rupees(Math.max(0, chosen.fareInr - noCabs.fareInr))}${later > 0 ? ` but end ${duration(later)} later` : ''}.`)
    }
  }
  return lines
}

// A clip-path reveal (never a width or scale from zero): the bar is its full length from the start.
const BAR = 'block h-1.5 rounded-full [clip-path:inset(0_0_0_0_round_9999px)] transition-[clip-path] duration-[var(--dur-slow)] ease-[var(--ease-out)] starting:[clip-path:inset(0_100%_0_0_round_9999px)] motion-reduce:transition-none'

function DayRow({ day, trip, maxFare, maxTravel, index }: { day: DayAlternative; trip: Trip; maxFare: number; maxTravel: number; index: number }) {
  const chosen = day.kind === 'chosen'
  const end = ends(day, trip)
  const bar = chosen ? 'bg-green' : 'bg-line-strong'
  return (
    <li className="px-4 py-4">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="t-title text-ink">{day.label}</span>
        {chosen && <Tag tone="green">Reroute’s choice</Tag>}
      </div>
      {day.feasible ? (
        <>
          <dl className="mt-2 grid grid-cols-3 gap-3 tnum">
            <div>
              <dt className="t-small text-muted">Back at</dt>
              <dd className="t-title text-ink">{end !== null ? hhmm(end) : '—'}</dd>
            </div>
            <div>
              <dt className="t-small text-muted">Fares</dt>
              <dd className="t-title text-ink">{rupees(day.fareInr)}</dd>
            </div>
            <div>
              <dt className="t-small text-muted">Travelling</dt>
              <dd className="t-title text-ink">{duration(day.travelMin)}</dd>
            </div>
          </dl>
          {/* The same two measures as bars, so the trade-off reads at a glance. They draw in from the left
              once, one day after another, so the eye compares them as they grow. */}
          <div className="mt-3 grid gap-1.5" aria-hidden="true">
            <span className={`${BAR} ${bar}`} style={{ width: `${Math.max(4, (day.fareInr / maxFare) * 100)}%`, transitionDelay: `${index * 60}ms` }} />
            <span className={`${BAR} opacity-60 ${bar}`} style={{ width: `${Math.max(4, (day.travelMin / maxTravel) * 100)}%`, transitionDelay: `${index * 60 + 30}ms` }} />
          </div>
          {day.leftOut.length > 0 && <p className="mt-2 t-small text-ink-2">Leaves out {listJoin(day.leftOut.map(lowerFirst))}.</p>}
        </>
      ) : (
        <p className="mt-1 t-small text-ink-2">Doesn’t fit: it would miss a fixed time or an opening hour.</p>
      )}
    </li>
  )
}

function legName(leg: LegInsight, trip: Trip) {
  const task = leg.taskId ? trip.tasks.find((t) => t.taskId === leg.taskId) : null
  return task ? `To the ${lowerFirst(task.title)}` : `Back to ${trip.stayPlace.name}`
}

/** One leg: every way there, with the one chosen and what each other way would change. */
function LegChoices({ leg, trip, divisor }: { leg: LegInsight; trip: Trip; divisor: number }) {
  const chosen = leg.choices.find((c) => c.chosen)
  const cheapest = leg.choices.find((c) => !c.unusable)
  return (
    <li className="py-4">
      <h3 className="t-title text-ink">{legName(leg, trip)}</h3>
      <ul className="mt-2 flex flex-col">
        {leg.choices.map((c) => {
          const dMin = chosen ? c.travelMin - chosen.travelMin : 0
          const dFare = chosen ? c.fareInr - chosen.fareInr : 0
          const delta = c.chosen
            ? null
            : [dMin !== 0 && `${duration(Math.abs(dMin))} ${dMin < 0 ? 'faster' : 'slower'}`, dFare !== 0 && `${rupees(Math.abs(dFare))} ${dFare < 0 ? 'cheaper' : 'more'}`].filter(Boolean).join(', ') ||
              'the same time and fare'
          return (
            <li key={c.optionId} className={`flex items-start gap-3 rounded-control px-2 py-2 ${c.chosen ? 'bg-green-tint' : ''} ${c.unusable ? 'opacity-70' : ''}`}>
              <ModeIcon mode={c.mode} size={20} className={`mt-0.5 shrink-0 ${modeTextClass(c.mode)}`} />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className={`t-body ${c.chosen ? 'font-bold text-ink' : 'text-ink'}`}>{c.label}</span>
                  {c.chosen && <Tag tone="green">Chosen</Tag>}
                  {c.rough && <RoughTag />}
                </span>
                <span className="block t-small text-ink-2 tnum">
                  {duration(c.travelMin)}, {c.fareInr ? rupees(c.fareInr) : 'free'}
                  {delta && <span className="text-muted">, {delta}</span>}
                </span>
                {c.unusable && <span className="block t-small text-muted">{c.unusable}.</span>}
              </span>
              <span className="shrink-0 pt-0.5 t-small text-muted tnum" title={`${c.travelMin} min plus ${rupees(c.fareInr)} ÷ ${divisor}`}>
                {Math.round(c.cost)} pts
              </span>
            </li>
          )
        })}
      </ul>
      {chosen && cheapest && !cheapest.chosen && (
        <p className="mt-2 t-small text-ink-2">A cheaper way on its own didn’t suit the day: it would have missed a time, an opening hour or a last trip later on.</p>
      )}
    </li>
  )
}

function Constraints({ trip }: { trip: Trip }) {
  const today = trip.tasks.filter((t) => t.day === trip.day && t.state !== 'skipped')
  const facts = today.flatMap((t) => {
    if (t.fixedStart) return [`the ${lowerFirst(t.title)} is fixed at ${hhmm(localMinutes(t.fixedStart, t.day, trip.utcOffset))}`]
    if (t.window) return [`the ${lowerFirst(t.title)} is open ${t.window.opensAt} to ${t.window.closesAt}`]
    return []
  })
  if (!facts.length) return null
  return <p className="mt-2 t-body text-ink-2">Today, {listJoin(facts)}.</p>
}

function Body({ insight, trip }: { insight: PlanInsight; trip: Trip }) {
  const feasible = insight.days.filter((d) => d.feasible)
  const maxFare = Math.max(1, ...feasible.map((d) => d.fareInr))
  const maxTravel = Math.max(1, ...feasible.map((d) => d.travelMin))
  return (
    <>
      <div className="mt-6 flex flex-col gap-1">
        {verdict(insight.days, trip).map((line) => (
          <p key={line} className="t-title text-ink">
            {line}
          </p>
        ))}
      </div>

      <section className="mt-8" aria-labelledby="days-h">
        <h2 id="days-h" className="t-title text-ink">
          The day, three ways
        </h2>
        <p className="mt-1 t-small text-muted">All three planned from the same tasks, places and times. The bars show fares, then time travelling.</p>
        <ul className="mt-3 divide-y divide-line rounded-card border border-line bg-surface">
          {insight.days.map((d, i) => (
            <DayRow key={d.kind} day={d} trip={trip} maxFare={maxFare} maxTravel={maxTravel} index={i} />
          ))}
        </ul>
      </section>

      <section className="mt-8" aria-labelledby="how-h">
        <h2 id="how-h" className="t-title text-ink">
          How Reroute chose
        </h2>
        <p className="mt-2 t-body text-ink-2">
          {insight.exact
            ? `It tried every order of your ${insight.taskCount} ${insight.taskCount === 1 ? 'task' : 'tasks'} (${insight.orders} in all) and every way to travel each leg, and kept the cheapest day that keeps every fixed time and opening hour.`
            : `With ${insight.taskCount} tasks there are too many orders to try them all, so it built the day one task at a time, putting each where it cost least, and kept every fixed time and opening hour.`}
        </p>
        <p className="mt-2 t-body text-ink-2">
          Cheapest means minutes travelling or waiting, with every {rupees(insight.fareDivisor)} of fare counted as one minute: the points beside each way below. Fixed times keep a 10-minute buffer, and shared autos run only between their first and last trips.
        </p>
        <Constraints trip={trip} />
      </section>

      <section className="mt-8" aria-labelledby="legs-h">
        <h2 id="legs-h" className="t-title text-ink">
          Leg by leg
        </h2>
        <ul className="mt-1 divide-y divide-line">
          {insight.legs.map((leg) => (
            <LegChoices key={`${leg.seq}-${leg.toPlace}`} leg={leg} trip={trip} divisor={insight.fareDivisor} />
          ))}
        </ul>
      </section>
      <p className="mt-6 t-small text-muted">Times and fares are estimates.</p>
    </>
  )
}

export default function WhyPlan() {
  const current = useCurrentTripId()
  const trip = useTrip(current.tripId)
  const version = trip.data?.activePlan?.version ?? null
  const q = useInsight(current.tripId, version)
  const online = useOnline()
  const back = useBack('/')
  useDocumentTitle('Why this plan')

  const header = (
    <header className="flex items-start gap-2">
      <BackButton onClick={back} />
      <div className="pt-1">
        <h1 tabIndex={-1} className="t-display-1 text-ink">
          Why this plan
        </h1>
        {trip.data?.activePlan && (
          <p className="mt-1 t-body text-ink-2">
            {weekday(trip.data.activePlan.day)} in {trip.data.cityName}, version {trip.data.activePlan.version}
          </p>
        )}
      </div>
    </header>
  )

  if ((trip.isPending || q.isPending) && version !== null) {
    return (
      <PushedScreen>
        <BackButton onClick={back} className="mb-2" />
        <LoadingRegion label="Loading why this plan">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="mt-6 h-12 w-full" />
          <Skeleton className="mt-6 h-72 w-full rounded-card" />
        </LoadingRegion>
      </PushedScreen>
    )
  }
  if (!trip.data || version === null) {
    return (
      <PushedScreen>
        {header}
        <EmptyState title="No plan yet" body="Plan your day first. This page then shows what Reroute weighed to choose it." action={<ButtonLink to="/plan">Plan my day</ButtonLink>} />
      </PushedScreen>
    )
  }
  if (q.isError && !q.data) {
    const missing = q.error instanceof ApiError && q.error.status === 404
    return (
      <PushedScreen>
        {header}
        <div className="mt-6">
          {missing ? (
            <EmptyState title="This plan predates its reasons" body={q.error.message} action={<ButtonLink to="/plan">Go to Plan</ButtonLink>} />
          ) : (
            <ErrorState message={online ? "Couldn't load why this plan. Check your connection and try again." : "You're offline, and this page isn't saved on the phone yet."} onRetry={() => q.refetch()} />
          )}
        </div>
      </PushedScreen>
    )
  }
  return <PushedScreen>{header}{q.data && <Body insight={q.data} trip={trip.data} />}</PushedScreen>
}
