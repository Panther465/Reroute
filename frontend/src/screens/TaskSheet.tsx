import { Ban, Clock, MapPin } from 'lucide-react'
import { useState } from 'react'
import { ApiError } from '@/api/client'
import type { Body, Task, TaskIn, Trip } from '@/api/types'
import { Button } from '@/components/ui/Button'
import { Sheet } from '@/components/ui/Sheet'
import { Tag } from '@/components/ui/Tag'
import { applyServerChange, playLater, playTaskEdit, saveTaskEdit, sendSkip, SKIP_TOAST } from '@/lib/actions'
import { duration, hhmm } from '@/lib/format'
import { T } from '@/lib/i18n'
import { showToast } from '@/lib/store'
import type { DayView, StopView } from '@/lib/timeline'
import { TaskFormSheet } from './TaskForm'

/** Tap a stop: see it, edit it or skip it. */
export function TaskSheet({ trip, view, stop, onClose }: { trip: Trip; view: DayView; stop: StopView | null; onClose: () => void }) {
  const [editing, setEditing] = useState<Task | null>(null)
  const [skipping, setSkipping] = useState(false)
  const task = stop?.task
  const apiTask = trip.tasks.find((t) => t.taskId === task?.taskId) ?? null

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
        open={!!stop && !editing}
        onOpenChange={(o) => !o && !skipping && onClose()}
        title={stop?.title ?? ''}
        footer={
          task &&
          stop?.status === 'upcoming' && (
            <div className="grid grid-cols-2 gap-3">
              <Button variant="secondary" onClick={() => setEditing(apiTask)} disabled={skipping}>
                <T k="Edit" />
              </Button>
              <Button variant="destructive" loading={skipping} loadingLabel="Skipping…" icon={<Ban size={20} strokeWidth={1.75} aria-hidden="true" />} onClick={skip}>
                <T k="Skip it" />
              </Button>
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
              {task.fixedStart && <Tag tone="ink">Fixed {task.fixedStart}</Tag>}
              {task.window && <Tag tone="green-outline">Open till {task.window.closesAt}</Tag>}
              <Tag tone="grey-outline">{task.priority === 1 ? 'Must do' : task.priority === 2 ? 'Should do' : 'If there is time'}</Tag>
            </div>
            {stop.status === 'done' && <p className="t-body text-ink-2">You checked in here.</p>}
            {stop.status === 'now' && <p className="t-body text-ink-2">You're here now. If it runs over, use Running late.</p>}
            {stop.status === 'upcoming' && <p className="t-small text-ink-2">Skipping moves your later stops up. You can undo it.</p>}
          </div>
        )}
      </Sheet>
      <TaskFormSheet trip={trip} open={!!editing} onOpenChange={(o) => !o && setEditing(null)} initial={editing} onSave={save} />
    </>
  )
}
