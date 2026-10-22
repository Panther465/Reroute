import { CircleCheck, Navigation, Ruler } from 'lucide-react'
import type { ReactNode } from 'react'
import { ModeChain } from '@/components/timeline/ModeChain'
import { ButtonLink } from '@/components/ui/Button'
import { duration, lowerFirst, rupees } from '@/lib/format'
import type { LegGuide } from '@/lib/guide'
import { T } from '@/lib/i18n'
import { distanceLabel } from '@/lib/progress'
import { samePlace, type DayView } from '@/lib/timeline'

export function NextCard({ view, clock, guide, miniMap }: { view: DayView; clock: number; guide: LegGuide | null; miniMap?: ReactNode }) {
  if (view.done || !guide) {
    const end = view.stops[view.stops.length - 1]
    return (
      <section aria-labelledby="next-title" className="rounded-card border border-line bg-surface p-5">
        <p className="flex items-center gap-2 t-caption text-green-ink">
          <CircleCheck size={18} strokeWidth={2} aria-hidden="true" />
          <T k="Your day is done" />
        </p>
        <h2 id="next-title" className="mt-2 t-display-2 text-ink">
          Back at {end ? end.title : 'your stay'}
        </h2>
        <ButtonLink to="/summary" variant="primary" className="mt-4">
          See the day summary
        </ButtonLink>
      </section>
    )
  }
  const { leg, to, riding } = guide
  const soon = !riding && clock >= leg.leaveMin - 10 && clock < leg.leaveMin + 1
  const where = to.kind === 'end' ? `your stay, ${to.title}` : `the ${lowerFirst(to.title)} in ${to.area}`
  const live = riding && guide.remainingM != null
  return (
    <section aria-labelledby="next-title" className="rounded-card border border-line bg-surface p-5">
      <p className={`t-caption ${riding ? 'text-blue' : 'text-ink-2'}`}>{riding ? 'Arrive around' : <T k={soon ? 'Leave now' : 'Leave by'} />}</p>
      <p className="mt-1 flex flex-wrap items-baseline gap-x-2">
        <span className={`inline-block rounded-tag t-time-lg tnum transition-colors duration-[var(--dur-base)] ${soon ? 'bg-yellow px-2 text-on-yellow' : 'text-ink'}`}>
          <span className="sr-only">{riding ? 'Arrive around ' : soon ? 'Leave now, by ' : 'Leave by '}</span>
          {riding ? leg.arriveAt : leg.leaveBy}
        </span>
        {!riding && leg.leaveMin - clock > 0 && leg.leaveMin - clock <= 90 && <span className="t-title text-ink-2 tnum">in {duration(Math.round(leg.leaveMin - clock))}</span>}
      </p>
      <h2 id="next-title" className="mt-3 t-title text-ink">
        {riding ? `On the way to ${where}` : `Leave for ${where}`}
      </h2>
      {live && (
        // Live from the phone's location. Not a live region: it changes every few seconds, and the
        // moments that matter (nearly there, arrived) are announced by the alerts.
        <p className="mt-2 flex items-center gap-2 t-title text-blue tnum">
          <Navigation size={18} strokeWidth={1.75} aria-hidden="true" />
          {guide.arrived ? 'You’re here' : `${distanceLabel(guide.remainingM!)} to go, about ${duration(guide.etaMin!)}`}
        </p>
      )}
      {samePlace(leg) ? (
        <p className="mt-2 t-small text-ink-2">Same place, no travel.</p>
      ) : (
      <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 t-small text-ink-2 tnum">
        <span className="inline-flex items-center gap-2">
          <ModeChain segments={leg.segments} />
          <span className="font-bold text-ink">{leg.label}</span>
        </span>
        <span>About {duration(leg.travelMin)}</span>
        <span>{leg.fareInr ? `About ${rupees(leg.fareInr)}` : 'Free'}</span>
        {!riding && <span>Arrive around {leg.arriveAt}</span>}
      </p>
      )}
      {leg.rough && (
        <p className="mt-2 flex gap-2 t-small text-muted">
          <Ruler size={16} strokeWidth={2} aria-hidden="true" className="mt-0.5 shrink-0" />A rough estimate from the distance. Reroute has no travel data for this place yet, so allow extra time.
        </p>
      )}
      {miniMap && <div className="mt-4">{miniMap}</div>}
    </section>
  )
}
