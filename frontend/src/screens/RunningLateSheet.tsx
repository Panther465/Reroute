import { CircleCheck, Info, TriangleAlert } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { ApiError, newKey } from '@/api/client'
import { useDay } from '@/api/queries'
import type { CheckinResult, Option, Task, Trip } from '@/api/types'
import { OptionCards, type OptionCardData } from '@/components/OptionCard'
import { Button } from '@/components/ui/Button'
import { ChipGroup } from '@/components/ui/Choice'
import { Field } from '@/components/ui/Field'
import { Sheet } from '@/components/ui/Sheet'
import { acceptOption, applyServerChange, isOptionsChanged, playLater, playTaskEdit, refetchTrip, reportDelay, saveTaskEdit, sendSkip, SKIP_TOAST } from '@/lib/actions'
import { duration, lowerFirst } from '@/lib/format'
import { T, useTl } from '@/lib/i18n'
import { setState, showToast } from '@/lib/store'
import { TaskFormSheet } from './TaskForm'

type Chip = '15' | '40' | '60' | 'other'

const REASON_TAGS: Record<string, string> = {
  FASTER_MODE: 'Faster by cab',
  TASK_MOVED_TOMORROW: 'Moves a task to tomorrow',
  TASK_SKIPPED: 'Skips a task',
  RAASTA_VERIFIED: 'Uses a verified shared auto',
  RAASTA_UNVERIFIED: 'Unverified route shown as an extra',
  LAST_TRIP_PASSED: 'Last shared auto has gone',
  HOURS_UNKNOWN: 'Opening hours not known',
}

function toCard(o: Option): OptionCardData {
  const tags = o.reasonCodes.map((c) => REASON_TAGS[c]).filter(Boolean)
  if (o.timeSavedMin > 0) tags.unshift(`Saves about ${duration(o.timeSavedMin)}`)
  if (o.kind === 'faster_mode' && o.movedTasks.length === 0) tags.push('Keeps every task today')
  if (o.kind === 'move_task') tags.unshift('Cheapest')
  return { optionId: o.optionId, label: o.label, extraFareInr: o.extraFareInr, consequence: o.consequence, tags: [...new Set(tags)] }
}

type Options = { kind: 'options'; explanation: string; options: Option[]; optionSetId: string | null; changed?: boolean }
type Blocked = { kind: 'blocked'; reason: string; task: Task | null }
type Phase = { kind: 'pick' } | Options | Blocked | { kind: 'confirmSkip'; task: Task; back: Blocked } | { kind: 'pending' }

const optionsFrom = (set: NonNullable<Trip['openOptions']>, changed = false): Options => ({ kind: 'options', explanation: set.explanation, options: set.options, optionSetId: set.optionSetId, changed })

