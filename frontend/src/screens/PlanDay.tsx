import { CalendarDays, CalendarPlus, ChevronRight, Hotel, MapPin, Plus, Sparkles, TriangleAlert } from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'
import { EASE_OUT } from '@/lib/motion'
import { useSubmitKey } from '@/lib/submitKey'
import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { api, ApiError, newKey } from '@/api/client'
import { keys, queryClient, useAiHelperEnabled, useCurrentTripId, useTrip, waitForJob } from '@/api/queries'
import type { Body, JobAccepted, Place, Task, TaskDraft, TaskIn, Trip, TripIn } from '@/api/types'
import { PlacePicker } from '@/components/PlacePicker'
import { TripSwitcher } from '@/components/TripSwitcher'
import { Button } from '@/components/ui/Button'
import { Field, FieldError } from '@/components/ui/Field'
import { Sheet } from '@/components/ui/Sheet'
import { Banner, ErrorState, LoadingRegion, Skeleton } from '@/components/ui/States'
import { DurationTag, FixedTag, HoursTag, PriorityTag, Tag } from '@/components/ui/Tag'
import { addTask, moveTaskToDay, saveTaskEdit, type EditOutcome } from '@/lib/actions'
import { duration, hhmm } from '@/lib/format'
import { CALENDAR_SCOPE, googleEnabled, requestGoogleCode } from '@/lib/google'
import { useDocumentTitle, useOnline } from '@/lib/hooks'
import { T } from '@/lib/i18n'
import { StopIcon } from '@/lib/stopIcon'
import { nextToken, setState, showToast } from '@/lib/store'
import { addDays, buildDay, dayLabel, localMinutes, weekday } from '@/lib/timeline'
import { AiPlannerSheet } from './AiPlannerSheet'
import { TaskFormSheet, tripDays } from './TaskForm'

function TaskTags({ task, trip }: { task: Task; trip: Trip }) {
  return (
    <span className="mt-2 flex flex-wrap gap-2">
      {task.fixedStart && <FixedTag at={hhmm(localMinutes(task.fixedStart, task.day, trip.utcOffset))} />}
      {task.window && <HoursTag closesAt={task.window.closesAt} />}
      {task.durationMin > 0 && <DurationTag min={task.durationMin} />}
      <PriorityTag priority={task.priority} />
      {task.state === 'done' && <Tag tone="green">Done</Tag>}
      {task.state === 'skipped' && <Tag tone="sunken">Skipped</Tag>}
      {task.state === 'moved' && <Tag tone="sunken">Moved to {weekday(task.day)}</Tag>}
    </span>
  )
}

/** Order within a day, in minutes after midnight: planned time, else fixed time, else opening time. */
function sortKey(t: Task, trip: Trip, planned: Map<string, { start: number }>) {
  const when = planned.get(t.taskId)
  if (when) return when.start
  if (t.fixedStart) return localMinutes(t.fixedStart, t.day, trip.utcOffset)
  return t.window ? Number(t.window.opensAt.slice(0, 2)) * 60 + Number(t.window.opensAt.slice(3)) : 24 * 60
}

