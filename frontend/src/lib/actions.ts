// What the traveller does, end to end: call the API, refresh the trip, run the choreography, toast.
import { api, ApiError, newKey } from '@/api/client'
import { keys, queryClient, waitForJob } from '@/api/queries'
import type { AcceptIn, Body, CheckinResult, JobAccepted, Plan, TaskAdded, TaskEdit, TaskIn, TaskPatch, Trip } from '@/api/types'
import { hhmm } from './format'
import { enqueue, flush, queued, type QueuedCheckin } from './offlineQueue'
import { announce, dismissToast, getState, playChange, setState, showToast } from './store'
import { buildDay, type DayView } from './timeline'

/** Fetch the trip now and put it in the cache. */
export async function refetchTrip(tripId: string): Promise<Trip> {
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

const addOptimistic = (taskIds: string[]) => setState((s) => ({ optimisticDone: [...new Set([...s.optimisticDone, ...taskIds])] }))
const dropOptimistic = (taskIds: string[]) => setState((s) => ({ optimisticDone: s.optimisticDone.filter((id) => !taskIds.includes(id)) }))

/** How long a check-in waits, with Undo in its toast, before it goes to the server. */
export const CHECKIN_UNDO_MS = 5000

interface PendingCheckin {
  item: QueuedCheckin
  title: string
  before: DayView
  timer: ReturnType<typeof setTimeout>
  toastId: string
}
const pending = new Map<string, PendingCheckin>()

/**
 * Mark a task done: the current one (or the next) unless `taskId` names another. The station fills at
 * once and the toast offers Undo for 5 seconds; only then (or when the toast closes) does the check-in
 * go to the server, because a check-in the server has recorded can't be taken back.
 */
export function checkIn(tripId: string, view: DayView, clock: number, taskId?: string) {
  const task = taskId ? (view.stops.find((s) => s.task?.taskId === taskId)?.task ?? null) : view.checkInTask
  if (!task) return
  const item: QueuedCheckin = { tripId, taskId: task.taskId, kind: 'done', idempotencyKey: newKey('chk'), queuedAt: Date.now() }
  addOptimistic([task.taskId])
  // A check-in moves the day on: the automatic-shift banner has done its job.
  setState({ autoBanner: null })
  if ('vibrate' in navigator) navigator.vibrate?.(10)
  const key = item.idempotencyKey
  const entry: PendingCheckin = { item, title: task.title, before: view, timer: setTimeout(() => void commitCheckin(key), CHECKIN_UNDO_MS), toastId: '' }
  pending.set(key, entry)
  entry.toastId = showToast({ title: `${task.title} done at ${hhmm(clock)}.`, onUndo: () => cancelCheckin(key), onClose: () => void commitCheckin(key), duration: CHECKIN_UNDO_MS })
  announce(`${task.title} marked done. Undo available for 5 seconds.`)
}

/** Undo in the toast: the check-in never leaves the phone. */
export function cancelCheckin(key: string) {
  const entry = pending.get(key)
  if (!entry) return
  pending.delete(key)
  clearTimeout(entry.timer)
  dropOptimistic([entry.item.taskId])
  announce(`Undone. ${entry.title} is still open.`)
}

/** Sign-out: drop check-ins that haven't been sent. */
export function cancelPendingCheckins() {
  pending.forEach((p) => clearTimeout(p.timer))
  pending.clear()
}

// Leaving the page inside the Undo window: keep the check-in in the offline queue, so it goes out on the next visit.
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => pending.forEach((p) => enqueue(p.item)))
}

export async function commitCheckin(key: string) {
  const entry = pending.get(key)
  if (!entry) return
  pending.delete(key)
  clearTimeout(entry.timer)
  dismissToast(entry.toastId)
  const { item, title, before } = entry
  try {
    const res = await sendCheckin(item)
    const trip = await refetchTrip(item.tripId)
    dropOptimistic([item.taskId])
    const after = buildDay(trip)
    const shifted = res.result === 'shifted'
    playChange({
      kind: shifted ? 'reroute' : 'checkin',
      before,
      after,
      toast: after?.done ? 'Done. That was your last stop today.' : shifted ? 'Done. Your later stops moved.' : undefined,
      undoVersion: shifted ? undoVersionOf(trip) : null,
    })
  } catch (err) {
    if (err instanceof ApiError && err.offline) {
      // The queue keeps the station filled from here, across reloads too.
      enqueue(item)
      dropOptimistic([item.taskId])
      showToast({ title: `Marked done. It syncs when you're back online.` })
      announce(`${title} marked done. It syncs when you're back online.`)
      return
    }
    dropOptimistic([item.taskId])
    showToast({ title: err instanceof ApiError ? err.message : "Couldn't mark it done. Try again." })
  }
}

/** Send check-ins saved while offline. */
export async function flushQueue(tripId: string | null) {
  // Keep the stations filled while the queue empties and the trip reloads.
  const waiting = queued().map((q) => q.taskId)
  if (!waiting.length) return
  addOptimistic(waiting)
  try {
    const { sent, dropped } = await flush(sendCheckin)
    if (sent || dropped) {
      if (tripId) await refetchTrip(tripId).catch(() => undefined)
      if (sent) showToast({ title: sent === 1 ? 'Your check-in is synced.' : `${sent} check-ins are synced.` })
    }
  } finally {
    dropOptimistic(waiting)
  }
}

