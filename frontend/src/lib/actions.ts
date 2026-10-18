// What the traveller does, end to end: call the API, refresh the trip, run the choreography, toast.
import { api, ApiError, newKey } from '@/api/client'
import { keys, queryClient } from '@/api/queries'
import type { CheckinResult, Plan, Trip } from '@/api/types'
import { hhmm } from './format'
import { enqueue, flush, type QueuedCheckin } from './offlineQueue'
import { announce, getState, playChange, setState, showToast } from './store'
import { buildDay, localMinutes, type DayView } from './timeline'

async function refetchTrip(tripId: string): Promise<Trip> {
  const trip = await api.get<Trip>(`/v1/trips/${tripId}`)
  queryClient.setQueryData(keys.trip(tripId), trip)
  void queryClient.invalidateQueries({ queryKey: keys.summary(tripId) })
  return trip
}

/** The version Undo would restore: the latest log entry that can still be undone. */
export function undoVersionOf(trip: Trip | undefined): number | null {
  const entry = trip?.log.find((e) => e.canUndo)
  return entry?.previousVersion ?? null
}

/** After the server changed the day: fetch it and play the change against what the screen showed. */
export async function applyServerChange(tripId: string, before: DayView | null, opts: { kind: 'reroute' | 'undo' | 'checkin'; toast?: string; undo?: boolean; banner?: boolean }) {
  const trip = await refetchTrip(tripId)
  const after = buildDay(trip)
  const undoVersion = opts.undo ? undoVersionOf(trip) : null
  playChange({ kind: opts.kind, before, after, toast: opts.toast, undoVersion, banner: opts.banner ? opts.toast : undefined })
  return trip
}

function sendCheckin(item: QueuedCheckin) {
  return api.post<CheckinResult>(`/v1/trips/${item.tripId}/checkins`, { taskId: item.taskId, kind: item.kind, delayMin: item.delayMin }, { idempotencyKey: item.idempotencyKey })
}

/** Check in the current task. The station fills at once; the server's answer reconciles it. */
export async function checkIn(tripId: string, view: DayView) {
  const task = view.checkInTask
  if (!task) return
  const item: QueuedCheckin = { tripId, taskId: task.taskId, kind: 'done', idempotencyKey: newKey('chk'), queuedAt: Date.now() }
  setState((s) => ({ optimisticDone: [...s.optimisticDone, task.taskId] }))
  if ('vibrate' in navigator) navigator.vibrate?.(10)
  try {
    const res = await sendCheckin(item)
    const trip = await refetchTrip(tripId)
    setState({ optimisticDone: [] })
    const at = hhmm(localMinutes(trip.now, trip.day, trip.utcOffset))
    const after = buildDay(trip)
    const shifted = res.result === 'shifted'
    playChange({
      kind: shifted ? 'reroute' : 'checkin',
      before: view,
      after,
      toast: after?.done ? `Checked in at ${at}. Your day is done.` : shifted ? `Checked in at ${at}. Later stops moved.` : `Checked in at ${at}.`,
      undoVersion: shifted ? undoVersionOf(trip) : null,
    })
  } catch (err) {
    if (err instanceof ApiError && err.offline) {
      enqueue(item)
      showToast({ title: `Checked in. It syncs when you're back online.` })
      announce(`Checked in, ${task.title}. It syncs when you're back online.`)
      return
    }
    setState({ optimisticDone: [] })
    showToast({ title: err instanceof ApiError ? err.message : "Couldn't check in. Try again." })
  }
}

/** Send check-ins saved while offline. */
export async function flushQueue(tripId: string | null) {
  const { sent, dropped } = await flush(sendCheckin)
  if (sent || dropped) {
    setState({ optimisticDone: [] })
    if (tripId) await refetchTrip(tripId).catch(() => undefined)
    if (sent) showToast({ title: sent === 1 ? 'Your check-in is synced.' : `${sent} check-ins are synced.` })
  }
}

export async function skipTask(tripId: string, taskId: string, before: DayView | null) {
  await api.post<CheckinResult>(`/v1/trips/${tripId}/checkins`, { taskId, kind: 'skipped' }, { idempotencyKey: newKey('skip') })
  await applyServerChange(tripId, before, { kind: 'reroute', toast: 'Day rerouted. Later stops moved up.', undo: true })
}

/** Report a delay. The sheet decides what to show from the result. */
export function reportDelay(tripId: string, taskId: string, delayMin: number, idempotencyKey: string) {
  return api.post<CheckinResult>(`/v1/trips/${tripId}/checkins`, { taskId, kind: 'delay', delayMin }, { idempotencyKey })
}

export async function acceptOption(tripId: string, optionId: string, idempotencyKey: string, before: DayView | null, consequence: string) {
  await api.post<Plan>(`/v1/trips/${tripId}/options/${optionId}/accept`, {}, { idempotencyKey })
  return applyServerChange(tripId, before, { kind: 'reroute', toast: `Day rerouted. ${consequence}.`, undo: true })
}

export async function undo(tripId: string, version: number) {
  const before = buildDay(queryClient.getQueryData<Trip>(keys.trip(tripId))!)
  setState({ autoBanner: null })
  try {
    await api.post<Plan>(`/v1/trips/${tripId}/plans/${version}/activate`, {}, { idempotencyKey: newKey('undo') })
    await applyServerChange(tripId, before, { kind: 'undo', toast: 'Change undone. Your earlier plan is back.' })
  } catch (err) {
    showToast({ title: err instanceof ApiError ? err.message : "Couldn't undo. Try again." })
  }
}

export function isDemo() {
  return getState().demo.enabled
}