/** One task: its icon, name and place, when it's planned, its tags, and anything wrong with it. */
function TaskRow({
  task,
  trip,
  when,
  issue,
  disabled,
  onOpen,
  move,
}: {
  task: Task
  trip: Trip
  when?: { start: number; end: number }
  issue?: string
  disabled: boolean
  onOpen: () => void
  /** The fix for a task that can't fit today: move it to the next day (beside the row, not inside its button). */
  move?: { label: string; busy: boolean; onMove: () => void }
}) {
  const done = task.state === 'done' || task.state === 'skipped'
  return (
    <li>
      <button type="button" disabled={disabled || done} onClick={onOpen} className="flex w-full items-start gap-3 px-4 py-4 text-left disabled:cursor-default [@media(hover:hover)]:hover:enabled:bg-sunken/60">
        <StopIcon title={task.title} size={20} className={`mt-0.5 shrink-0 ${done ? 'text-muted' : issue ? 'text-red-ink' : 'text-ink-2'}`} />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline justify-between gap-x-3">
            <span className={`t-title ${done ? 'text-ink-2 line-through decoration-1' : 'text-ink'}`}>{task.title}</span>
            {when && !done && (
              <span className="t-small font-bold text-ink tnum">
                {hhmm(when.start)} to {hhmm(when.end)}
              </span>
            )}
          </span>
          <span className="block t-small text-muted">
            {task.place.name}, {task.place.area}
          </span>
          <TaskTags task={task} trip={trip} />
          {issue && (
            <span className="mt-2 flex items-start gap-1.5 t-small text-red-ink">
              <TriangleAlert size={16} strokeWidth={1.75} aria-hidden="true" className="mt-0.5 shrink-0" />
              {issue}
            </span>
          )}
        </span>
        {!done && !disabled && <ChevronRight size={20} strokeWidth={1.75} aria-hidden="true" className="mt-2.5 shrink-0 text-muted" />}
      </button>
      {move && (
        <div className="-mt-1 pb-4 pl-[4.25rem] pr-4">
          <Button variant="secondary" size="md" loading={move.busy} loadingLabel="Moving…" disabled={disabled} onClick={move.onMove}>
            {move.label}
          </Button>
        </div>
      )}
    </li>
  )
}

/** Three stations drawing once: the planning reveal. */
export function DrawLine({ className = '' }: { className?: string }) {
  const reduce = useReducedMotion()
  return (
    <svg viewBox="0 0 120 24" className={`h-6 w-30 ${className}`} aria-hidden="true">
      <motion.path d="M10 12H110" stroke="var(--green)" strokeWidth="6" strokeLinecap="round" fill="none" initial={{ pathLength: reduce ? 1 : 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.6, ease: EASE_OUT }} />
      {[10, 60, 110].map((x, i) => (
        <motion.circle
          key={x}
          cx={x}
          cy={12}
          r={6.5}
          fill="var(--surface)"
          stroke="var(--ink)"
          strokeWidth="3"
          initial={reduce ? false : { scale: 0.6, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ delay: i * 0.2 + 0.05, duration: 0.24, ease: EASE_OUT }}
          style={{ transformOrigin: `${x}px 12px` }}
        />
      ))}
    </svg>
  )
}

function todayIso() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * Start a trip on one screen: where you're staying, which days (today unless you change it) and,
 * if you like, what you need to do. Bengaluru is the city Reroute covers so far.
 */
