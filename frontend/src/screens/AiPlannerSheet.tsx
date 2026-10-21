import { Bot, Check, MapPin, Sparkles, Trash2 } from 'lucide-react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { api, ApiError, newKey } from '@/api/client'
import { keys, queryClient } from '@/api/queries'
import type { TaskDraft, Trip } from '@/api/types'
import { addTask, type EditOutcome } from '@/lib/actions'
import { Button } from '@/components/ui/Button'
import { Sheet } from '@/components/ui/Sheet'
import { Banner } from '@/components/ui/States'
import { Tag } from '@/components/ui/Tag'
import { duration, hhmm } from '@/lib/format'
import { localMinutes } from '@/lib/timeline'

interface AiPlannerSheetProps {
  trip: Trip
  open: boolean
  onOpenChange: (open: boolean) => void
  onAdded: (n: number, outcome: EditOutcome) => void
}

function DraftCard({
  draft,
  index,
  trip,
  onRemove,
}: {
  draft: TaskDraft
  index: number
  trip: Trip
  onRemove: (i: number) => void
}) {
  const reduce = useReducedMotion()
  return (
    <motion.li
      layout
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, x: -40 }}
      transition={{ duration: 0.2, delay: index * 0.06, ease: [0.16, 1, 0.3, 1] }}
      className="flex items-start gap-3 rounded-card border border-line bg-surface p-4"
    >
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-green-tint text-green-ink">
        <Check size={16} strokeWidth={2.5} aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="t-title text-ink">{draft.title}</p>
        {draft.placeText && (
          <p className="mt-1 flex items-center gap-1 t-small text-ink-2">
            <MapPin size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
            {draft.placeText}
            {draft.placeId && <Tag tone="green-outline" className="ml-1">Found</Tag>}
            {!draft.placeId && <Tag tone="grey-outline" className="ml-1">Set by hand</Tag>}
          </p>
        )}
        <div className="mt-2 flex flex-wrap gap-2">
          {draft.fixedStart && (
            <Tag tone="ink">{hhmm(localMinutes(draft.fixedStart, draft.fixedStart.slice(0, 10), trip.utcOffset))}</Tag>
          )}
          <Tag tone="grey-outline">{duration(draft.durationMin)}</Tag>
          {draft.priority === 1 && <Tag tone="green">Must do</Tag>}
          {draft.priority === 3 && <Tag tone="sunken">If time</Tag>}
        </div>
      </div>
      <button
        type="button"
        onClick={() => onRemove(index)}
        aria-label={`Remove ${draft.title}`}
        className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full text-muted [@media(hover:hover)]:hover:bg-red-tint [@media(hover:hover)]:hover:text-red-ink"
      >
        <Trash2 size={16} strokeWidth={1.75} aria-hidden="true" />
      </button>
    </motion.li>
  )
}

const PLACEHOLDERS = [
  'Meeting at 10am at Koramangala, bank work, then office...',
  'Doctor at 9:30, pick up groceries, lunch with a friend...',
  'Office from 10 to 5, gym after, then dinner near MG Road...',
]

