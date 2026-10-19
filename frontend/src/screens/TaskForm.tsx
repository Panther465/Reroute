import { MapPin, Minus, Plus, Search } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { ApiError } from '@/api/client'
import { usePlaceSearch } from '@/api/queries'
import type { Body, Place, Task, TaskIn, Trip } from '@/api/types'
import { Button } from '@/components/ui/Button'
import { Segmented } from '@/components/ui/Choice'
import { Field, FieldError } from '@/components/ui/Field'
import { Sheet } from '@/components/ui/Sheet'
import { duration, hhmm } from '@/lib/format'
import { T, useTl } from '@/lib/i18n'
import { addDays, localMinutes, weekday } from '@/lib/timeline'

type Timing = 'fixed' | 'hours' | 'any'

interface FormState {
  title: string
  place: Place | null
  durationMin: number
  timing: Timing
  fixedStart: string
  opensAt: string
  closesAt: string
  priority: 1 | 2 | 3
  day: string
  hoursUnknown: boolean
}

/** The form's starting values. Takes the trip's day and offset as plain values, so a refetched trip object can't reset the form. */
export function fromTask(day: string, utcOffset: string, t: Task | null): FormState {
  if (!t) return { title: '', place: null, durationMin: 60, timing: 'any', fixedStart: '', opensAt: '', closesAt: '', priority: 2, day, hoursUnknown: false }
  return {
    title: t.title,
    place: t.place,
    durationMin: t.durationMin,
    timing: t.fixedStart ? 'fixed' : t.window ? 'hours' : 'any',
    fixedStart: t.fixedStart ? hhmm(localMinutes(t.fixedStart, t.day, utcOffset)) : '',
    opensAt: t.window?.opensAt ?? '',
    closesAt: t.window?.closesAt ?? '',
    priority: t.priority as 1 | 2 | 3,
    day: t.day,
    hoursUnknown: t.hoursUnknown,
  }
}

function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms)
    return () => clearTimeout(id)
  }, [value, ms])
  return v
}

/** Why place search failed: no signal, or a city Reroute doesn't cover (the server says which). */
export function placeSearchError(err: unknown) {
  if (err instanceof ApiError && err.status === 422) return err.message
  return "Place search needs a connection. Try again when you're online."
}

export function tripDays(trip: Trip) {
  const days: string[] = []
  for (let d = trip.startDate; d <= trip.endDate; d = addDays(d, 1)) days.push(d)
  return days
}

