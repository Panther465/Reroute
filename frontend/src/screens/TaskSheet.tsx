import { Ban, CircleCheck, Clock, MapPin } from 'lucide-react'
import { useState } from 'react'
import { ApiError } from '@/api/client'
import type { Body, Task, TaskIn, Trip } from '@/api/types'
import { Button } from '@/components/ui/Button'
import { Sheet } from '@/components/ui/Sheet'
import { Tag } from '@/components/ui/Tag'
import { applyServerChange, checkIn, playLater, playTaskEdit, saveTaskEdit, sendSkip, SKIP_TOAST } from '@/lib/actions'
import { duration, hhmm } from '@/lib/format'
import { T } from '@/lib/i18n'
import { showToast } from '@/lib/store'
import type { DayView, StopView } from '@/lib/timeline'
import { CheckInConfirm } from './CheckInConfirm'
import { TaskFormSheet } from './TaskForm'

/** Tap a stop: see it, mark it done, edit it or skip it. */
export function TaskSheet({ trip, view, clock, stop, onClose }: { trip: Trip; view: DayView; clock: number; stop: StopView | null; onClose: () => void }) {
  const [editing, setEditing] = useState<Task | null>(null)
  const [skipping, setSkipping] = useState(false)
  const [confirmEarly, setConfirmEarly] = useState(false)
  const task = stop?.task
  const apiTask = trip.tasks.find((t) => t.taskId === task?.taskId) ?? null
  const finished = task?.state === 'done' || stop?.status === 'done'
  const actionable = !!task && !finished

  const markDone = () => {
    if (!task) return
    setConfirmEarly(false)
    onClose()
    checkIn(trip.tripId, view, clock, task.taskId)
  }
  // As on Today: marking a task done long before it starts is more likely a slip, so ask first.
  const early = !!stop && stop.time - clock > 10

  // The form stays open ("Saving…", then "Re-planning…") until the day is ready; a failed re-plan shows in the form.
  const save = async (body: Body<TaskIn>, _initial: Task | null, stage: (s: 'replanning') => void) => {
    if (!apiTask) return
    const outcome = await saveTaskEdit(trip.tripId, apiTask.taskId, body, () => stage('replanning'))
    setEditing(null)
    onClose()
    playLater(() => playTaskEdit(trip.tripId, view, outcome))
  }

  const skip = async () => {
    if (!task) return
    setSkipping(true)
    try {
      await sendSkip(trip.tripId, task.taskId)
    } catch (err) {
      showToast({ title: err instanceof ApiError ? err.message : "Couldn't skip it. Try again." })
      setSkipping(false)
      return
    }
    setSkipping(false)
    onClose()
    playLater(() => applyServerChange(trip.tripId, view, { kind: 'reroute', toast: SKIP_TOAST, undo: true }))
  }

  return (
    <>
      <Sheet
        open={!!stop && !editing && !confirmEarly}
        onOpenChange={(o) => !o && !skipping && onClose()}
        title={stop?.title ?? ''}
        footer={
          actionable && (
            <div className="flex flex-col gap-3">
              <Button full onClick={() => (early ? setConfirmEarly(true) : markDone())} disabled={skipping} icon={<CircleCheck size={20} strokeWidth={1.75} aria-hidden="true" />}>
                <T k="Mark done" />
              </Button>
              <div className="grid grid-cols-2 gap-3">
                <Button variant="secondary" onClick={() => setEditing(apiTask)} disabled={skipping}>
                  <T k="Edit" />
                </Button>
                <Button variant="destructive" loading={skipping} loadingLabel="Skipping…" icon={<Ban size={20} strokeWidth={1.75} aria-hidden="true" />} onClick={skip}>
                  <T k="Skip it" />
                </Button>
              </div>
            </div>
          )
        }
      >
        {stop && task && (
          <div className="flex flex-col gap-4">
            <p className="flex items-start gap-3 t-body text-ink">
              <MapPin size={20} strokeWidth={1.75} aria-hidden="true" className="mt-0.5 shrink-0 text-muted" />
              <span>
                {task.place.name}
                <span className="block t-small text-muted">{task.place.area}</span>
              </span>
            </p>
            <p className="flex items-center gap-3 t-body text-ink tnum">
              <Clock size={20} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-muted" />
              {hhmm(stop.time)} to {hhmm(stop.end)}, {duration(stop.end - stop.time)}
            </p>
            <div className="flex flex-wrap gap-2">
              {task.fixedStart && (
                <Tag tone="blue">
                  <span aria-hidden="true">📌</span> Fixed {task.fixedStart}
                </Tag>
              )}
              {task.window && (
                <Tag tone="green-outline">
                  <span aria-hidden="true">🕓</span> Open till {task.window.closesAt}
                </Tag>
              )}
              <Tag tone="grey-outline">{task.priority === 1 ? 'Must do' : task.priority === 2 ? 'Should do' : 'If there is time'}</Tag>
            </div>
            {finished && <p className="t-body text-ink-2">Done. Nice work.</p>}
            {!finished && stop.status === 'now' && <p className="t-body text-ink-2">Mark it done when you finish. If it runs over, use Running late.</p>}
            {!finished && stop.status === 'upcoming' && <p className="t-small text-ink-2">Skipping moves your later stops up. You can undo it.</p>}
          </div>
        )}
      </Sheet>
      <TaskFormSheet trip={trip} open={!!editing} onOpenChange={(o) => !o && setEditing(null)} initial={editing} onSave={save} />
      {stop && task && (
        <CheckInConfirm open={confirmEarly} onOpenChange={(o) => !o && setConfirmEarly(false)} title={task.title} start={stop.time} clock={clock} onConfirm={markDone} />
      )}
    </>
  )
}
