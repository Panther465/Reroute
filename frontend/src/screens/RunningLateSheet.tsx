import { CircleCheck, TriangleAlert } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ApiError, newKey } from '@/api/client'
import { keys, queryClient } from '@/api/queries'
import type { CheckinResult, Option, Trip } from '@/api/types'
import { OptionCards, type OptionCardData } from '@/components/OptionCard'
import { Button } from '@/components/ui/Button'
import { ChipGroup } from '@/components/ui/Choice'
import { Field } from '@/components/ui/Field'
import { Sheet } from '@/components/ui/Sheet'
import { acceptOption, applyServerChange, reportDelay } from '@/lib/actions'
import { duration, lowerFirst } from '@/lib/format'
import { useT } from '@/lib/i18n'
import { setState } from '@/lib/store'
import { buildDay } from '@/lib/timeline'

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

type Phase = { kind: 'pick' } | { kind: 'options'; explanation: string; options: Option[] } | { kind: 'blocked'; reason: string } | { kind: 'pending' }

export function RunningLateSheet({ trip, open, onOpenChange, initialDelay, mode }: { trip: Trip | undefined; open: boolean; onOpenChange: (o: boolean) => void; initialDelay: number | null; mode: 'late' | 'options' }) {
  const t = useT()
  const [chip, setChip] = useState<Chip | null>(null)
  const [other, setOther] = useState('')
  const [choice, setChoice] = useState('')
  const [phase, setPhase] = useState<Phase>({ kind: 'pick' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  // One key per action: a retry of the same "Reroute my day" never applies it twice.
  const keysRef = useRef({ delay: newKey('late'), accept: newKey('acc') })
  const view = useMemo(() => (trip ? buildDay(trip) : null), [trip])
  const task = view?.stops[view.nowIndex]?.kind === 'task' && view.stops[view.nowIndex].task!.state !== 'done' ? view.stops[view.nowIndex].task! : (view?.checkInTask ?? null)

  useEffect(() => {
    if (!open) return
    keysRef.current = { delay: newKey('late'), accept: newKey('acc') }
    setError(undefined)
    setChoice('')
    const d = initialDelay
    setChip(d === 15 || d === 40 || d === 60 ? (String(d) as Chip) : d ? 'other' : null)
    setOther(d && ![15, 40, 60].includes(d) ? String(d) : '')
    if (mode === 'options' && trip?.openOptions) setPhase({ kind: 'options', explanation: trip.openOptions.explanation, options: trip.openOptions.options })
    else setPhase({ kind: 'pick' })
  }, [open, initialDelay, mode, trip?.openOptions])

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
  const close = () => onOpenChange(false)

  const send = async () => {
    if (!task || !delay) return
    setBusy(true)
    setError(undefined)
    const before = view
    try {
      const res: CheckinResult = await reportDelay(trip.tripId, task.taskId, delay, keysRef.current.delay)
      if (res.result === 'shifted') {
        close()
        await applyServerChange(trip.tripId, before, { kind: 'reroute', toast: `Times updated. Your later stops moved ${delay} min.`, undo: true })
      } else if (res.result === 'options') {
        setPhase({ kind: 'options', explanation: res.explanation, options: res.options ?? [] })
        void queryClient.invalidateQueries({ queryKey: keys.trip(trip.tripId) })
      } else if (res.result === 'no_feasible_plan') {
        setPhase({ kind: 'blocked', reason: res.blocked?.reason ? `${res.blocked.reason}. Move it to another day from the Plan tab, or change it.` : res.explanation })
      } else if (res.result === 'pending') {
        setPhase({ kind: 'pending' })
      } else {
        close()
        await applyServerChange(trip.tripId, before, { kind: 'checkin', toast: "You're still on time. Nothing changed." })
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't reach Reroute. Try again.")
    } finally {
      setBusy(false)
    }
  }

  const options = phase.kind === 'options' ? phase.options : []
  const selected = options.find((o) => o.optionId === choice) ?? options[0]

  const accept = async () => {
    if (!selected) return
    setBusy(true)
    setError(undefined)
    try {
      close()
      await acceptOption(trip.tripId, selected.optionId, keysRef.current.accept, view, selected.consequence)
    } catch (err) {
      onOpenChange(true)
      setError(err instanceof ApiError ? err.message : "Couldn't reroute. Try again.")
    } finally {
      setBusy(false)
    }
  }

  const title = phase.kind === 'options' ? 'Choose how to fix your day' : task ? (view.stops[view.nowIndex]?.id === task.taskId ? `How late will the ${lowerFirst(task.title)} run?` : 'How late will you leave?') : 'Your day is done'

  let footer = null
  if (phase.kind === 'pick' && delay) {
    footer = (
      <Button full loading={busy} loadingLabel={t('Rerouting…')} onClick={send}>
        {t('Update my times')}
      </Button>
    )
  } else if (phase.kind === 'options' && selected) {
    footer = (
      <div className="flex flex-col gap-2">
        <Button full loading={busy} loadingLabel={t('Rerouting…')} onClick={accept}>
          {t('Reroute my day')}
        </Button>
        <Button variant="tertiary" size="md" className="self-center" onClick={close}>
          {t('Keep the current plan')}
        </Button>
      </div>
    )
  }

  return (
    <Sheet open={open} onOpenChange={(o) => !busy && onOpenChange(o)} title={title} footer={footer}>
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
          <p className="mb-4 t-body text-ink">{phase.explanation}</p>
          {options.length > 0 ? (
            <OptionCards name="replan" legend="Ways to fix the rest of today" options={options.map(toCard)} value={selected?.optionId ?? ''} onChange={setChoice} />
          ) : (
            <p className="t-body text-red-ink">Nothing fits today. Move a task to tomorrow from the Plan tab.</p>
          )}
          {selected && <p className="mt-3 t-small text-ink-2">{selected.explanation} Times and fares are estimates; nothing is booked.</p>}
        </div>
      )}
      {phase.kind === 'blocked' && (
        <p role="alert" className="flex gap-3 rounded-card bg-red-tint p-4 t-body text-red-ink">
          <TriangleAlert size={20} strokeWidth={1.75} aria-hidden="true" className="mt-0.5 shrink-0" />
          {phase.reason}
        </p>
      )}
      {phase.kind === 'pending' && <p className="t-body text-ink-2" role="status">Reroute is still working on your day. Your timeline updates as soon as it's ready.</p>}
      {error && (
        <p role="alert" className="mt-4 flex items-start gap-2 t-small text-red-ink">
          <TriangleAlert size={20} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
          {error}
        </p>
      )}
    </Sheet>
  )
}
