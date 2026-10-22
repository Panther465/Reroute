import { Bot, Sparkles, Trash2 } from 'lucide-react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { EASE_OUT } from '@/lib/motion'
import { useEffect, useRef, useState } from 'react'
import { api, ApiError, newKey } from '@/api/client'
import { keys, queryClient } from '@/api/queries'
import type { Place, TaskDraft, Trip } from '@/api/types'
import { PlacePicker } from '@/components/PlacePicker'
import { Button } from '@/components/ui/Button'
import { Sheet } from '@/components/ui/Sheet'
import { DurationTag, FixedTag, PriorityTag } from '@/components/ui/Tag'
import { addTask, type EditOutcome } from '@/lib/actions'
import { hhmm, lowerFirst } from '@/lib/format'
import { localMinutes } from '@/lib/timeline'

interface AiPlannerSheetProps {
  trip: Trip
  open: boolean
  onOpenChange: (open: boolean) => void
  onAdded: (n: number, outcome: EditOutcome) => void
  /** Text to start from, read at once when the sheet opens (the start screen's "What do you need to do?"). */
  initialText?: string
  /** The add button's words, given the number of tasks. */
  addLabel?: (n: number) => string
}

interface Item {
  draft: TaskDraft
  place: Place | null
  key: string
}

function DraftCard({ item, index, trip, onPlace, onRemove }: { item: Item; index: number; trip: Trip; onPlace: (p: Place | null) => void; onRemove: () => void }) {
  const reduce = useReducedMotion()
  const { draft } = item
  return (
    <motion.li
      layout
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, x: -40 }}
      transition={{ duration: 0.2, delay: index * 0.06, ease: EASE_OUT }}
      className="rounded-card border border-line bg-surface p-4"
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="t-title text-ink">{draft.title}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {draft.fixedStart && <FixedTag at={hhmm(localMinutes(draft.fixedStart, draft.fixedStart.slice(0, 10), trip.utcOffset))} />}
            <DurationTag min={draft.durationMin} />
            <PriorityTag priority={draft.priority} />
          </div>
        </div>
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${draft.title}`}
          className="-mr-2 -mt-2 flex size-12 shrink-0 items-center justify-center rounded-full text-muted [@media(hover:hover)]:hover:bg-red-tint [@media(hover:hover)]:hover:text-red-ink"
        >
          <Trash2 size={18} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
      <div className="mt-3">
        <PlacePicker
          label={item.place ? 'Where' : `Where is the ${lowerFirst(draft.title)}?`}
          city={trip.citySlug}
          value={item.place}
          onChange={onPlace}
          hint={draft.placeText && !item.place ? `You said "${draft.placeText}". Search for the building or area.` : 'Search by area or building'}
        />
      </div>
    </motion.li>
  )
}

const PLACEHOLDERS = [
  'Meeting at 10am at Whitefield, bank work in Koramangala, then the university office in Jayanagar',
  'Client lunch at 1pm on MG Road, then pick up documents in Indiranagar',
  'Office from 10 to 5 in Whitefield, then dinner near Koramangala',
]

export function AiPlannerSheet({ trip, open, onOpenChange, onAdded, initialText, addLabel }: AiPlannerSheetProps) {
  const [text, setText] = useState(initialText ?? '')
  const [items, setItems] = useState<Item[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(false)
  const [replanning, setReplanning] = useState(false)
  const [error, setError] = useState<string>()
  const [askKey, setAskKey] = useState(() => newKey('ai'))
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [placeholder] = useState(() => PLACEHOLDERS[Math.floor(Math.random() * PLACEHOLDERS.length)])

  const ask = async (value = text) => {
    if (value.trim().length < 3) return
    setBusy(true)
    setError(undefined)
    try {
      const found = await api.post<TaskDraft[]>(`/v1/trips/${trip.tripId}/task-drafts`, { text: value.trim() }, { idempotencyKey: askKey })
      if (found.length === 0) {
        setError("I couldn't find any tasks in that. Try saying what you need to do and where.")
        setAskKey(newKey('ai'))
      } else {
        setItems(found.map((draft) => ({ draft, place: draft.place ?? null, key: newKey('draft') })))
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't read that. Try again.")
      setAskKey(newKey('ai'))
    } finally {
      setBusy(false)
    }
  }

  // Text handed over from the start screen is read straight away: no second "Plan it" tap.
  const askedInitial = useRef(false)
  useEffect(() => {
    if (open && initialText && !askedInitial.current) {
      askedInitial.current = true
      setText(initialText)
      void ask(initialText)
    }
    // `ask` reads the latest key and text; it runs once per handed-over text.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialText])

  useEffect(() => {
    if (open && !items && !initialText) setTimeout(() => inputRef.current?.focus(), 300)
  }, [open, items, initialText])

  const setPlace = (i: number, place: Place | null) => setItems((list) => list && list.map((x, j) => (j === i ? { ...x, place } : x)))
  const remove = (i: number) => setItems((list) => (list && list.length > 1 ? list.filter((_, j) => j !== i) : null))

  const chosen = items?.filter((x) => x.place) ?? []
  const missing = (items?.length ?? 0) - chosen.length

  const addAll = async () => {
    if (!chosen.length) return
    setAdding(true)
    setError(undefined)
    try {
      let outcome: EditOutcome = 'saved'
      // Untimed tasks go on the day being planned; the day re-plans once, after the last task.
      for (const [n, { draft: d, place, key }] of chosen.entries()) {
        const day = d.fixedStart ? d.fixedStart.slice(0, 10) : trip.day
        const res = await addTask(
          trip.tripId,
          { title: d.title, placeId: place!.placeId, durationMin: d.durationMin, fixedStart: d.fixedStart, priority: d.priority, hoursUnknown: false, day },
          key,
          { replan: n === chosen.length - 1, onReplanning: () => setReplanning(true) },
        )
        outcome = res.outcome
      }
      await queryClient.invalidateQueries({ queryKey: keys.trip(trip.tripId) })
      onAdded(chosen.length, outcome)
      setItems(null)
      setText('')
      setAskKey(newKey('ai'))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add those tasks. Try again.")
    } finally {
      setAdding(false)
      setReplanning(false)
    }
  }

  const startOver = () => {
    setItems(null)
    setError(undefined)
    setAskKey(newKey('ai'))
  }

  const n = chosen.length
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={
        <span className="inline-flex items-center gap-2">
          <Sparkles size={22} strokeWidth={1.75} aria-hidden="true" className="text-green" />
          {items ? 'Check your tasks' : 'Describe your day'}
        </span>
      }
      description={items ? 'This is what I understood. Fix a place or remove a task before adding them.' : 'Say what you need to do, when and where. I turn it into tasks.'}
      footer={
        items ? (
          <div className="flex flex-col gap-2">
            {missing > 0 && n > 0 && (
              <p className="t-small text-ink-2">
                {missing === 1 ? '1 task has' : `${missing} tasks have`} no place yet. Choose one, or it's left out.
              </p>
            )}
            <div className="flex gap-3">
              <Button variant="secondary" size="md" className="shrink-0" onClick={startOver} disabled={adding}>
                Start over
              </Button>
              <Button full loading={adding} loadingLabel={replanning ? 'Updating your plan…' : 'Adding…'} onClick={addAll} disabled={n === 0}>
                {n === 0 ? 'Choose a place for each task' : addLabel ? addLabel(n) : `Add ${n} ${n === 1 ? 'task' : 'tasks'}`}
              </Button>
            </div>
          </div>
        ) : (
          <Button full loading={busy} loadingLabel="Reading…" onClick={() => ask()} disabled={text.trim().length < 3} icon={<Bot size={20} strokeWidth={1.75} aria-hidden="true" />}>
            Turn into tasks
          </Button>
        )
      }
    >
      {!items && (
        <div className="flex flex-col gap-3">
          <label htmlFor="describe-day" className="sr-only">
            What do you need to do?
          </label>
          <textarea
            id="describe-day"
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={placeholder}
            rows={4}
            maxLength={2000}
            disabled={busy}
            className="w-full resize-none rounded-control border-2 border-line bg-surface px-4 py-3 t-body text-ink placeholder:text-muted focus:border-green focus:outline-none"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && text.trim().length >= 3) {
                e.preventDefault()
                void ask()
              }
            }}
          />
          <p className="t-small text-muted">Mention times (10am, from 12 to 3) and places (a building or an area). I guess how long each task takes; you can change it later.</p>
        </div>
      )}

      {items && (
        <AnimatePresence mode="popLayout">
          <ul className="flex flex-col gap-3">
            {items.map((item, i) => (
              <DraftCard key={item.key} item={item} index={i} trip={trip} onPlace={(p) => setPlace(i, p)} onRemove={() => remove(i)} />
            ))}
          </ul>
        </AnimatePresence>
      )}

      {error && (
        <p role="alert" className="mt-3 t-small text-red-ink">
          {error}
        </p>
      )}
    </Sheet>
  )
}