export function AiPlannerSheet({ trip, open, onOpenChange, onAdded }: AiPlannerSheetProps) {
  const [text, setText] = useState('')
  const [drafts, setDrafts] = useState<TaskDraft[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(false)
  const [replanning, setReplanning] = useState(false)
  const [error, setError] = useState<string>()
  const [askKey, setAskKey] = useState(() => newKey('ai'))
  const [draftKeys, setDraftKeys] = useState<string[]>([])
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [placeholder] = useState(() => PLACEHOLDERS[Math.floor(Math.random() * PLACEHOLDERS.length)])

  useEffect(() => {
    if (open && !drafts) setTimeout(() => inputRef.current?.focus(), 300)
  }, [open, drafts])

  const ask = async () => {
    if (text.trim().length < 3) return
    setBusy(true)
    setError(undefined)
    try {
      const found = await api.post<TaskDraft[]>(`/v1/trips/${trip.tripId}/task-drafts`, { text: text.trim() }, { idempotencyKey: askKey })
      if (found.length === 0) {
        setError("I couldn't find any tasks in that. Try mentioning what you need to do and where.")
        setAskKey(newKey('ai'))
      } else {
        setDrafts(found)
        setDraftKeys(found.map(() => newKey('draft')))
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't understand that. Try again.")
      setAskKey(newKey('ai'))
    } finally {
      setBusy(false)
    }
  }

  const removeDraft = (i: number) => {
    setDrafts((d) => d && d.filter((_, j) => j !== i))
    setDraftKeys((k) => k.filter((_, j) => j !== i))
  }

  const addAll = async () => {
    if (!drafts) return
    const chosen = drafts.map((d, i) => ({ d, key: draftKeys[i] })).filter((x) => x.d.placeId)
    if (chosen.length === 0) return
    setAdding(true)
    setError(undefined)
    try {
      let outcome: EditOutcome = 'saved'
      // Untimed tasks go on the day being planned; the day re-plans once, after the last task.
      for (const [n, { d, key }] of chosen.entries()) {
        const day = d.fixedStart ? d.fixedStart.slice(0, 10) : trip.day
        const res = await addTask(
          trip.tripId,
          { title: d.title, placeId: d.placeId!, durationMin: d.durationMin, fixedStart: d.fixedStart, priority: d.priority, hoursUnknown: false, day },
          key,
          { replan: n === chosen.length - 1, onReplanning: () => setReplanning(true) },
        )
        outcome = res.outcome
      }
      await queryClient.invalidateQueries({ queryKey: keys.trip(trip.tripId) })
      onAdded(chosen.length, outcome)
      setDrafts(null)
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
    setDrafts(null)
    setText('')
    setError(undefined)
    setAskKey(newKey('ai'))
  }

  const addable = drafts?.filter((d) => d.placeId).length ?? 0
  const unmatched = drafts?.filter((d) => !d.placeId).length ?? 0

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={
        <span className="inline-flex items-center gap-2">
          <Sparkles size={22} strokeWidth={1.75} aria-hidden="true" className="text-green" />
          Describe your day
        </span>
      }
      description="Tell me roughly what you need to do. I'll turn it into a plan."
      footer={
        drafts ? (
          <div className="flex gap-3">
            <Button variant="secondary" size="md" onClick={startOver} disabled={adding}>
              Start over
            </Button>
            <Button
              full
              loading={adding}
              loadingLabel={replanning ? 'Updating your plan…' : 'Adding…'}
              onClick={addAll}
              disabled={addable === 0}
            >
              {addable === 0 ? 'No matched places' : `Add ${addable} task${addable === 1 ? '' : 's'}`}
            </Button>
          </div>
        ) : (
          <Button
            full
            loading={busy}
            loadingLabel="Thinking..."
            onClick={ask}
            disabled={text.trim().length < 3}
            icon={<Bot size={20} strokeWidth={1.75} aria-hidden="true" />}
          >
            Plan it
          </Button>
        )
      }
    >
      {!drafts && (
        <div className="flex flex-col gap-4">
          <textarea
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={placeholder}
            rows={4}
            maxLength={2000}
            className="w-full resize-none rounded-control border-2 border-line bg-surface px-4 py-3 t-body text-ink placeholder:text-muted focus:border-green focus:outline-none"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && text.trim().length >= 3) {
                e.preventDefault()
                ask()
              }
            }}
          />
          <p className="t-small text-muted">
            Mention times (10am, from 12 to 3), places (Koramangala, MG Road) and what you need to do. I'll figure out the durations and route.
          </p>
        </div>
      )}

      {drafts && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2 rounded-card bg-green-tint px-4 py-3">
            <Sparkles size={18} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-green-ink" />
            <p className="t-body text-green-ink">
              Found {drafts.length} task{drafts.length === 1 ? '' : 's'} in your description.
            </p>
          </div>

          <AnimatePresence mode="popLayout">
            <ul className="flex flex-col gap-3">
              {drafts.map((d, i) => (
                <DraftCard key={draftKeys[i]} draft={d} index={i} trip={trip} onRemove={removeDraft} />
              ))}
            </ul>
          </AnimatePresence>

          {unmatched > 0 && (
            <Banner tone="info">
              {unmatched} task{unmatched === 1 ? " doesn't" : "s don't"} match a known place. Add {unmatched === 1 ? 'it' : 'them'} by hand from the task form, or try a different place name.
            </Banner>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="mt-3 t-small text-red-ink">{error}</p>
      )}
    </Sheet>
  )
}