/** Skip a task: a "skipped" check-in. The caller plays the change once its sheet has closed. */
export function sendSkip(tripId: string, taskId: string, idempotencyKey = newKey('skip')) {
  return api.post<CheckinResult>(`/v1/trips/${tripId}/checkins`, { taskId, kind: 'skipped' }, { idempotencyKey })
}

export const SKIP_TOAST = 'Day rerouted. Later stops moved up.'

export async function skipTask(tripId: string, taskId: string, before: DayView | null) {
  await sendSkip(tripId, taskId)
  await applyServerChange(tripId, before, { kind: 'reroute', toast: SKIP_TOAST, undo: true })
}

/** Report a delay. The sheet decides what to show from the result. */
export function reportDelay(tripId: string, taskId: string, delayMin: number, idempotencyKey: string) {
  return api.post<CheckinResult>(`/v1/trips/${tripId}/checkins`, { taskId, kind: 'delay', delayMin }, { idempotencyKey })
}

/**
 * Accept one of the options the server offered, from the option set the sheet is showing. If that set
 * has changed since (the 5-minute check refreshed it), the server answers 409 and nothing is applied.
 */
export function acceptOption(tripId: string, optionId: string, optionSetId: string | null, idempotencyKey: string) {
  const body: Body<AcceptIn> = optionSetId ? { optionSetId } : {}
  return api.post<Plan>(`/v1/trips/${tripId}/options/${optionId}/accept`, body, { idempotencyKey })
}

/** The option set is no longer the one on screen (changed, expired or closed). */
export function isOptionsChanged(err: unknown) {
  return err instanceof ApiError && err.status === 409 && (err.code === 'OPTIONS_CHANGED' || err.code === 'OPTION_EXPIRED' || err.code === 'OPTION_CLOSED')
}

/** Turn a full task body into the PATCH shape, with an explicit timing switch. */
export function toPatch(body: Body<TaskIn>): TaskPatch {
  return {
    title: body.title,
    placeId: body.placeId,
    durationMin: body.durationMin,
    priority: body.priority,
    hoursUnknown: body.hoursUnknown,
    timing: body.fixedStart ? 'fixed' : body.window ? 'window' : 'anytime',
    fixedStart: body.fixedStart ?? null,
    window: body.window ?? null,
  }
}

/** What happened to a task edit: saved with no re-plan, re-planned, or still re-planning in the background. */
export type EditOutcome = 'saved' | 'replanned' | 'pending'

/**
 * Save a task edit and wait for the re-plan it starts, so the form can stay open ("Re-planning…")
 * until the day is ready. A failed re-plan throws, with words the form shows.
 */
export async function saveTaskEdit(tripId: string, taskId: string, body: Body<TaskIn>, onReplanning?: () => void): Promise<EditOutcome> {
  const res = await api.patch<TaskEdit>(`/v1/trips/${tripId}/tasks/${taskId}`, toPatch(body))
  if (!res.jobId) return 'saved'
  onReplanning?.()
  return waitReplan(tripId, res.jobId)
}

/**
 * Add a task. On a day that already has a plan the server re-plans it; this waits like an edit does.
 * In a batch, pass `replan: false` for all but the last task so the day re-plans once.
 */
export async function addTask(tripId: string, body: Body<TaskIn>, idempotencyKey: string, opts: { replan?: boolean; onReplanning?: () => void } = {}) {
  const replan = opts.replan ?? true
  const task = await api.post<TaskAdded>(`/v1/trips/${tripId}/tasks${replan ? '' : '?replan=false'}`, body, { idempotencyKey })
  if (!task.jobId) return { task, outcome: 'saved' as EditOutcome }
  opts.onReplanning?.()
  return { task, outcome: await waitReplan(tripId, task.jobId) }
}

/** Plan today again from where the traveller is, and play the change on the timeline. */
export async function replanDay(tripId: string, before: DayView | null) {
  const job = await api.post<JobAccepted>(`/v1/trips/${tripId}/plans`, {}, { idempotencyKey: newKey('plan') })
  await playTaskEdit(tripId, before, await waitReplan(tripId, job.jobId))
}

async function waitReplan(tripId: string, jobId: string): Promise<EditOutcome> {
  let job
  try {
    job = await waitForJob(jobId)
  } catch (err) {
    if (err instanceof ApiError && err.code === 'TIMEOUT') return 'pending'
    throw err
  }
  if (job.status === 'failed' || job.error) {
    // The change itself is saved: show it.
    void queryClient.invalidateQueries({ queryKey: keys.trip(tripId) })
    throw new ApiError(409, 'REPLAN_FAILED', `${job.error ?? "Couldn't re-plan your day."} Your change is saved and your earlier plan stays.`)
  }
  return 'replanned'
}

/** Play a saved task edit on the timeline, once the form has closed. */
export async function playTaskEdit(tripId: string, before: DayView | null, outcome: EditOutcome) {
  if (outcome === 'pending') {
    void queryClient.invalidateQueries({ queryKey: keys.trip(tripId) })
    showToast({ title: 'Planning is taking longer than usual. Your timeline updates when it finishes.' })
    return
  }
  await applyServerChange(tripId, before, outcome === 'replanned' ? { kind: 'reroute', toast: 'Day rerouted. Your times are updated.', undo: true } : { kind: 'checkin', toast: 'Task saved.' })
}

/** After a sheet closed on a change the server made: show it, or say it couldn't be loaded. */
export function playLater(run: () => Promise<unknown>) {
  void run().catch(() => showToast({ title: "Couldn't load your new plan. Check your connection and try again." }))
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