function StartForm({ onCreated }: { onCreated: (trip: Trip, text: string) => void }) {
  const [start, setStart] = useState(todayIso)
  const [end, setEnd] = useState('')
  const [pickDates, setPickDates] = useState(false)
  const [stay, setStay] = useState<Place | null>(null)
  const [text, setText] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const { key, after } = useSubmitKey('trip')
  const ai = useAiHelperEnabled()
  const describing = ai && text.trim().length >= 3

  const create = async () => {
    const e: Record<string, string> = {}
    if (!start) e.start = 'Choose the first day.'
    if (end && start && end < start) e.end = 'The last day must be on or after the first day.'
    if (!stay) e.stay = 'Choose where you are staying.'
    setErrors(e)
    if (Object.keys(e).length) return
    const body: Body<TripIn> = { citySlug: 'bengaluru', cityName: 'Bengaluru', startDate: start, endDate: end || start, stayPlaceId: stay!.placeId, stayLabel: stay!.name }
    setBusy(true)
    try {
      const trip = await api.post<Trip>('/v1/trips', body, { idempotencyKey: key })
      queryClient.setQueryData(keys.trip(trip.tripId), trip)
      // The trip list decides which trip the app shows: it must include the new one first.
      await queryClient.refetchQueries({ queryKey: keys.trips })
      onCreated(trip, describing ? text.trim() : '')
    } catch (err) {
      after(err)
      setErrors({ form: err instanceof ApiError ? err.message : "Couldn't create the trip. Try again." })
      setBusy(false)
    }
  }

  const today = todayIso()
  const dates = start === (end || start) ? (start === today ? `Today, ${dayLabel(start)}` : dayLabel(start)) : `${dayLabel(start)} to ${dayLabel(end)}`
  return (
    <div className="mt-6 flex flex-col gap-6">
      <PlacePicker label="Where are you staying?" city="bengaluru" value={stay} onChange={setStay} error={errors.stay} hint="Your hotel or where you sleep in Bengaluru. Search by name or area." />
      {pickDates ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="First day" type="date" value={start} onChange={(e) => setStart(e.target.value)} error={errors.start} />
          <Field label="Last day" type="date" value={end} min={start} onChange={(e) => setEnd(e.target.value)} error={errors.end} hint="Leave empty for a one-day trip" />
        </div>
      ) : (
        <div>
          <p className="mb-1 t-title text-ink">When</p>
          <p className="flex flex-wrap items-center gap-x-3 t-body text-ink">
            {dates}
            <Button variant="tertiary" size="md" className="-ml-2" onClick={() => setPickDates(true)}>
              Change dates
            </Button>
          </p>
        </div>
      )}
      {ai && (
      <div>
        <label htmlFor="start-describe" className="mb-1 block t-title text-ink">
          What do you need to do? <span className="t-small font-normal text-muted">Optional</span>
        </label>
        <p id="start-describe-hint" className="mb-2 t-small text-ink-2">
          Say it the way you'd tell a colleague: times and places. You'll check the tasks before anything is planned.
        </p>
        <textarea
          id="start-describe"
          aria-describedby="start-describe-hint"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          maxLength={2000}
          placeholder="Meeting at 10am in Whitefield, bank work in Koramangala, then the university office in Jayanagar"
          className="w-full resize-none rounded-control border-2 border-line bg-surface px-4 py-3 t-body text-ink placeholder:text-muted focus:border-green focus:outline-none"
        />
      </div>
      )}
      {errors.form && <FieldError id="trip-err">{errors.form}</FieldError>}
      <Button full onClick={create} loading={busy} loadingLabel="Creating your trip…" icon={describing ? <Sparkles size={20} strokeWidth={1.75} aria-hidden="true" /> : undefined}>
        {describing ? 'Plan my day' : 'Create the trip'}
      </Button>
    </div>
  )
}

