import { ArrowUp, Check, MapPin, Mic, X } from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { usePlaceSearch } from '@/api/queries'
import type { Place } from '@/api/types'
import { Spinner } from '@/components/ui/Spinner'
import { EASE_OUT } from '@/lib/motion'
import type { Expect } from '@/lib/roo/flows'
import { voiceSupported } from '@/lib/voice'
import { RooArt } from './RooArt'
import { typingMs, type Card, type ChatMsg } from './useConversation'

/** Roo's words appearing as it types them, word by word. The whole sentence is there for screen readers. */
function Typewriter({ text, play }: { text: string; play: boolean }) {
  const reduce = !!useReducedMotion()
  const words = text.split(/(\s+)/)
  const [shown, setShown] = useState(play && !reduce ? 0 : words.length)
  useEffect(() => {
    if (!play || reduce) return setShown(words.length)
    const step = typingMs(text) / Math.max(1, words.length)
    let n = 0
    const t = setInterval(() => {
      n += 1
      setShown(n)
      if (n >= words.length) clearInterval(t)
    }, step)
    return () => clearInterval(t)
    // A message types out once, when it arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // Typed out: plain text again, read once.
  if (shown >= words.length) return <>{text}</>
  return (
    <>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">
        {words.slice(0, shown).join('')}
        {/* The rest holds the bubble at its final size, so it doesn't grow line by line. */}
        <span className="opacity-0">{words.slice(shown).join('')}</span>
      </span>
    </>
  )
}

function ActionCard({ card, onYes, onNo }: { card: Card; onYes: () => void; onNo: () => void }) {
  return (
    <div className="mt-2 w-full min-w-[15rem] rounded-card border border-line bg-surface p-3">
      <p className="t-title text-ink">{card.title}</p>
      {card.detail && <p className="mt-0.5 t-small text-ink-2">{card.detail}</p>}
      {card.state === 'ask' && (
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" onClick={onYes} className="min-h-11 rounded-full bg-green px-4 t-small font-bold text-on-green transition-[background-color,scale] duration-[var(--dur-quick)] motion-safe:active:scale-[0.97] [@media(hover:hover)]:hover:bg-green-ink">
            {card.yes}
          </button>
          <button type="button" onClick={onNo} className="min-h-11 rounded-full border border-line-strong px-4 t-small font-bold text-ink transition-[background-color,scale] duration-[var(--dur-quick)] motion-safe:active:scale-[0.97] [@media(hover:hover)]:hover:bg-sunken">
            Not now
          </button>
        </div>
      )}
      {card.state === 'busy' && (
        <p role="status" className="mt-3 flex items-center gap-2 t-small text-ink-2">
          <Spinner size={16} /> Working on it…
        </p>
      )}
      {card.state === 'done' && (
        <p className="mt-3 flex items-center gap-2 t-small font-bold text-green-ink">
          <Check size={16} strokeWidth={2.25} aria-hidden="true" /> Done
        </p>
      )}
      {card.state === 'no' && <p className="mt-3 t-small text-muted">Left as it is</p>}
      {card.state === 'failed' && <p className="mt-3 t-small text-red-ink">Didn’t work. Your day is as it was.</p>}
    </div>
  )
}

const chipClass =
  'min-h-11 shrink-0 rounded-full border px-4 t-small font-bold text-ink transition-[background-color,border-color,scale] duration-[var(--dur-quick)] motion-safe:active:scale-[0.97] disabled:opacity-50'

export interface ThreadProps {
  msgs: ChatMsg[]
  thinking: boolean
  listening: boolean
  expect: Expect
  /** Free-chat suggestions, shown when Roo isn't asking anything in particular. */
  suggestions: string[]
  inFlow: boolean
  busy: boolean
  /** The page lays the thread out: a panel (scrolls inside) or the welcome screen. */
  className?: string
  autoFocus?: boolean
  onSend: (text: string) => void
  onPick: (id: string, label: string) => void
  onPlace: (p: Place) => void
  onDate: (d: string) => void
  onTime: (t: string) => void
  onLeave: () => void
  onRun: (msgId: string, card: Card) => void
  onDecline: (msgId: string) => void
  onListen: () => void
  onLink: (to: string) => void
}

/** The conversation and what you answer with: free text, choices, a place search, a date or a time. */
export function ChatThread(p: ThreadProps) {
  const reduce = !!useReducedMotion()
  const list = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState('')
  const [placeQ, setPlaceQ] = useState('')
  const city = p.expect.kind === 'place' && p.expect.city ? p.expect.city : { slug: 'bengaluru', name: 'Bengaluru' }
  const places = usePlaceSearch(p.expect.kind === 'place' ? placeQ : '', city.slug)
  const [date, setDate] = useState('')
  const [time, setTime] = useState('10:00')

  useEffect(() => {
    const el = list.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: reduce ? 'auto' : 'smooth' })
  }, [p.msgs, p.thinking, p.expect, places.data, reduce])
  // A new question starts its place search afresh. What you were typing stays, unless the box changes
  // between a search and a message (you may type while Roo is still typing its question).
  const lastKind = useRef(p.expect.kind)
  useEffect(() => {
    // A search Roo starts for you ("Let's find ramson hotel") shows its results at once.
    const initial = p.expect.kind === 'place' ? (p.expect.initial ?? '') : ''
    setPlaceQ(initial)
    if (initial) setDraft(initial)
    else if ((p.expect.kind === 'place') !== (lastKind.current === 'place')) setDraft('')
    lastKind.current = p.expect.kind
  }, [p.expect])
  useEffect(() => {
    if (p.autoFocus) input.current?.focus()
  }, [p.autoFocus, p.expect])

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (p.expect.kind === 'place') return setPlaceQ(draft)
    const text = draft.trim()
    if (!text) return
    setDraft('')
    p.onSend(text)
  }

  const ex = p.expect
  const waiting = p.thinking || p.busy
  const placeholder =
    p.listening ? 'Listening…' : ex.kind === 'text' || ex.kind === 'place' ? ex.placeholder : ex.kind === 'choice' && !ex.allowText ? 'Or type your own answer' : 'Ask Roo about your day'

  return (
    <div className={`flex min-h-0 flex-col ${p.className ?? ''}`}>
      <div ref={list} role="log" aria-label="Conversation with Roo" aria-live="polite" className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">
        <ol className="flex flex-col gap-3">
          {p.msgs.map((m, i) => (
            <motion.li
              key={m.id}
              className={`flex items-end gap-2 ${m.from === 'me' ? 'justify-end' : ''}`}
              initial={reduce ? { opacity: 0 } : { opacity: 0, transform: 'translateY(6px)' }}
              animate={{ opacity: 1, transform: 'translateY(0px)', transition: { duration: 0.2, ease: EASE_OUT } }}
            >
              {m.from === 'roo' && (
                <span className={`mb-0.5 flex size-7 shrink-0 items-end justify-center ${p.msgs[i + 1]?.from === 'roo' ? 'invisible' : ''}`} aria-hidden="true">
                  <RooArt mood="happy" size={26} reduce />
                </span>
              )}
              <div className={`flex max-w-[85%] flex-col ${m.from === 'me' ? 'items-end' : 'items-start'}`}>
                <p className={`rounded-[18px] px-4 py-2.5 t-body ${m.from === 'me' ? 'rounded-br-md bg-green text-on-green' : 'rounded-bl-md bg-sunken text-ink'}`}>
                  <span className="sr-only">{m.from === 'me' ? 'You: ' : 'Roo: '}</span>
                  {m.from === 'roo' ? <Typewriter text={m.text} play={!!m.fresh} /> : m.text}
                </p>
                {m.card && <ActionCard card={m.card} onYes={() => p.onRun(m.id, m.card!)} onNo={() => p.onDecline(m.id)} />}
                {m.links && (
                  <div className="mt-1 flex flex-wrap gap-x-4">
                    {m.links.map((l) => (
                      <button key={l.to} type="button" onClick={() => p.onLink(l.to)} className="min-h-11 t-small font-bold text-ink underline decoration-2 underline-offset-4">
                        {l.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </motion.li>
          ))}
          {p.thinking && (
            <li className="flex items-end gap-2">
              <span className="mb-0.5 flex size-7 shrink-0 items-end justify-center" aria-hidden="true">
                <RooArt mood="thinking" size={26} reduce />
              </span>
              <p className="rr-typing flex items-center gap-1 rounded-[18px] rounded-bl-md bg-sunken px-4 py-3.5">
                <span className="sr-only">Roo is typing</span>
                <span aria-hidden="true" />
                <span aria-hidden="true" />
                <span aria-hidden="true" />
              </p>
            </li>
          )}
        </ol>
      </div>

      <div className="border-t border-line">
        {/* What Roo asked for decides the answers on offer. */}
        {!waiting && ex.kind === 'choice' && (
          <div className="flex flex-wrap gap-2 px-4 pt-3" role="group" aria-label="Answers">
            {ex.options.map((c) => (
              <button key={c.id} type="button" onClick={() => p.onPick(c.id, c.label)} className={`${chipClass} border-green bg-green-tint [@media(hover:hover)]:hover:bg-green-tint/70`}>
                {c.label}
              </button>
            ))}
          </div>
        )}
        {!waiting && ex.kind === 'place' && placeQ.length >= 2 && (
          <div className="flex flex-col gap-1 px-4 pt-3" role="group" aria-label="Places found">
            {places.isPending && <p className="t-small text-ink-2">Searching…</p>}
            {places.data?.length === 0 && <p className="t-small text-ink-2">Nothing found in {city.name}. Try another name, or an area.</p>}
            {places.data?.slice(0, 5).map((pl) => (
              <button key={pl.placeId} type="button" onClick={() => p.onPlace(pl)} className="flex min-h-11 items-center gap-2 rounded-control px-2 text-left [@media(hover:hover)]:hover:bg-sunken">
                <MapPin size={18} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-muted" />
                <span className="min-w-0">
                  <span className="block truncate t-title text-ink">{pl.name}</span>
                  <span className="block truncate t-small text-ink-2">{pl.area}</span>
                </span>
              </button>
            ))}
          </div>
        )}
        {!waiting && ex.kind === 'free' && !p.inFlow && p.suggestions.length > 0 && (
          <div className="flex gap-2 overflow-x-auto px-4 pt-3 [scrollbar-width:none]" role="group" aria-label="Suggestions">
            {p.suggestions.map((c) => (
              <button key={c} type="button" onClick={() => p.onSend(c)} className={`${chipClass} border-line-strong [@media(hover:hover)]:hover:bg-sunken`}>
                {c}
              </button>
            ))}
          </div>
        )}

        {!waiting && ex.kind === 'date' ? (
          <form
            className="flex items-end gap-2 p-3"
            onSubmit={(e) => {
              e.preventDefault()
              if (date) p.onDate(date)
            }}
          >
            <label className="flex flex-1 flex-col gap-1">
              <span className="t-small font-bold text-ink">Start day</span>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="min-h-12 rounded-control border-2 border-line-strong bg-ground px-3 t-body text-ink focus-visible:border-green focus-visible:outline-none" />
            </label>
            <button type="submit" disabled={!date} className="min-h-12 rounded-full bg-green px-5 t-title text-on-green disabled:opacity-40">
              Choose
            </button>
          </form>
        ) : !waiting && ex.kind === 'time' ? (
          <form
            className="flex items-end gap-2 p-3"
            onSubmit={(e) => {
              e.preventDefault()
              if (time) p.onTime(time)
            }}
          >
            <label className="flex flex-1 flex-col gap-1">
              <span className="t-small font-bold text-ink">Start time</span>
              <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className="min-h-12 rounded-control border-2 border-line-strong bg-ground px-3 t-body text-ink focus-visible:border-green focus-visible:outline-none" />
            </label>
            <button type="submit" disabled={!time} className="min-h-12 rounded-full bg-green px-5 t-title text-on-green disabled:opacity-40">
              Set
            </button>
          </form>
        ) : (
          <form onSubmit={submit} className="flex items-center gap-2 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            {p.inFlow && (
              <button type="button" onClick={p.onLeave} aria-label="Stop this conversation" className="flex size-12 shrink-0 items-center justify-center rounded-full text-ink-2 [@media(hover:hover)]:hover:bg-sunken">
                <X size={18} strokeWidth={1.75} aria-hidden="true" />
              </button>
            )}
            <label htmlFor="roo-input" className="sr-only">
              {ex.kind === 'place' ? 'Search for a place' : 'Message Roo'}
            </label>
            <input
              id="roo-input"
              ref={input}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value)
                if (ex.kind === 'place' && e.target.value.trim().length >= 3) setPlaceQ(e.target.value)
              }}
              maxLength={500}
              autoComplete="off"
              enterKeyHint={ex.kind === 'place' ? 'search' : 'send'}
              placeholder={placeholder}
              disabled={waiting}
              className="min-h-12 min-w-0 flex-1 rounded-full border-2 border-line-strong bg-ground px-4 t-body text-ink placeholder:text-muted focus-visible:border-green focus-visible:outline-none disabled:opacity-60"
            />
            {voiceSupported() && ex.kind !== 'place' && (
              <button
                type="button"
                onClick={p.onListen}
                aria-label={p.listening ? 'Stop listening' : 'Talk to Roo'}
                aria-pressed={p.listening}
                className={`flex size-12 shrink-0 items-center justify-center rounded-full transition-colors duration-[var(--dur-quick)] ${p.listening ? 'bg-red-tint text-red-ink' : 'text-ink-2 [@media(hover:hover)]:hover:bg-sunken'}`}
              >
                <Mic size={20} strokeWidth={1.75} aria-hidden="true" />
              </button>
            )}
            <button
              type="submit"
              disabled={!draft.trim() || waiting}
              aria-label={ex.kind === 'place' ? 'Search' : 'Send'}
              className="flex size-12 shrink-0 items-center justify-center rounded-full bg-green text-on-green transition-[background-color,scale,opacity] duration-[var(--dur-quick)] motion-safe:active:enabled:scale-[0.97] disabled:opacity-40"
            >
              <ArrowUp size={20} strokeWidth={2.25} aria-hidden="true" />
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