export function RunningLateSheet({
  trip,
  clock,
  open,
  onOpenChange,
  initialDelay,
  mode,
}: {
  trip: Trip | undefined
  /** The running trip clock (minutes), so the sheet asks about the task the timeline shows as current. */
  clock?: number | null
  open: boolean
  onOpenChange: (o: boolean) => void
  initialDelay: number | null
  mode: 'late' | 'options'
}) {
  const tl = useTl()
  const [chip, setChip] = useState<Chip | null>(null)
  const [other, setOther] = useState('')
  const [choice, setChoice] = useState('')
  const [phase, setPhase] = useState<Phase>({ kind: 'pick' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  // The blocked task being edited from here. The sheet steps aside while its form is open.
  const [editing, setEditing] = useState<Task | null>(null)
  // One key per action: a retry of the same "Reroute my day" never applies it twice.
  const keysRef = useRef({ delay: newKey('late'), accept: newKey('acc'), skip: newKey('skip') })
  const view = useDay(trip, clock)
  const task = view?.stops[view.nowIndex]?.kind === 'task' && view.stops[view.nowIndex].task!.state !== 'done' ? view.stops[view.nowIndex].task! : (view?.checkInTask ?? null)

  // Start fresh only when the sheet opens. A refetch of the trip while it is open (the 60 s refresh,
  // a live event, the options arriving) must never throw the traveller back to the delay chips.
  const wasOpen = useRef(false)
  useEffect(() => {
    const opening = open && !wasOpen.current
    wasOpen.current = open
    if (!opening) return
    keysRef.current = { delay: newKey('late'), accept: newKey('acc'), skip: newKey('skip') }
    setError(undefined)
    setChoice('')
    setEditing(null)
    const d = initialDelay
    setChip(d === 15 || d === 40 || d === 60 ? (String(d) as Chip) : d ? 'other' : null)
    setOther(d && ![15, 40, 60].includes(d) ? String(d) : '')
    if (mode === 'options' && trip?.openOptions) setPhase(optionsFrom(trip.openOptions))
    else setPhase({ kind: 'pick' })
  }, [open, initialDelay, mode, trip?.openOptions])

  // Still working on it: the options arrive with the trip.
  useEffect(() => {
    if (open && phase.kind === 'pending' && trip?.openOptions) setPhase(optionsFrom(trip.openOptions))
  }, [open, phase.kind, trip?.openOptions])

  // Options from the check-in answer may come without their set's ID; it follows on the trip.
  useEffect(() => {
    if (phase.kind === 'options' && !phase.optionSetId && trip?.openOptions?.optionSetId) {
      const id = trip.openOptions.optionSetId
      setPhase((p) => (p.kind === 'options' && !p.optionSetId ? { ...p, optionSetId: id } : p))
    }
  }, [phase, trip?.openOptions?.optionSetId])

  const otherNum = Number(other)
  const otherError = chip === 'other' && other !== '' && (!Number.isInteger(otherNum) || otherNum < 5 || otherNum > 240) ? 'Enter a delay between 5 and 240 minutes.' : undefined
  const delay = chip === 'other' ? (otherError || !other ? null : otherNum) : chip ? Number(chip) : null

  useEffect(() => {
    if (open && phase.kind === 'pick') setState({ pendingDelay: delay })
  }, [delay, open, phase.kind])

  // A new delay is a new action.
  useEffect(() => {
    keysRef.current.delay = newKey('late')
  }, [delay])

  if (!trip || !view) return null
  const tripId = trip.tripId
  const close = () => onOpenChange(false)

  const send = async () => {
    if (!task || !delay) return
    setBusy(true)
    setError(undefined)
    const before = view
    let res: CheckinResult
    let optionSetId: string | null = null
    try {
      res = await reportDelay(tripId, task.taskId, delay, keysRef.current.delay)
      // Accepting names the option set it came from; the set's ID comes with the trip.
      if (res.result === 'options') optionSetId = (await refetchTrip(tripId).catch(() => null))?.openOptions?.optionSetId ?? null
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't reach Reroute. Try again.")
      setBusy(false)
      return
    }
    setBusy(false)
    if (res.result === 'shifted') {
      close()
      playLater(() => applyServerChange(tripId, before, { kind: 'reroute', toast: `Times updated. Your later stops moved ${delay} min.`, undo: true }))
    } else if (res.result === 'options') {
      setPhase({ kind: 'options', explanation: res.explanation, options: res.options ?? [], optionSetId })
    } else if (res.result === 'no_feasible_plan') {
      const blockedTask = res.blocked ? (trip.tasks.find((x) => x.taskId === res.blocked!.taskId) ?? null) : null
      const reason = res.blocked?.reason ? `${res.blocked.reason.replace(/\.$/, '')}.` : res.explanation
      setPhase({ kind: 'blocked', reason, task: blockedTask && blockedTask.state !== 'done' && blockedTask.state !== 'skipped' ? blockedTask : null })
    } else if (res.result === 'pending') {
      setPhase({ kind: 'pending' })
    } else {
      close()
      playLater(() => applyServerChange(tripId, before, { kind: 'checkin', toast: "You're still on time. Nothing changed." }))
    }
  }

  const options = phase.kind === 'options' ? phase.options : []
  const selected = options.find((o) => o.optionId === choice) ?? options[0]

  /** The option set changed under the traveller: show the fresh one, never apply anything silently. */
  const showFreshOptions = async () => {
    try {
      const fresh = await refetchTrip(tripId)
      keysRef.current.accept = newKey('acc')
      setChoice('')
      if (fresh.openOptions) {
        setPhase(optionsFrom(fresh.openOptions, true))
      } else {
        close()
        showToast({ title: 'Your plan changed while you were choosing. Check your timeline.' })
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load your options. Try again.")
    }
  }

  const accept = async () => {
    if (!selected || phase.kind !== 'options') return
    setBusy(true)
    setError(undefined)
    try {
      // The sheet stays open, with "Rerouting…" on the button, until the server has applied it.
      await acceptOption(tripId, selected.optionId, phase.optionSetId, keysRef.current.accept)
    } catch (err) {
      if (isOptionsChanged(err)) await showFreshOptions()
      else setError(err instanceof ApiError ? err.message : "Couldn't reroute. Try again.")
      setBusy(false)
      return
    }
    setBusy(false)
    close()
    playLater(() => applyServerChange(tripId, view, { kind: 'reroute', toast: `Day rerouted. ${selected.consequence.replace(/\.$/, '')}.`, undo: true }))
  }

  const skip = async (skipTask: Task) => {
    setBusy(true)
    setError(undefined)
    try {
      await sendSkip(tripId, skipTask.taskId, keysRef.current.skip)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't skip it. Try again.")
      setBusy(false)
      return
    }
    setBusy(false)
    close()
    playLater(() => applyServerChange(tripId, view, { kind: 'reroute', toast: SKIP_TOAST, undo: true }))
  }

  const name = (t: Task) => lowerFirst(t.title)
  const title =
    phase.kind === 'options'
      ? tl('Choose how to fix your day')
      : phase.kind === 'blocked'
        ? { text: 'Today no longer fits' }
        : phase.kind === 'confirmSkip'
          ? { text: `Skip the ${name(phase.task)}?` }
          : task
            ? { text: view.stops[view.nowIndex]?.id === task.taskId ? `How late will the ${lowerFirst(task.title)} run?` : 'How late will you leave?' }
            : { text: 'Your day is done' }

  const keep = (
    <Button variant="tertiary" size="md" className="self-center" onClick={close} disabled={busy}>
      <T k="Keep the current plan" />
    </Button>
  )

  let footer = null
  if (phase.kind === 'pick' && delay) {
    footer = (
      <Button full loading={busy} loadingLabel={<T k="Rerouting…" />} onClick={send}>
        <T k="Update my times" />
      </Button>
    )
  } else if (phase.kind === 'options' && selected) {
    footer = (
      <div className="flex flex-col gap-2">
        <Button full loading={busy} loadingLabel={<T k="Rerouting…" />} onClick={accept}>
          <T k="Reroute my day" />
        </Button>
        {keep}
      </div>
    )
  } else if (phase.kind === 'options' || phase.kind === 'blocked') {
    const blocked = phase.kind === 'blocked' ? phase.task : null
    footer = (
      <div className="flex flex-col gap-2">
        {blocked && (
          <div className="grid grid-cols-2 gap-3">
            <Button variant="secondary" onClick={() => setEditing(blocked)}>
              <T k="Edit the {task}" vars={{ task: name(blocked) }} />
            </Button>
            <Button variant="destructive" onClick={() => setPhase({ kind: 'confirmSkip', task: blocked, back: phase as Blocked })}>
              <T k="Skip the {task}" vars={{ task: name(blocked) }} />
            </Button>
          </div>
        )}
        {keep}
      </div>
    )
  } else if (phase.kind === 'confirmSkip') {
    footer = (
      <div className="flex flex-col gap-2">
        <Button variant="destructive" full loading={busy} loadingLabel="Skipping…" onClick={() => void skip(phase.task)}>
          <T k="Skip it" />
        </Button>
        <Button variant="tertiary" size="md" className="self-center" onClick={() => setPhase(phase.back)} disabled={busy}>
          <T k="Cancel" />
        </Button>
      </div>
    )
  }

  return (
    <>
      <Sheet open={open && !editing} onOpenChange={(o) => !busy && onOpenChange(o)} title={title.text} titleLang={title.lang} footer={footer}>
        {phase.kind === 'pick' && task && (
          <div className="flex flex-col gap-4">
            <ChipGroup<Chip>
              legend="How late"
              name="delay"
              value={chip}
              onChange={setChip}
              options={[
                { value: '15', label: 'About 15 min' },
                { value: '40', label: 'About 40 min' },
                { value: '60', label: 'About 1 h' },
                { value: 'other', label: 'Other' },
              ]}
            />
            {chip === 'other' && <Field label="Delay in minutes" inputMode="numeric" type="number" min={5} max={240} value={other} onChange={(e) => setOther(e.target.value)} error={otherError} className="max-w-56" autoFocus />}
            {!delay && <p className="t-body text-ink-2">Pick how late you expect to be. We'll show you what changes before anything moves.</p>}
            {delay && (
              <p className="flex gap-3 rounded-card bg-sunken p-4 t-body text-ink">
                <CircleCheck size={20} strokeWidth={1.75} aria-hidden="true" className="mt-0.5 shrink-0 text-green-ink" />
                If the day still fits, every later stop moves {delay} minutes. If it doesn't, you choose what changes.
              </p>
            )}
          </div>
        )}
        {phase.kind === 'options' && (
          <div>
            {phase.changed && (
              <p role="status" className="mb-4 flex gap-3 rounded-card bg-sunken p-4 t-body text-ink">
                <Info size={20} strokeWidth={1.75} aria-hidden="true" className="mt-0.5 shrink-0" />
                Your options changed. Check them again.
              </p>
            )}
            <p className="mb-4 t-body text-ink">{phase.explanation}</p>
            {options.length > 0 ? (
              <OptionCards name="replan" legend="Ways to fix the rest of today" options={options.map(toCard)} value={selected?.optionId ?? ''} onChange={setChoice} />
            ) : (
              <p className="t-body text-red-ink">Nothing fits today. Keep the current plan for now, or change or skip a task from its stop on the timeline.</p>
            )}
            {selected && <p className="mt-3 t-small text-ink-2">{selected.explanation} Times and fares are estimates; nothing is booked.</p>}
          </div>
        )}
        {phase.kind === 'blocked' && (
          <div>
            <p role="alert" className="flex gap-3 rounded-card bg-red-tint p-4 t-body text-red-ink">
              <TriangleAlert size={20} strokeWidth={1.75} aria-hidden="true" className="mt-0.5 shrink-0" />
              {phase.reason}
            </p>
            <p className="mt-4 t-body text-ink-2">
              {phase.task ? `Change the ${name(phase.task)} or skip it, or keep your current plan for now.` : 'Keep your current plan for now. You can change or skip a task from its stop on the timeline.'}
            </p>
          </div>
        )}
        {phase.kind === 'confirmSkip' && <p className="t-body text-ink-2">Your later stops move up. You can undo it from the toast or the Reroute log.</p>}
        {phase.kind === 'pending' && (
          <p className="t-body text-ink-2" role="status">
            Reroute is still working on your day. Your timeline updates as soon as it's ready.
          </p>
        )}
        {error && (
          <p role="alert" className="mt-4 flex items-start gap-2 t-small text-red-ink">
            <TriangleAlert size={20} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
            {error}
          </p>
        )}
      </Sheet>
      {editing && (
        <TaskFormSheet
          trip={trip}
          open
          initial={editing}
          onOpenChange={(o) => !o && setEditing(null)}
          onSave={async (body, _initial, stage) => {
            const outcome = await saveTaskEdit(tripId, editing.taskId, body, () => stage('replanning'))
            setEditing(null)
            close()
            playLater(() => playTaskEdit(tripId, view, outcome))
          }}
        />
      )}
    </>
  )
}