function ImportSheet({ trip, open, onOpenChange, onAdded }: { trip: Trip; open: boolean; onOpenChange: (o: boolean) => void; onAdded: (n: number) => void }) {
  const [drafts, setDrafts] = useState<TaskDraft[] | null>(null)
  const [picked, setPicked] = useState<number[]>([])
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  // One key per read and one per appointment, kept while the sheet lives, so a retry never adds a task twice.
  const [readKey, setReadKey] = useState(() => newKey('cal'))
  const [draftKeys, setDraftKeys] = useState<string[]>([])

  const read = async () => {
    setBusy(true)
    setError(undefined)
    try {
      const code = await requestGoogleCode(CALENDAR_SCOPE)
      const found = await api.post<TaskDraft[]>(`/v1/trips/${trip.tripId}/calendar-import`, { code }, { idempotencyKey: readKey })
      setDraftKeys(found.map(() => newKey('imp')))
      setReadKey(newKey('cal'))
      setDrafts(found)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't read your calendar.")
    } finally {
      setBusy(false)
    }
  }

  const add = async () => {
    if (!drafts) return
    setBusy(true)
    try {
      const chosen = picked.filter((i) => drafts[i].placeId)
      // The day re-plans once, after the last appointment.
      for (const [n, i] of chosen.entries()) {
        const d = drafts[i]
        const day = d.fixedStart ? d.fixedStart.slice(0, 10) : trip.day
        await addTask(trip.tripId, { title: d.title, placeId: d.placeId!, durationMin: d.durationMin, fixedStart: d.fixedStart, priority: d.priority, hoursUnknown: false, day }, draftKeys[i], { replan: n === chosen.length - 1 })
      }
      onAdded(chosen.length)
      setDrafts(null)
      setPicked([])
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add those tasks.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Import from Google Calendar"
      description="Reroute reads your appointments for the trip's dates, once, and saves nothing until you add them."
      footer={
        drafts ? (
          <Button full disabled={picked.length === 0} loading={busy} loadingLabel="Adding…" onClick={add}>
            {picked.length === 0 ? 'Pick an appointment to add' : `Add ${picked.length} ${picked.length === 1 ? 'task' : 'tasks'}`}
          </Button>
        ) : (
          <Button full loading={busy} loadingLabel="Opening Google…" onClick={read} icon={<CalendarPlus size={20} strokeWidth={1.75} aria-hidden="true" />}>
            Allow read-only access
          </Button>
        )
      }
    >
      {error && <FieldError id="import-err">{error}</FieldError>}
      {drafts && drafts.length === 0 && <p className="t-body text-ink-2">No timed appointments on these days.</p>}
      {drafts && drafts.length > 0 && (
        <ul className="divide-y divide-line rounded-card border border-line">
          {drafts.map((d, i) => {
            const id = `ev-${i}`
            const disabled = !d.placeId
            return (
              <li key={id} className="flex items-start gap-3 px-4 py-3">
                <input id={id} type="checkbox" disabled={disabled} checked={picked.includes(i)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, i] : p.filter((x) => x !== i)))} className="mt-1 size-6 shrink-0 accent-[var(--green)]" />
                <label htmlFor={id} className={`min-w-0 flex-1 ${disabled ? 'cursor-default' : ''}`}>
                  <span className="block t-title text-ink">{d.title}</span>
                  <span className="block t-small text-ink-2 tnum">
                    {d.fixedStart ? hhmm(localMinutes(d.fixedStart, d.fixedStart.slice(0, 10), trip.utcOffset)) : ''}, {duration(d.durationMin)}
                    {d.placeText ? `, ${d.placeText}` : ''}
                  </span>
                  {disabled && <span className="mt-1 block t-small text-muted">We couldn't match the place. Add it by hand.</span>}
                </label>
              </li>
            )
          })}
        </ul>
      )}
    </Sheet>
  )
}

