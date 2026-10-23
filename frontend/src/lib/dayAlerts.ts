// Watches the day and raises an alert at each moment that matters, on whichever screen is open:
// 5 minutes before leaving, time to leave, a task ending in 5 minutes, nearly there, arrived.
import { useEffect, useMemo } from 'react'
import { useDay } from '@/api/queries'
import type { Trip } from '@/api/types'
import { raise } from './alerts'
import { duration, hhmm } from './format'
import { placeIndex } from './geo'
import { destName, legGuide } from './guide'
import { useLocation } from './location'
import { distanceLabel } from './progress'
import { roadsOf, usePlanPaths } from './paths'
import { useStore } from './store'

export function useDayGuide(trip: Trip | undefined, clock: number | null) {
  const view = useDay(trip, clock)
  const { fix } = useLocation()
  const started = useStore((s) => (trip && s.started?.tripId === trip.tripId ? s.started.toId : null))
  const places = useMemo(() => (trip ? placeIndex(trip) : new Map()), [trip])
  // Each leg along the roads, as the server drew it after planning.
  const paths = usePlanPaths(trip)
  const roads = useMemo(() => roadsOf(paths), [paths])
  const guide = useMemo(() => legGuide(view, clock, started, places, roads, fix), [view, clock, started, places, roads, fix])
  return { view, guide, started, roads, places, fix, paths }
}

export function useDayAlerts(trip: Trip | undefined, clock: number | null) {
  const { view, guide, started } = useDayGuide(trip, clock)
  const minute = clock == null ? null : Math.floor(clock)

  useEffect(() => {
    if (!trip || !view || minute == null || view.done) return
    const day = `${trip.tripId}:${trip.day}`

    // Leaving: only while the traveller hasn't said they've left.
    const leg = view.nextLeg
    const to = leg ? view.stops.find((s) => s.id === leg.toId) : undefined
    if (leg && to && started !== leg.toId) {
      const dest = destName(to)
      const left = Math.round(leg.leaveMin - minute)
      if (left > 0 && left <= 5) {
        raise({ key: `${day}:leave-soon:${leg.toId}:${leg.leaveMin}`, title: `Leave in ${duration(left)} for ${dest}.`, speech: `Heads up. Leave in ${left} minutes for ${dest}.`, tag: `leave-${leg.seq}` })
      } else if (left <= 0 && left > -10) {
        raise({
          key: `${day}:leave-now:${leg.toId}:${leg.leaveMin}`,
          title: `Time to leave for ${dest}. ${leg.label}, about ${duration(leg.travelMin)}.`,
          speech: `Time to leave for ${dest}.`,
          tone: 'urgent',
          tag: `leave-${leg.seq}`,
        })
      }
    }

    // A task about to end: say what comes next.
    const here = view.stops[view.nowIndex]
    if (here?.kind === 'task' && here.task?.state !== 'done' && minute >= here.time) {
      const left = Math.round(here.end - minute)
      if (left > 0 && left <= 5) {
        const after = view.nextLeg && view.nextLeg.fromId === here.id ? ` Next, leave at ${view.nextLeg.leaveBy}.` : ''
        raise({ key: `${day}:ending:${here.id}:${here.end}`, title: `The ${here.title.toLowerCase()} ends in ${duration(left)}, at ${hhmm(here.end)}.${after}`, tag: `task-${here.id}` })
      }
    }
  }, [trip, view, minute, started])

  // Arriving: from the phone's location, while it's being followed.
  const arrivalKey = guide && trip ? `${trip.tripId}:${trip.day}:${guide.leg.toId}:${guide.leg.leaveMin}` : null
  useEffect(() => {
    if (!guide || !arrivalKey) return
    const dest = destName(guide.to)
    if (guide.arrived) {
      raise({ key: `${arrivalKey}:arrived`, title: `You've arrived at ${dest}.`, speech: `You've arrived at ${dest}.`, tone: 'arrive', tag: `arrive-${guide.leg.seq}` })
    } else if (guide.near && guide.remainingM != null) {
      raise({ key: `${arrivalKey}:near`, title: `Almost there: ${distanceLabel(guide.remainingM)} to ${dest}.`, speech: `Almost there. ${dest} is close.`, tag: `arrive-${guide.leg.seq}` })
    }
  }, [guide?.arrived, guide?.near, arrivalKey]) // eslint-disable-line react-hooks/exhaustive-deps
}
