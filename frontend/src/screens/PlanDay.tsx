import { CalendarPlus, MapPin, Plus, Search, Sparkles, TriangleAlert } from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'
import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { api, ApiError, newKey } from '@/api/client'
import { keys, queryClient, useCurrentTripId, usePlaceSearch, useTrip, waitForJob } from '@/api/queries'
import type { Body, JobAccepted, Place, Task, TaskDraft, TaskIn, Trip, TripIn } from '@/api/types'
import { Button } from '@/components/ui/Button'
import { Field, FieldError } from '@/components/ui/Field'
import { Sheet } from '@/components/ui/Sheet'
import { Banner, ErrorState, LoadingRegion, Skeleton } from '@/components/ui/States'
import { Tag } from '@/components/ui/Tag'
import { addTask, saveTaskEdit, type EditOutcome } from '@/lib/actions'
import { duration, hhmm } from '@/lib/format'
import { CALENDAR_SCOPE, googleEnabled, requestGoogleCode } from '@/lib/google'
import { useDocumentTitle, useOnline } from '@/lib/hooks'
import { T } from '@/lib/i18n'
import { nextToken, setState, showToast } from '@/lib/store'
import { buildDay, dayLabel, localMinutes, weekday } from '@/lib/timeline'
import { AiPlannerSheet } from './AiPlannerSheet'
import { placeSearchError, TaskFormSheet } from './TaskForm'

function TaskTags({ task, trip }: { task: Task; trip: Trip }) {
  return (
    <span className="mt-2 flex flex-wrap gap-2">
      {task.fixedStart && <Tag tone="ink">Fixed {hhmm(localMinutes(task.fixedStart, task.day, trip.utcOffset))}</Tag>}
      {task.window && <Tag tone="green-outline">Open till {task.window.closesAt}</Tag>}
      {task.durationMin > 0 && <Tag tone="grey-outline">{duration(task.durationMin)}</Tag>}
      {task.day !== trip.startDate && <Tag tone="grey-outline">{weekday(task.day)}</Tag>}
      {task.state === 'done' && <Tag tone="green">Done</Tag>}
      {task.state === 'skipped' && <Tag tone="sunken">Skipped</Tag>}
      {task.state === 'moved' && <Tag tone="sunken">Moved to {weekday(task.day)}</Tag>}
    </span>
  )
}

/** Three stations drawing once: the planning reveal. */
export function DrawLine({ className = '' }: { className?: string }) {
  const reduce = useReducedMotion()
  return (
    <svg viewBox="0 0 120 24" className={`h-6 w-30 ${className}`} aria-hidden="true">
      <motion.path d="M10 12H110" stroke="var(--green)" strokeWidth="6" strokeLinecap="round" fill="none" initial={{ pathLength: reduce ? 1 : 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }} />
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
          transition={{ delay: i * 0.2 + 0.05, duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
          style={{ transformOrigin: `${x}px 12px` }}
        />
      ))}
    </svg>
  )
}