export default function PlanDay() {
  const navigate = useNavigate()
  const current = useCurrentTripId()
  const tripQ = useTrip(current.tripId)
  const trip = tripQ.data
  const online = useOnline()
  const [form, setForm] = useState<{ open: boolean; task: Task | null }>({ open: false, task: null })
  const [aiOpen, setAiOpen] = useState(false)
  const ai = useAiHelperEnabled()
  const [importOpen, setImportOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  // A trip just started with "What do you need to do?": its text goes straight to the task check.
  const [startText, setStartText] = useState<{ tripId: string; text: string } | null>(null)
  const [planning, setPlanning] = useState<'idle' | 'busy' | 'drawing'>('idle')
  const [error, setError] = useState<string>()
  const [planKey, setPlanKey] = useState(() => newKey('plan'))
  // One key per "Add a task" form: retries of the same submission never create the task twice.
  const [createKey, setCreateKey] = useState(() => newKey('task'))
  useDocumentTitle(trip?.activePlan ? 'Your trip' : 'New trip')
  const location = useLocation()
  // Roo's "Describe my day" lands here with the sheet open, "Start a new trip" from Your trips with the
  // start form; clear the flag so Back doesn't repeat it.
  useEffect(() => {
    const state = location.state as { openAi?: boolean; newTrip?: boolean; addTask?: boolean } | null
    if (state?.openAi) setAiOpen(true)
    if (state?.addTask) openForm(null)
    if (state?.newTrip) setCreating(true)
    if (state?.openAi || state?.newTrip || state?.addTask) navigate(location.pathname, { replace: true, state: null })
  }, [location.state, location.pathname, navigate])
  const [tripsOpen, setTripsOpen] = useState(false)
  const [moving, setMoving] = useState<string | null>(null)
  const openForm = (task: Task | null) => {
    if (!task) setCreateKey(newKey('task'))
    setForm({ open: true, task })
  }

  if (current.isPending || (current.tripId && tripQ.isPending)) {
    return (
      <div className="mx-auto max-w-[560px] px-5 pt-6 lg:max-w-[720px] lg:px-8 lg:pt-8">
        <LoadingRegion label="Loading your trip">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="mt-6 h-12 w-full" />
          <Skeleton className="mt-4 h-12 w-full" />
          <Skeleton className="mt-8 h-56 w-full rounded-card" />
        </LoadingRegion>
      </div>
    )
  }

  if ((current.isError || tripQ.isError) && !trip) {
    return (
      <div className="mx-auto max-w-[560px] px-5 pt-6">
        <h1 tabIndex={-1} className="t-display-1 text-ink">
          <T k="New trip" />
        </h1>
        <div className="mt-6">
          {online ? <ErrorState message="Couldn't load your trip. Check your connection and try again." onRetry={() => current.refetch()} /> : <Banner tone="offline">You're offline. Connect to start a new trip.</Banner>}
        </div>
      </div>
    )
  }

  const onCreated = (created: Trip, text: string) => {
    setState({ tripId: created.tripId })
    setCreating(false)
    if (text) setStartText({ tripId: created.tripId, text })
    else showToast({ title: 'Trip created. Now add what you need to do.' })
  }

  if (!trip || creating) {
    return (
      <div className="mx-auto max-w-[560px] px-5 pb-10 pt-6 lg:max-w-[720px] lg:px-8 lg:pt-8">
        <h1 tabIndex={-1} className="t-display-1 text-ink">
          {creating ? <T k="New trip" /> : 'Plan your day'}
        </h1>
        <p className="mt-2 t-body text-ink-2">Reroute works out the order, when to leave, how to get there and what it costs, and re-plans when you run late. It covers Bengaluru so far.</p>
        {!online ? (
          <div className="mt-6">
            <Banner tone="offline">You're offline. Connect to start a new trip.</Banner>
          </div>
        ) : (
          <StartForm onCreated={onCreated} />
        )}
        {creating && (
          <p className="mt-4">
            <Button variant="tertiary" size="md" className="-ml-2" onClick={() => setCreating(false)}>
              Back to the current trip
            </Button>
          </p>
        )}
      </div>
    )
  }

  const today = trip.tasks.filter((x) => x.day === trip.day)
  // When each of today's tasks is planned, from the active plan.
  const planned = new Map<string, { start: number; end: number }>()
  if (trip.activePlan) {
    for (const leg of [...(trip.activePlan.doneLegs ?? []), ...trip.activePlan.legs]) {
      if (leg.taskId) planned.set(leg.taskId, { start: localMinutes(leg.taskStart, trip.activePlan.day, trip.utcOffset), end: localMinutes(leg.taskEnd, trip.activePlan.day, trip.utcOffset) })
    }
  }
  const open = trip.tasks.filter((x) => x.state !== 'done' && x.state !== 'skipped')
  // Say which tasks the active plan leaves out, so none of them quietly disappears.
  const dayView = trip.activePlan ? buildDay(trip) : null
  // A task the plan leaves out can move to the next day of the trip in one tap, as on Today.
  const leftOutIds = new Set((dayView?.leftOut ?? []).map((x) => x.taskId))
  const nextDay = addDays(trip.day, 1) <= trip.endDate ? addDays(trip.day, 1) : null
  const moveToNextDay = async (task: Task) => {
    if (!nextDay) return
    setMoving(task.taskId)
    try {
      await moveTaskToDay(trip.tripId, task.taskId, nextDay, dayView)
      showToast({ title: `The ${task.title.charAt(0).toLowerCase()}${task.title.slice(1)} moved to ${weekday(nextDay)}.` })
    } catch (err) {
      showToast({ title: err instanceof ApiError ? err.message : "Couldn't move it. Try again." })
    } finally {
      setMoving(null)
    }
  }
  const issues = new Map<string, string>([
    ...(dayView?.leftOut ?? []).map((x) => [x.taskId, x.reason] as const),
    ...(dayView?.notPlanned ?? []).map((x) => [x.taskId, 'Not in your plan yet. Plan the day again to add it.'] as const),
  ])

  // The form stays open until the save (and any re-plan) is done; a failed re-plan shows in the form.
  const saveTask = async (body: Body<TaskIn>, initial: Task | null, stage: (s: 'replanning') => void) => {
    const outcome: EditOutcome = initial
      ? await saveTaskEdit(trip.tripId, initial.taskId, body, () => stage('replanning'))
      : (await addTask(trip.tripId, body, createKey, { onReplanning: () => stage('replanning') })).outcome
    await queryClient.invalidateQueries({ queryKey: keys.trip(trip.tripId) })
    setForm({ open: false, task: null })
    const what = initial ? 'Task saved.' : 'Task added.'
    showToast({
      title:
        outcome === 'pending'
          ? `${what} Planning is taking longer than usual; your timeline updates when it finishes.`
          : outcome === 'replanned'
            ? `${what} Your day is updated.`
            : what,
    })
  }

  const removeTask = async (task: Task) => {
    await api.delete(`/v1/trips/${trip.tripId}/tasks/${task.taskId}`)
    await queryClient.invalidateQueries({ queryKey: keys.trip(trip.tripId) })
    setForm({ open: false, task: null })
    showToast({ title: `Removed the ${task.title.charAt(0).toLowerCase() + task.title.slice(1)}.` })
  }

  // `fresh`: tasks were just added, so this render's task list is out of date; the server checks instead.
  const plan = async (fresh = false) => {
    if (!fresh && !today.some((x) => x.state !== 'done' && x.state !== 'skipped')) return setError(`Add at least one task for ${dayLabel(trip.day)}.`)
    setError(undefined)
    setPlanning('busy')
    try {
      const job = await api.post<JobAccepted>(`/v1/trips/${trip.tripId}/plans`, { day: trip.day }, { idempotencyKey: planKey })
      const done = await waitForJob(job.jobId)
      if (done.status === 'failed' || done.error) throw new ApiError(409, 'NO_FEASIBLE_PLAN', done.error ?? "Couldn't plan the day. Try again.")
      setPlanning('drawing')
      const fresh = await api.get<Trip>(`/v1/trips/${trip.tripId}`)
      queryClient.setQueryData(keys.trip(trip.tripId), fresh)
      await new Promise((r) => setTimeout(r, 650))
      setState({ reveal: nextToken(), change: null, autoBanner: null })
      setPlanKey(newKey('plan'))
      navigate('/')
      const missed = buildDay(fresh)?.leftOut.length ?? 0
      if (missed) showToast({ title: `${missed === 1 ? '1 task' : `${missed} tasks`} couldn't fit today. See why on Today.` })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't plan the day. Try again.")
      setPlanning('idle')
      setPlanKey(newKey('plan'))
    }
  }

  return (
    <div className="mx-auto max-w-[560px] px-5 pb-10 pt-6 lg:max-w-[720px] lg:px-8 lg:pt-8">
      <h1 tabIndex={-1} className="t-display-1 text-ink">
        <T k={trip.activePlan ? 'Your trip' : 'New trip'} />
      </h1>
      {/* The trip at a glance: an icon names each fact, the words carry it. */}
      <dl className="mt-6 flex flex-col gap-3 rounded-card border border-line bg-surface p-4">
        {(
          [
            [MapPin, 'City', trip.cityName],
            [CalendarDays, 'Dates', trip.startDate === trip.endDate ? dayLabel(trip.startDate) : `${dayLabel(trip.startDate)} to ${dayLabel(trip.endDate)}`],
            [Hotel, 'Staying at', trip.stayLabel],
          ] as const
        ).map(([Icon, term, value]) => (
          <div key={term} className="flex items-start gap-3">
            <dt className="flex shrink-0 pt-0.5 text-muted">
              <Icon size={20} strokeWidth={1.75} aria-hidden="true" />
              <span className="sr-only">{term}</span>
            </dt>
            <dd className="t-title text-ink">{value}</dd>
          </div>
        ))}
      </dl>
      {trip.sample && <p className="mt-2 t-small text-muted">This is the sample demo trip. Its places and travel times are sample data.</p>}
      <p className="mt-2 flex flex-wrap gap-x-4">
        <Button variant="tertiary" size="md" className="-ml-2" onClick={() => setTripsOpen(true)}>
          Your trips
        </Button>
        <Button variant="tertiary" size="md" className="-ml-2" onClick={() => setCreating(true)} disabled={!online}>
          Start a new trip
        </Button>
      </p>
      <TripSwitcher open={tripsOpen} onOpenChange={setTripsOpen} />

      <section className="mt-8" aria-labelledby="tasks-h">
        <div className="flex items-end justify-between gap-3">
          <h2 id="tasks-h" className="t-display-2 text-ink">
            <T k="Your tasks" />
          </h2>
          {trip.tasks.length > 0 && <span className="t-small text-muted">{open.length} to do</span>}
        </div>
        {trip.tasks.length === 0 ? (
          <div className="mt-4 flex flex-col gap-4">
            {ai && (
            <>
            <button
              type="button"
              onClick={() => setAiOpen(true)}
              disabled={!online}
              className="group flex items-start gap-4 rounded-card border-2 border-dashed border-green bg-green-tint/50 p-5 text-left transition-colors duration-[var(--dur-quick)] [@media(hover:hover)]:hover:enabled:bg-green-tint disabled:cursor-not-allowed disabled:opacity-60"
            >
              <span className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-full bg-green text-on-green">
                <Sparkles size={22} strokeWidth={1.75} aria-hidden="true" />
              </span>
              <span>
                <span className="block t-display-2 text-ink">Describe your day</span>
                <span className="mt-1 block t-body text-ink-2">Tell me what you need to do and where. I'll turn it into tasks and work out the best route.</span>
              </span>
            </button>
            <p className="text-center t-small text-muted">or</p>
            </>
            )}
            <Button variant={ai ? 'secondary' : 'primary'} icon={<Plus size={20} strokeWidth={1.75} aria-hidden="true" />} onClick={() => openForm(null)} disabled={!online}>
              <T k="Add tasks one by one" />
            </Button>
          </div>
        ) : (
          <div className="mt-4 flex flex-col gap-6">
            {tripDays(trip).map((day) => {
              const tasks = trip.tasks.filter((t) => t.day === day)
              const openTasks = tasks.filter((t) => t.state !== 'done' && t.state !== 'skipped').sort((a, b) => sortKey(a, trip, planned) - sortKey(b, trip, planned) || a.title.localeCompare(b.title))
              const closed = tasks.filter((t) => t.state === 'done' || t.state === 'skipped')
              const headingId = `day-${day}`
              return (
                <section key={day} aria-labelledby={headingId}>
                  <div className="mb-2 flex items-center gap-2">
                    <h3 id={headingId} className="t-title text-ink">
                      {dayLabel(day)}
                    </h3>
                    {day === trip.day && <Tag tone="green">Today</Tag>}
                    <span className="ml-auto t-small text-muted">{openTasks.length === 0 ? 'Nothing to do' : `${openTasks.length} to do`}</span>
                  </div>
                  {openTasks.length > 0 ? (
                    <ul className="divide-y divide-line overflow-hidden rounded-card border border-line bg-surface">
                      {openTasks.map((task) => (
                        <TaskRow
                          key={task.taskId}
                          task={task}
                          trip={trip}
                          when={planned.get(task.taskId)}
                          issue={issues.get(task.taskId)}
                          disabled={!online}
                          onOpen={() => openForm(task)}
                          move={leftOutIds.has(task.taskId) && nextDay ? { label: `Move to ${weekday(nextDay)}`, busy: moving === task.taskId, onMove: () => void moveToNextDay(task) } : undefined}
                        />
                      ))}
                    </ul>
                  ) : (
                    <p className="rounded-card border border-dashed border-line-strong px-4 py-3 t-small text-ink-2">Nothing planned for this day yet.</p>
                  )}
                  {closed.length > 0 && (
                    <details className="group mt-2">
                      <summary className="flex min-h-12 cursor-pointer items-center gap-1.5 rounded-control t-small font-bold text-ink-2">
                        <ChevronRight size={16} strokeWidth={2} aria-hidden="true" className="transition-transform group-open:rotate-90" />
                        Done and skipped ({closed.length})
                      </summary>
                      <ul className="mt-1 divide-y divide-line overflow-hidden rounded-card border border-line bg-surface opacity-80">
                        {closed.map((task) => (
                          <TaskRow key={task.taskId} task={task} trip={trip} disabled onOpen={() => undefined} />
                        ))}
                      </ul>
                    </details>
                  )}
                </section>
              )
            })}
          </div>
        )}
        <div className="mt-4 flex flex-wrap gap-3">
          {trip.tasks.length > 0 && (
            <>
              {ai && (
                <Button variant="secondary" size="md" icon={<Sparkles size={20} strokeWidth={1.75} aria-hidden="true" />} onClick={() => setAiOpen(true)} disabled={!online}>
                  Describe your day
                </Button>
              )}
              <Button variant="secondary" size="md" icon={<Plus size={20} strokeWidth={1.75} aria-hidden="true" />} onClick={() => openForm(null)} disabled={!online}>
                <T k="Add a task" />
              </Button>
            </>
          )}
          {googleEnabled && (
            <Button variant="secondary" size="md" icon={<CalendarPlus size={20} strokeWidth={1.75} aria-hidden="true" />} onClick={() => setImportOpen(true)} disabled={!online}>
              Import from Google Calendar
            </Button>
          )}
        </div>
        {!online && <p className="mt-2 t-small text-ink-2">Adding and editing tasks needs a connection.</p>}
      </section>

      <div className="mt-10">
        {planning === 'drawing' ? (
          <div role="status" className="flex min-h-[52px] items-center gap-4 rounded-control bg-surface px-5">
            <DrawLine />
            <span className="t-title text-ink">
              <T k="Planning your day…" />
            </span>
          </div>
        ) : (
          <Button full loading={planning === 'busy'} loadingLabel={<T k="Planning your day…" />} onClick={() => plan()} disabled={!online}>
            {trip.activePlan ? 'Plan my day again' : <T k="Plan my day" />}
          </Button>
        )}
        {error && (
          <p role="alert" className="mt-2 flex items-start gap-2 t-small text-red-ink">
            <TriangleAlert size={20} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
            {error}
          </p>
        )}
        <p className="mt-2 t-small text-muted">
          Plans {dayLabel(trip.day)}. Times and fares are estimates; nothing is booked.
        </p>
        {!online && <p className="mt-2 t-small text-ink-2">Planning needs a connection. Your plan so far still works.</p>}
      </div>

      <TaskFormSheet trip={trip} open={form.open} onOpenChange={(o) => setForm((f) => ({ ...f, open: o }))} initial={form.task} onSave={saveTask} onRemove={removeTask} />
      {googleEnabled && (
        <ImportSheet
          trip={trip}
          open={importOpen}
          onOpenChange={setImportOpen}
          onAdded={(n) => {
            void queryClient.invalidateQueries({ queryKey: keys.trip(trip.tripId) })
            setImportOpen(false)
            showToast({ title: `Added ${n} ${n === 1 ? 'task' : 'tasks'} from your calendar.` })
          }}
        />
      )}
      {startText?.tripId === trip.tripId ? (
        // The new trip's description, read at once; adding the tasks plans the day and opens Today.
        <AiPlannerSheet
          key={startText.tripId}
          trip={trip}
          open
          initialText={startText.text}
          addLabel={(n) => (n === 1 ? 'Plan it' : `Plan these ${n}`)}
          onOpenChange={(o) => !o && setStartText(null)}
          onAdded={() => {
            setStartText(null)
            void plan(true)
          }}
        />
      ) : (
        <AiPlannerSheet
          trip={trip}
          open={aiOpen}
          onOpenChange={setAiOpen}
          onAdded={(n, outcome) => {
            void queryClient.invalidateQueries({ queryKey: keys.trip(trip.tripId) })
            setAiOpen(false)
            showToast({ title: `Added ${n} ${n === 1 ? 'task' : 'tasks'} from your description.${outcome === 'replanned' ? ' Your day is updated.' : ''}` })
          }}
        />
      )}
    </div>
  )
}
