// The leg the traveller is on (or about to take), and how it's going: distance left along the road,
// time to arrive, nearly there, arrived. Shared by the Next card, the map and the alerts.
import type { LngLat, PlaceIndex } from './geo'
import type { Fix } from './location'
import { metres, progressAlong, type Progress } from './progress'
import type { DayView, LegView, StopView } from './timeline'

/** Within this of the destination counts as arrived; within NEAR_M as nearly there. */
export const ARRIVED_M = 120
export const NEAR_M = 800

export interface LegGuide {
  leg: LegView
  to: StopView
  /** On the way: the traveller said "I've left", or the leg's leave time has passed and they haven't arrived. */
  riding: boolean
  path: LngLat[]
  progress: Progress | null
  remainingM: number | null
  etaMin: number | null
  near: boolean
  arrived: boolean
}

/**
 * The leg that matters now. While travelling to a stop (its leave time has passed but the task hasn't
 * started), the timeline already counts the traveller at that stop, so the leg into it is the one to guide.
 */
export function activeLeg(view: DayView, clock: number, startedTo: string | null): { leg: LegView; riding: boolean } | null {
  const now = view.stops[view.nowIndex]
  const into = view.legs.find((l) => l.toId === now?.id)
  if (into && now?.kind === 'task' && now.task?.state !== 'done' && clock >= into.leaveMin && clock < now.time) return { leg: into, riding: true }
  if (into && now?.kind === 'end' && clock >= into.leaveMin && clock < into.arriveMin) return { leg: into, riding: true }
  const next = view.nextLeg
  if (!next) return null
  return { leg: next, riding: startedTo === next.toId }
}

export function legGuide(view: DayView | null, clock: number | null, startedTo: string | null, places: PlaceIndex, roads: Map<number, LngLat[]>, fix: Fix | null): LegGuide | null {
  if (!view || clock == null || view.done) return null
  const active = activeLeg(view, clock, startedTo)
  if (!active) return null
  const { leg, riding } = active
  const to = view.stops.find((s) => s.id === leg.toId)
  const a = places.get(leg.fromPlaceId)
  const b = places.get(leg.toPlaceId)
  if (!to || !b) return null
  const path = roads.get(leg.seq) ?? (a ? [a, b] : [b])
  if (!fix) return { leg, to, riding, path, progress: null, remainingM: null, etaMin: null, near: false, arrived: false }
  const here: LngLat = [fix.lng, fix.lat]
  const straight = metres(here, b)
  const progress = path.length > 1 ? progressAlong(path, here) : null
  // Off the road path (a different route, or a poor fix): measure straight to the stop instead.
  const remainingM = progress && progress.offRouteM < 300 ? progress.remainingM : straight
  const totalM = progress?.totalM || straight || 1
  const metresPerMin = leg.travelMin > 0 ? totalM / leg.travelMin : 250
  return {
    leg,
    to,
    riding,
    path,
    progress,
    remainingM,
    etaMin: Math.max(1, Math.round(remainingM / metresPerMin)),
    near: straight < NEAR_M,
    arrived: straight < ARRIVED_M,
  }
}

export function destName(to: StopView) {
  return to.kind === 'end' || to.kind === 'start' ? `your stay, ${to.title}` : `the ${to.title.charAt(0).toLowerCase()}${to.title.slice(1)}`
}