function PlacePicker({ label, city, value, onChange, error }: { label: string; city: string; value: Place | null; onChange: (p: Place | null) => void; error?: string }) {
  const [q, setQ] = useState('')
  const [debounced, setDebounced] = useState('')
  useEffect(() => {
    const id = setTimeout(() => setDebounced(q), 300)
    return () => clearTimeout(id)
  }, [q])
  const search = usePlaceSearch(debounced, city)
  if (value)
    return (
      <div>
        <p className="mb-2 t-title text-ink">{label}</p>
        <div className="flex items-center gap-3 rounded-control border-2 border-green bg-green-tint px-4 py-2">
          <MapPin size={20} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-green-ink" />
          <span className="min-w-0 flex-1">
            <span className="block t-title text-ink">{value.name}</span>
            <span className="block t-small text-ink-2">{value.area}</span>
          </span>
          <Button variant="tertiary" size="md" onClick={() => onChange(null)}>
            Change
          </Button>
        </div>
      </div>
    )
  return (
    <div>
      <Field label={label} type="search" value={q} onChange={(e) => setQ(e.target.value)} error={error} autoComplete="off" hint="Search by area or building" trailing={<Search size={20} strokeWidth={1.75} aria-hidden="true" className="mr-3 text-muted" />} />
      {debounced.trim().length >= 2 && (
        <ul aria-label="Places found" className="mt-2 divide-y divide-line overflow-hidden rounded-control border border-line bg-surface">
          {search.isPending && <li className="px-4 py-3 t-small text-ink-2">Searching…</li>}
          {search.isError && <li className="px-4 py-3 t-small text-ink-2">{placeSearchError(search.error)}</li>}
          {search.data?.length === 0 && <li className="px-4 py-3 t-small text-ink-2">No places match. Try the area name.</li>}
          {search.data?.map((p) => (
            <li key={p.placeId}>
              <button type="button" onClick={() => onChange(p)} className="flex min-h-12 w-full items-center gap-3 px-4 py-2 text-left [@media(hover:hover)]:hover:bg-sunken">
                <MapPin size={20} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-muted" />
                <span>
                  <span className="block t-body text-ink">{p.name}</span>
                  <span className="block t-small text-muted">{p.area}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Create a trip. Reroute plans in the cities it has travel data for; Bengaluru is the demo city. */
function NewTripForm({ onCreated }: { onCreated: (trip: Trip) => void }) {
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [stay, setStay] = useState<Place | null>(null)
  const [label, setLabel] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [key] = useState(() => newKey('trip'))

  const create = async () => {
    const e: Record<string, string> = {}
    if (!start) e.start = 'Choose the first day.'
    if (end && start && end < start) e.end = 'The last day must be on or after the first day.'
    if (!stay) e.stay = 'Choose where you are staying.'
    setErrors(e)
    if (Object.keys(e).length) return
    const body: Body<TripIn> = { citySlug: 'bengaluru', cityName: 'Bengaluru', startDate: start, endDate: end || start, stayPlaceId: stay!.placeId, stayLabel: label.trim() || stay!.name }
    setBusy(true)
    try {
      const trip = await api.post<Trip>('/v1/trips', body, { idempotencyKey: key })
      onCreated(trip)
    } catch (err) {
      setErrors({ form: err instanceof ApiError ? err.message : "Couldn't create the trip. Try again." })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-6 flex flex-col gap-4">
      <div className="rounded-card border border-line bg-surface p-4">
        <p className="t-title text-ink">Bengaluru</p>
        <p className="t-small text-ink-2">Reroute has travel times for Bengaluru so far.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="First day" type="date" value={start} onChange={(e) => setStart(e.target.value)} error={errors.start} />
        <Field label="Last day" type="date" value={end} min={start} onChange={(e) => setEnd(e.target.value)} error={errors.end} />
      </div>
      <PlacePicker label="Staying at" city="bengaluru" value={stay} onChange={setStay} error={errors.stay} />
      <Field label="What you call it" hint="Optional, like Hotel near Majestic" value={label} onChange={(e) => setLabel(e.target.value)} />
      {errors.form && <FieldError id="trip-err">{errors.form}</FieldError>}
      <Button full onClick={create} loading={busy} loadingLabel="Creating…">
        Create the trip
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
  const [importOpen, setImportOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [planning, setPlanning] = useState<'idle' | 'busy' | 'drawing'>('idle')
  const [error, setError] = useState<string>()
  const [planKey, setPlanKey] = useState(() => newKey('plan'))
  // One key per "Add a task" form: retries of the same submission never create the task twice.
  const [createKey, setCreateKey] = useState(() => newKey('task'))
  useDocumentTitle(trip?.activePlan ? 'Your trip' : 'New trip')
  // Roo's "Describe my day" lands here with the sheet open; clear the flag so Back doesn't reopen it.
  const location = useLocation()
  useEffect(() => {
    if ((location.state as { openAi?: boolean } | null)?.openAi) {
      setAiOpen(true)
      navigate(location.pathname, { replace: true, state: null })
    }
  }, [location.state, location.pathname, navigate])
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

  const onCreated = (created: Trip) => {
    queryClient.setQueryData(keys.trip(created.tripId), created)
    void queryClient.invalidateQueries({ queryKey: keys.trips })
    setCreating(false)
    showToast({ title: 'Trip created. Add your tasks.' })
  }

  if (!trip || creating) {
    return (
      <div className="mx-auto max-w-[560px] px-5 pb-10 pt-6 lg:max-w-[720px] lg:px-8 lg:pt-8">
        <h1 tabIndex={-1} className="t-display-1 text-ink">
          <T k="New trip" />
        </h1>
        {!online ? (
          <div className="mt-6">
            <Banner tone="offline">You're offline. Connect to start a new trip.</Banner>
          </div>
        ) : (
          <NewTripForm onCreated={onCreated} />
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
  const open = trip.tasks.filter((x) => x.state !== 'done' && x.state !== 'skipped')
  // Say which tasks the active plan leaves out, so none of them quietly disappears.
  const dayView = trip.activePlan ? buildDay(trip) : null
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

  const plan = async () => {
    if (!today.some((x) => x.state !== 'done' && x.state !== 'skipped')) return setError(`Add at least one task for ${dayLabel(trip.day)}.`)
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
      <dl className="mt-6 grid gap-x-6 gap-y-3 rounded-card border border-line bg-surface p-4 sm:grid-cols-3">
        <div>
          <dt className="t-small text-muted">City</dt>
          <dd className="t-title text-ink">{trip.cityName}</dd>
        </div>
        <div>
          <dt className="t-small text-muted">Dates</dt>
          <dd className="t-title text-ink">{trip.startDate === trip.endDate ? dayLabel(trip.startDate) : `${dayLabel(trip.startDate)} to ${dayLabel(trip.endDate)}`}</dd>
        </div>
        <div>
          <dt className="t-small text-muted">Staying at</dt>
          <dd className="t-title text-ink">{trip.stayLabel}</dd>
        </div>
      </dl>
      {trip.sample && <p className="mt-2 t-small text-muted">This is the sample demo trip. Its places and travel times are sample data.</p>}
      <p className="mt-2">
        <Button variant="tertiary" size="md" className="-ml-2" onClick={() => setCreating(true)} disabled={!online}>
          Start a new trip
        </Button>
      </p>

      <section className="mt-8" aria-labelledby="tasks-h">
        <div className="flex items-end justify-between gap-3">
          <h2 id="tasks-h" className="t-display-2 text-ink">
            <T k="Your tasks" />
          </h2>
          {trip.tasks.length > 0 && <span className="t-small text-muted">{open.length} to do</span>}
        </div>
        {trip.tasks.length === 0 ? (
          <div className="mt-4 flex flex-col gap-4">
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
            <Button variant="secondary" icon={<Plus size={20} strokeWidth={1.75} aria-hidden="true" />} onClick={() => openForm(null)} disabled={!online}>
              <T k="Add tasks one by one" />
            </Button>
          </div>
        ) : (
          <ul className="mt-4 divide-y divide-line overflow-hidden rounded-card border border-line bg-surface">
            {trip.tasks.map((task) => (
              <li key={task.taskId}>
                <button type="button" disabled={task.state === 'done' || !online} onClick={() => openForm(task)} className="block w-full px-4 py-4 text-left disabled:cursor-default [@media(hover:hover)]:hover:enabled:bg-sunken/60">
                  <span className="block t-title text-ink">{task.title}</span>
                  <span className="block t-small text-muted">
                    {task.place.name}, {task.place.area}
                  </span>
                  <TaskTags task={task} trip={trip} />
                  {issues.has(task.taskId) && (
                    <span className="mt-2 flex items-start gap-1.5 t-small text-red-ink">
                      <TriangleAlert size={16} strokeWidth={1.75} aria-hidden="true" className="mt-0.5 shrink-0" />
                      {issues.get(task.taskId)}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-4 flex flex-wrap gap-3">
          {trip.tasks.length > 0 && (
            <>
              <Button variant="secondary" size="md" icon={<Sparkles size={20} strokeWidth={1.75} aria-hidden="true" />} onClick={() => setAiOpen(true)} disabled={!online}>
                Describe your day
              </Button>
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
          <Button full loading={planning === 'busy'} loadingLabel={<T k="Planning your day…" />} onClick={plan} disabled={!online}>
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
    </div>
  )
}
