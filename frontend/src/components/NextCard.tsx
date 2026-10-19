import { CircleCheck } from 'lucide-react'
import { ModeChain } from '@/components/timeline/ModeChain'
import { ButtonLink } from '@/components/ui/Button'
import { duration, lowerFirst, rupees } from '@/lib/format'
import { T } from '@/lib/i18n'
import type { DayView } from '@/lib/timeline'

export function NextCard({ view, clock, started = false }: { view: DayView; clock: number; started?: boolean }) {
  const leg = view.nextLeg
  if (view.done || !leg) {
    const end = view.stops[view.stops.length - 1]
    return (
      <section aria-labelledby="next-title" className="rounded-card border border-line bg-surface p-5">
        <p className="flex items-center gap-2 t-caption text-green-ink">
          <CircleCheck size={20} strokeWidth={1.75} aria-hidden="true" />
          <T k="Your day is done" />
        </p>
        <h2 id="next-title" className="mt-2 t-display-2 text-ink">
          Back at {end ? lowerFirst(end.title).replace(/^hotel/, 'the hotel') : 'your stay'}
        </h2>
        <ButtonLink to="/summary" variant="primary" className="mt-4">
          See the day summary
        </ButtonLink>
      </section>
    )
  }
  const to = view.stops.find((s) => s.id === leg.toId)!
  const soon = !started && clock >= leg.leaveMin - 10 && clock < leg.leaveMin + 1
  const where = to.kind === 'end' ? 'the hotel' : `the ${lowerFirst(to.title)} in ${to.area}`
  const dest = started ? `On the way to ${where}` : `Leave for ${where}`
  return (
    <section aria-labelledby="next-title" className="rounded-card border border-line bg-surface p-5">
      <p className="t-caption text-ink-2">{started ? 'Arrive by' : <T k={soon ? 'Leave now' : 'Leave by'} />}</p>
      <p className="mt-1">
        <span className={`inline-block rounded-tag t-time-lg tnum transition-colors duration-[var(--dur-base)] ${soon ? 'bg-yellow px-2 text-on-yellow' : 'text-ink'}`}>
          <span className="sr-only">{started ? 'Arrive by ' : soon ? 'Leave now, by ' : 'Leave by '}</span>
          {started ? leg.arriveAt : leg.leaveBy}
        </span>
      </p>
      <h2 id="next-title" className="mt-3 t-title text-ink">
        {dest}
      </h2>
      <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 t-small text-ink-2 tnum">
        <span className="inline-flex items-center gap-2">
          <ModeChain segments={leg.segments} />
          <span className="font-bold text-ink">{leg.label}</span>
        </span>
        <span>About {duration(leg.travelMin)}</span>
        <span>{leg.fareInr ? `About ${rupees(leg.fareInr)}` : 'Free'}</span>
        {!started && <span>Arrive around {leg.arriveAt}</span>}
      </p>
    </section>
  )
}