/** Add or edit a task. Saves through the API; the caller decides what happens next. */
export function TaskFormSheet({
  trip,
  open,
  onOpenChange,
  initial,
  onSave,
  onRemove,
}: {
  trip: Trip
  open: boolean
  onOpenChange: (o: boolean) => void
  initial?: Task | null
  /** Resolves when the save (and any re-plan it starts) is done; the form stays open until then. Call `stage('replanning')` once the save is in and the day is being re-planned. */
  onSave: (body: Body<TaskIn>, initial: Task | null, stage: (s: 'replanning') => void) => Promise<void>
  /** Shown only for a saved task that hasn't been checked in. */
  onRemove?: (task: Task) => Promise<void>
}) {
  const tl = useTl()
  const [form, setForm] = useState<FormState>(() => fromTask(trip.day, trip.utcOffset, initial ?? null))
  const [query, setQuery] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState<false | 'saving' | 'replanning'>(false)
  const errRef = useRef<HTMLDivElement>(null)
  const [removing, setRemoving] = useState(false)
  const durId = useId()
  const debounced = useDebounced(query, 300)
  const search = usePlaceSearch(debounced, trip.citySlug)

  // Reset when the form opens or switches to another task, never because the trip refetched
  // (the 60 s refresh, window focus, a live event): that would wipe what the traveller typed.
  const day = trip.day
  const offset = trip.utcOffset
  const taskId = initial?.taskId
  useEffect(() => {
    if (!open) return
    setForm(fromTask(day, offset, initial ?? null))
    setQuery('')
    setErrors({})
    // Only opening or a different task resets; `initial` is read for its values at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, taskId])

  // A save error takes focus, so it is heard and seen.
  useEffect(() => {
    if (errors.form) errRef.current?.focus()
  }, [errors.form])

  const set = (p: Partial<FormState>) => setForm((f) => ({ ...f, ...p }))

  const save = async () => {
    const e: Record<string, string> = {}
    if (!form.title.trim()) e.title = 'Give the task a name, like Bank visit.'
    if (!form.place) e.place = 'Choose a place from the search results.'
    if (form.timing === 'fixed' && !form.fixedStart) e.fixed = 'Enter the start time.'
    if (form.timing === 'hours') {
      if (!form.opensAt || !form.closesAt) e.hours = 'Enter when it opens and closes.'
      else if (form.closesAt <= form.opensAt) e.hours = 'The closing time must be after the opening time.'
    }
    setErrors(e)
    if (Object.keys(e).length) return
    const body: Body<TaskIn> = {
      title: form.title.trim(),
      placeId: form.place!.placeId,
      durationMin: form.durationMin,
      priority: form.priority,
      day: form.day,
      fixedStart: form.timing === 'fixed' ? `${form.day}T${form.fixedStart}:00${trip.utcOffset}` : null,
      window: form.timing === 'hours' ? { opensAt: form.opensAt, closesAt: form.closesAt } : null,
      hoursUnknown: form.timing === 'any' && form.hoursUnknown,
    }
    setSaving('saving')
    try {
      await onSave(body, initial ?? null, () => setSaving('replanning'))
    } catch (err) {
      setErrors({ form: err instanceof ApiError ? err.message : "Couldn't save the task. Try again." })
    } finally {
      setSaving(false)
    }
  }

  const days = tripDays(trip)
  const title = tl(initial ? 'Edit this task' : 'Add a task')

  return (
    <Sheet
      open={open}
      // Closing mid-save would hide whether the change went through.
      onOpenChange={(o) => !saving && onOpenChange(o)}
      title={title.text}
      titleLang={title.lang}
      footer={
        <div className="flex flex-col gap-2">
          {errors.form && (
            <div ref={errRef} tabIndex={-1} role="alert" className="outline-none">
              <FieldError id="task-form-err">{errors.form}</FieldError>
            </div>
          )}
          <Button full onClick={save} loading={!!saving} loadingLabel={<T k={saving === 'replanning' ? 'Re-planning…' : 'Saving…'} />}>
            <T k={initial ? 'Save changes' : 'Add this task'} />
          </Button>
          {initial && onRemove && initial.state === 'planned' && (
            <Button
              variant="destructive"
              full
              loading={removing}
              loadingLabel="Removing…"
              onClick={async () => {
                setRemoving(true)
                try {
                  await onRemove(initial)
                } catch (e) {
                  setErrors({ form: e instanceof Error ? e.message : "Couldn't remove the task. Try again." })
                } finally {
                  setRemoving(false)
                }
              }}
            >
              Remove this task
            </Button>
          )}
        </div>
      }
    >
      <div className="flex flex-col gap-6">
        <Field label="Title" value={form.title} onChange={(e) => set({ title: e.target.value })} error={errors.title} autoComplete="off" maxLength={120} />

        <div>
          {form.place ? (
            <div>
              <p className="mb-2 t-title text-ink">Place</p>
              <div className="flex items-center gap-3 rounded-control border-2 border-green bg-green-tint px-4 py-2">
                <MapPin size={20} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-green-ink" />
                <span className="min-w-0 flex-1">
                  <span className="block t-title text-ink">{form.place.name}</span>
                  <span className="block t-small text-ink-2">{form.place.area}</span>
                </span>
                <Button variant="tertiary" size="md" onClick={() => set({ place: null })}>
                  Change
                </Button>
              </div>
            </div>
          ) : (
            <>
              <Field
                label="Place"
                hint={`Search by area or building in ${trip.cityName}`}
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                error={errors.place}
                autoComplete="off"
                trailing={<Search size={20} strokeWidth={1.75} aria-hidden="true" className="mr-3 text-muted" />}
              />
              {debounced.trim().length >= 2 && (
                <ul aria-label="Places found" aria-busy={search.isFetching} className="mt-2 divide-y divide-line overflow-hidden rounded-control border border-line bg-surface">
                  {search.isPending && <li className="px-4 py-3 t-small text-ink-2">Searching…</li>}
                  {search.isError && <li className="px-4 py-3 t-small text-ink-2">{placeSearchError(search.error)}</li>}
                  {search.data?.length === 0 && <li className="px-4 py-3 t-small text-ink-2">No places match. Try the area name, like Koramangala.</li>}
                  {search.data?.map((p) => (
                    <li key={p.placeId}>
                      <button type="button" className="flex min-h-12 w-full items-center gap-3 px-4 py-2 text-left [@media(hover:hover)]:hover:bg-sunken" onClick={() => set({ place: p })}>
                        <MapPin size={20} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-muted" />
                        <span>
                          <span className="block t-body text-ink">{p.name}</span>
                          <span className="block t-small text-muted">
                            {p.area}
                            {p.sample ? ', sample place' : ''}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>

        <div role="group" aria-labelledby={durId}>
          <p id={durId} className="mb-2 t-title text-ink">
            How long
          </p>
          <div className="flex items-center gap-3">
            <button type="button" aria-label="15 minutes less" disabled={form.durationMin <= 15} onClick={() => set({ durationMin: form.durationMin - 15 })} className="flex size-12 items-center justify-center rounded-control border-2 border-ink text-ink disabled:opacity-40">
              <Minus size={20} strokeWidth={1.75} aria-hidden="true" />
            </button>
            <output aria-live="polite" className="min-w-28 text-center t-time text-ink">
              {duration(form.durationMin)}
            </output>
            <button type="button" aria-label="15 minutes more" disabled={form.durationMin >= 720} onClick={() => set({ durationMin: form.durationMin + 15 })} className="flex size-12 items-center justify-center rounded-control border-2 border-ink text-ink disabled:opacity-40">
              <Plus size={20} strokeWidth={1.75} aria-hidden="true" />
            </button>
          </div>
        </div>

        <div>
          <Segmented<Timing>
            label="Timing"
            value={form.timing}
            onChange={(v) => set({ timing: v })}
            options={[
              { value: 'fixed', label: 'Fixed time' },
              { value: 'hours', label: 'Opening hours' },
              { value: 'any', label: 'Anytime' },
            ]}
          />
          {form.timing === 'fixed' && (
            <div className="mt-4">
              <Field label="Starts at" type="time" value={form.fixedStart} onChange={(e) => set({ fixedStart: e.target.value })} error={errors.fixed} className="max-w-48" />
            </div>
          )}
          {form.timing === 'hours' && (
            <div className="mt-4">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Opens at" type="time" value={form.opensAt} onChange={(e) => set({ opensAt: e.target.value })} />
                <Field label="Closes at" type="time" value={form.closesAt} onChange={(e) => set({ closesAt: e.target.value })} />
              </div>
              {errors.hours && <FieldError id="hours-err">{errors.hours}</FieldError>}
            </div>
          )}
          {form.timing === 'any' && (
            <label className="mt-4 flex min-h-12 items-center gap-3 t-body text-ink">
              <input type="checkbox" className="size-6 accent-[var(--green)]" checked={form.hoursUnknown} onChange={(e) => set({ hoursUnknown: e.target.checked })} />
              I don't know its opening hours
            </label>
          )}
        </div>

        <Segmented<'1' | '2' | '3'>
          label="Priority"
          value={String(form.priority) as '1' | '2' | '3'}
          onChange={(v) => set({ priority: Number(v) as 1 | 2 | 3 })}
          options={[
            { value: '1', label: 'Must do' },
            { value: '2', label: 'Should do' },
            { value: '3', label: 'If there is time' },
          ]}
        />
        {days.length > 1 && (
          <Segmented<string>
            label="Day"
            value={form.day}
            onChange={(v) => set({ day: v })}
            options={days.map((d) => ({ value: d, label: weekday(d) }))}
          />
        )}
      </div>
    </Sheet>
  )
}
