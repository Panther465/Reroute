import * as Dialog from '@radix-ui/react-dialog'
import { ArrowUp, Check, Mic, X } from 'lucide-react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router'
import { api, ApiError, newKey } from '@/api/client'
import { keys, queryClient, useAiHelperEnabled, useDay, useMe } from '@/api/queries'
import type { RooOut, Trip } from '@/api/types'
import { Spinner } from '@/components/ui/Spinner'
import { speak } from '@/lib/alerts'
import { checkIn, editTask, moveTaskToDay, replanDay, skipTask, undo, undoVersionOf } from '@/lib/actions'
import { hhmm } from '@/lib/format'
import { useIsDesktop, useOnline } from '@/lib/hooks'
import { useOpenLate } from '@/lib/late'
import { EASE_DRAWER, EASE_OUT } from '@/lib/motion'
import { confirmFor, forSpeech, greeting, suggestions, understand, type RooAction, type RooAnswer, type RooContext, type RooLink } from '@/lib/roo/brain'
import { getState, setState, useStore } from '@/lib/store'
import { buildDay, weekday } from '@/lib/timeline'
import { listenOnce, voiceSupported, VoiceError } from '@/lib/voice'
import { RooArt, type Mood } from './RooArt'

type CardState = 'ask' | 'busy' | 'done' | 'no' | 'failed'
interface Card {
  action: RooAction
  title: string
  detail?: string
  yes: string
  state: CardState
}
interface ChatMsg {
  id: string
  from: 'roo' | 'me'
  text: string
  at: number
  card?: Card
  links?: RooLink[]
}

const KEY = (tripId: string) => `reroute.roo.chat.v1:${tripId}`
const KEEP = 40

function loadChat(tripId: string | undefined): ChatMsg[] {
  if (!tripId) return []
  try {
    const saved = JSON.parse(sessionStorage.getItem(KEY(tripId)) ?? '[]') as ChatMsg[]
    // A change cut off by a reload never ran: ask again.
    return saved.map((m) => (m.card?.state === 'busy' ? { ...m, card: { ...m.card, state: 'ask' as const } } : m))
  } catch {
    return []
  }
}

function saveChat(tripId: string | undefined, msgs: ChatMsg[]) {
  if (!tripId) return
  try {
    sessionStorage.setItem(KEY(tripId), JSON.stringify(msgs.slice(-KEEP)))
  } catch {
    // Private mode: the chat lasts until the page closes.
  }
}

const id = () => Math.random().toString(36).slice(2, 10)

/** What the server's AI offered, in the phone's terms, with the same card the phone would show. */
function fromServer(out: RooOut, trip: Trip): RooAnswer {
  const a = out.action
  if (!a) return { reply: out.reply, mood: 'happy' }
  const task = a.taskId ?? ''
  let action: RooAction | undefined
  let links: RooLink[] | undefined
  if (a.type === 'late') action = { type: 'late', minutes: a.minutes ?? null }
  else if (a.type === 'done' || a.type === 'left' || a.type === 'replan' || a.type === 'undo') action = { type: a.type }
  else if (a.type === 'skip') action = { type: 'skip', taskId: task }
  else if (a.type === 'move' && a.day) action = { type: 'move', taskId: task, day: a.day }
  else if (a.type === 'duration' && a.minutes) action = { type: 'duration', taskId: task, minutes: a.minutes }
  else if (a.type === 'time' && a.time) action = { type: 'time', taskId: task, hhmm: a.time }
  else if (a.type === 'add') action = { type: 'add', text: a.text ?? '' }
  else if (a.type === 'theme' && a.theme) action = { type: 'theme', theme: a.theme }
  else if (a.type === 'why') links = [{ label: 'Why this plan?', to: '/why' }]
  else if (a.type === 'summary') links = [{ label: 'See the summary', to: '/summary' }]
  return { reply: out.reply, action, confirm: action && confirmFor(action, trip), links, taskId: a.taskId ?? undefined, mood: 'happy' }
}

/** After a change, where the day stands now, from the fresh trip. */
function afterChange(tripId: string, action: RooAction): string {
  const trip = queryClient.getQueryData<Trip>(keys.trip(tripId))
  const view = trip ? buildDay(trip) : null
  const end = view?.stops[view.stops.length - 1]
  const back = end && !view?.done ? ` You’ll be back at the hotel around ${hhmm(end.time)}.` : ''
  const task = trip && 'taskId' in action ? trip.tasks.find((t) => t.taskId === action.taskId) : undefined
  const name = task ? `the ${task.title.toLowerCase()}` : 'it'
  if (action.type === 'move') return `Done. ${name[0].toUpperCase()}${name.slice(1)} is on ${weekday(action.day)} now.${back}`
  if (action.type === 'skip') return `Done. I’ve skipped ${name} and moved the rest up.${back}`
  if (action.type === 'undo') return `Your earlier plan is back.${back}`
  return `Done. Your day is re-planned.${back}`
}

const PANEL_DESKTOP = 'fixed right-4 top-20 bottom-4 z-50 flex w-[400px] flex-col overflow-hidden rounded-sheet border border-line bg-surface text-ink shadow-[var(--shadow-toast)] outline-none'
const PANEL_PHONE = 'fixed inset-x-0 bottom-0 z-50 mx-auto flex h-[88dvh] w-full max-w-[560px] flex-col overflow-hidden rounded-t-sheet bg-surface text-ink shadow-[var(--shadow-sheet)] outline-none'

/**
 * Talking with Roo. Roo answers from the day as it is (on the phone; the server's AI helper for what the
 * phone can't place, when that's on). A change to the day is a card: nothing happens until it's tapped.
 * On a desktop the chat sits beside the page, so the timeline re-routes in view while you talk.
 */
export function RooChat({ trip, clock }: { trip: Trip | undefined; clock: number | null }) {
  const open = useStore((s) => s.rooChat)
  const desktop = useIsDesktop()
  const reduce = !!useReducedMotion()
  const navigate = useNavigate()
  const openLate = useOpenLate()
  const online = useOnline()
  const ai = useAiHelperEnabled()
  const me = useMe()
  const view = useDay(trip, clock)
  const leftFor = useStore((s) => (s.started && s.started.tripId === trip?.tripId ? s.started.toId : null))
  const tripId = trip?.tripId

  const [msgs, setMsgs] = useState<ChatMsg[]>(() => loadChat(tripId))
  const [draft, setDraft] = useState('')
  const [thinking, setThinking] = useState(false)
  const [listening, setListening] = useState(false)
  const [talking, setTalking] = useState(false)
  const [mood, setMood] = useState<Mood>('happy')
  const lastTask = useRef<string | null>(null)
  const listenCtl = useRef<AbortController | null>(null)
  const list = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])

  const ctx: RooContext = { trip, view, clock, leftFor, name: me.data?.name, lastTaskId: lastTask.current }
  const latest = useRef(ctx)
  latest.current = ctx
  const chips = useMemo(() => suggestions(ctx), [trip, view, clock]) // eslint-disable-line react-hooks/exhaustive-deps

  // Another trip, another conversation.
  useEffect(() => setMsgs(loadChat(tripId)), [tripId])
  useEffect(() => saveChat(tripId, msgs), [tripId, msgs])
  useEffect(() => () => timers.current.forEach(clearTimeout), [])

  // Opening the chat: Roo says hello (again, after a long gap), and the conversation scrolls to the end.
  useEffect(() => {
    // Closing the chat turns the microphone off.
    if (!open) return stopListening()
    setMsgs((m) => {
      const last = m[m.length - 1]
      if (last && Date.now() - last.at < 2 * 60 * 60 * 1000) return m
      const hello = greeting(latest.current)
      return [...m, { id: id(), from: 'roo', text: hello.reply, at: Date.now() }]
    })
    setMood('wave')
    const t = setTimeout(() => setMood('happy'), 1400)
    return () => clearTimeout(t)
  }, [open])
  useEffect(() => {
    const el = list.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: reduce ? 'auto' : 'smooth' })
  }, [msgs, thinking, reduce])

  const later = (fn: () => void, ms: number) => timers.current.push(setTimeout(fn, ms))
  const close = () => setState({ rooChat: false })
  const push = (m: Omit<ChatMsg, 'id' | 'at'>) => setMsgs((all) => [...all, { ...m, id: id(), at: Date.now() }].slice(-KEEP))
  const say = (text: string, out = false) => {
    if (!out) return
    setTalking(true)
    void speak(forSpeech(text)).finally(() => setTalking(false))
  }

  // Actions that need no card: they open a sheet, change a setting, or say where you are.
  const runNow = (action: RooAction) => {
    const { trip: t, view: v, clock: c } = latest.current
    if (action.type === 'theme') return setState({ theme: action.theme })
    if (action.type === 'voice') return setState({ alerts: { ...getState().alerts, voice: action.on } })
    if (action.type === 'left' && t && v?.nextLeg && c != null) return setState({ started: { tripId: t.tripId, toId: v.nextLeg.toId, day: t.day, at: c } })
    if (action.type === 'done' && t && v && c != null) return checkIn(t.tripId, v, c)
    // A sheet takes over: the chat steps aside after Roo has said what it's doing.
    later(() => {
      close()
      if (action.type === 'late') openLate(action.minutes)
      else if (action.type === 'options') openLate(null, 'options')
      else if (action.type === 'add') navigate('/', { state: { add: Date.now(), addText: action.text || undefined } })
    }, 700)
  }

  const answer = (a: RooAnswer, spoken: boolean) => {
    if (a.taskId) lastTask.current = a.taskId
    const card = a.confirm && a.action ? { action: a.action, ...a.confirm, state: 'ask' as const } : undefined
    // Roo takes a moment, as anyone would: longer for a longer answer, never long.
    const wait = Math.min(900, 280 + a.reply.length * 6)
    later(() => {
      setThinking(false)
      setMood(a.mood && a.mood !== 'idle' ? a.mood : 'happy')
      push({ from: 'roo', text: a.reply, card, links: a.links })
      say(a.reply, spoken)
      if (a.action && !card) runNow(a.action)
    }, wait)
  }

  const send = async (text: string, spoken = false) => {
    const said = text.trim()
    if (!said || thinking) return
    setDraft('')
    push({ from: 'me', text: said })
    setThinking(true)
    setMood('thinking')
    const local = understand(said, latest.current)
    const t = latest.current.trip
    if (!local.unknown || !ai || !online || !t) return answer(local, spoken)
    try {
      const history = msgs.slice(-8).map((m) => ({ role: m.from === 'me' ? ('user' as const) : ('roo' as const), text: m.text.slice(0, 600) }))
      const out = await api.post<RooOut>(`/v1/trips/${t.tripId}/roo`, { message: said.slice(0, 500), history }, { idempotencyKey: newKey('roo') })
      answer(fromServer(out, t), spoken)
    } catch {
      answer(local, spoken)
    }
  }

  const run = async (msgId: string, card: Card) => {
    const t = latest.current.trip
    if (!t) return
    const set = (state: CardState) => setMsgs((all) => all.map((m) => (m.id === msgId && m.card ? { ...m, card: { ...m.card, state } } : m)))
    set('busy')
    setMood('thinking')
    const before = latest.current.view
    const a = card.action
    try {
      if (a.type === 'skip') await skipTask(t.tripId, a.taskId, before)
      else if (a.type === 'move') await moveTaskToDay(t.tripId, a.taskId, a.day, before)
      else if (a.type === 'duration') await editTask(t.tripId, a.taskId, { durationMin: a.minutes }, before)
      else if (a.type === 'time') {
        const task = t.tasks.find((x) => x.taskId === a.taskId)
        await editTask(t.tripId, a.taskId, { timing: 'fixed', fixedStart: `${task?.day ?? t.day}T${a.hhmm}:00${t.utcOffset}` }, before)
      } else if (a.type === 'replan') await replanDay(t.tripId, before)
      else if (a.type === 'undo') {
        const version = undoVersionOf(t)
        if (version == null) throw new ApiError(409, 'NOTHING_TO_UNDO', 'There’s no earlier plan to go back to.')
        await undo(t.tripId, version)
      }
      set('done')
      setMood('celebrate')
      later(() => setMood('happy'), 1600)
      push({ from: 'roo', text: afterChange(t.tripId, a) })
    } catch (err) {
      set('failed')
      setMood('alert')
      push({ from: 'roo', text: `I couldn’t do that: ${err instanceof ApiError ? err.message : 'something went wrong.'} Your day is as it was.` })
    }
  }

  const decline = (msgId: string) => {
    setMsgs((all) => all.map((m) => (m.id === msgId && m.card ? { ...m, card: { ...m.card, state: 'no' } } : m)))
    push({ from: 'roo', text: 'Okay, I’ll leave it as it is.' })
  }

  const stopListening = () => {
    listenCtl.current?.abort()
    listenCtl.current = null
    setListening(false)
  }

  const listen = async () => {
    if (listening) {
      stopListening()
      return setMood('happy')
    }
    const ctl = new AbortController()
    listenCtl.current = ctl
    setListening(true)
    setMood('listening')
    try {
      const heard = await listenOnce({ signal: ctl.signal })
      setListening(false)
      void send(heard, true)
    } catch (err) {
      setListening(false)
      setMood('happy')
      push({ from: 'roo', text: err instanceof VoiceError ? err.message : 'I couldn’t listen just now. Type it instead.' })
    }
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    void send(draft)
  }

  const face: Mood = listening ? 'listening' : talking ? 'talking' : thinking ? 'thinking' : mood
  const status = listening ? 'Listening…' : thinking ? 'Thinking…' : talking ? 'Talking…' : 'Your travel companion'

  return (
    <Dialog.Root open={open} onOpenChange={(o) => setState({ rooChat: o })} modal={!desktop}>
      <AnimatePresence>
        {open && (
          <Dialog.Portal forceMount>
            {!desktop && (
              <Dialog.Overlay asChild forceMount>
                <motion.div className="fixed inset-0 z-50 bg-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { duration: 0.16 } }} exit={{ opacity: 0, transition: { duration: 0.14 } }} />
              </Dialog.Overlay>
            )}
            <Dialog.Content
              asChild
              forceMount
              aria-describedby={undefined}
              // Beside the page on a desktop: clicking the page doesn't close it, and focus can move there.
              onInteractOutside={(e) => desktop && e.preventDefault()}
              onOpenAutoFocus={(e) => {
                // A phone keyboard would cover the conversation: focus the chat itself, not the field.
                if (!desktop) {
                  e.preventDefault()
                  ;(e.currentTarget as HTMLElement | null)?.focus()
                } else input.current?.focus()
              }}
            >
              <motion.section
                className={desktop ? PANEL_DESKTOP : PANEL_PHONE}
                initial={reduce ? { opacity: 0 } : desktop ? { opacity: 0, transform: 'translateX(24px)' } : { transform: 'translateY(100%)' }}
                animate={desktop ? { opacity: 1, transform: 'translateX(0px)', transition: { duration: 0.24, ease: EASE_OUT } } : { opacity: 1, transform: 'translateY(0%)', transition: { duration: 0.32, ease: EASE_DRAWER } }}
                exit={reduce ? { opacity: 0, transition: { duration: 0.12 } } : desktop ? { opacity: 0, transform: 'translateX(24px)', transition: { duration: 0.16, ease: EASE_OUT } } : { transform: 'translateY(100%)', transition: { duration: 0.22, ease: EASE_DRAWER } }}
              >
                <header className="flex items-center gap-3 border-b border-line py-2 pl-4 pr-2">
                  <span className="rr-roo-breathe flex size-12 shrink-0 items-end justify-center">
                    <RooArt mood={face} size={42} reduce={reduce} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <Dialog.Title className="t-title text-ink">Roo</Dialog.Title>
                    <p className="t-small text-muted" aria-live="polite">
                      {status}
                    </p>
                  </div>
                  <Dialog.Close className="flex size-12 shrink-0 items-center justify-center rounded-control text-ink-2 [@media(hover:hover)]:hover:bg-sunken" aria-label="Close the chat">
                    <X size={20} strokeWidth={1.75} aria-hidden="true" />
                  </Dialog.Close>
                </header>

                <div ref={list} role="log" aria-label="Conversation with Roo" aria-live="polite" className="flex-1 overflow-y-auto overscroll-contain px-4 py-4">
                <ol className="flex flex-col gap-3">
                  {msgs.map((m, i) => (
                    <motion.li
                      key={m.id}
                      className={`flex items-end gap-2 ${m.from === 'me' ? 'justify-end' : ''}`}
                      initial={reduce ? { opacity: 0 } : { opacity: 0, transform: 'translateY(6px)' }}
                      animate={{ opacity: 1, transform: 'translateY(0px)', transition: { duration: 0.2, ease: EASE_OUT } }}
                    >
                      {m.from === 'roo' && (
                        <span className={`mb-0.5 flex size-7 shrink-0 items-end justify-center ${msgs[i + 1]?.from === 'roo' ? 'invisible' : ''}`} aria-hidden="true">
                          <RooArt mood="happy" size={26} reduce />
                        </span>
                      )}
                      <div className={`flex max-w-[85%] flex-col ${m.from === 'me' ? 'items-end' : 'items-start'}`}>
                        <p className={`rounded-[18px] px-4 py-2.5 t-body ${m.from === 'me' ? 'rounded-br-md bg-green text-on-green' : 'rounded-bl-md bg-sunken text-ink'}`}>
                          <span className="sr-only">{m.from === 'me' ? 'You: ' : 'Roo: '}</span>
                          {m.text}
                        </p>
                        {m.card && <ActionCard card={m.card} onYes={() => void run(m.id, m.card!)} onNo={() => decline(m.id)} />}
                        {m.links && (
                          <div className="mt-1 flex flex-wrap gap-x-4">
                            {m.links.map((l) => (
                              <button
                                key={l.to}
                                type="button"
                                onClick={() => {
                                  if (!desktop) close()
                                  navigate(l.to)
                                }}
                                className="min-h-11 t-small font-bold text-ink underline decoration-2 underline-offset-4"
                              >
                                {l.label}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </motion.li>
                  ))}
                  {thinking && (
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
                  {!thinking && chips.length > 0 && (
                    <div className="flex gap-2 overflow-x-auto px-4 pt-3 [scrollbar-width:none]" role="group" aria-label="Suggestions">
                      {chips.map((c) => (
                        <button
                          key={c}
                          type="button"
                          onClick={() => void send(c)}
                          className="min-h-11 shrink-0 rounded-full border border-line-strong px-4 t-small font-bold text-ink transition-[background-color,scale] duration-[var(--dur-quick)] motion-safe:active:scale-[0.97] [@media(hover:hover)]:hover:bg-sunken"
                        >
                          {c}
                        </button>
                      ))}
                    </div>
                  )}
                  <form onSubmit={submit} className="flex items-center gap-2 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
                    <label htmlFor="roo-input" className="sr-only">
                      Message Roo
                    </label>
                    <input
                      id="roo-input"
                      ref={input}
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      maxLength={500}
                      autoComplete="off"
                      enterKeyHint="send"
                      placeholder={listening ? 'Listening…' : 'Ask Roo about your day'}
                      className="min-h-12 min-w-0 flex-1 rounded-full border-2 border-line-strong bg-ground px-4 t-body text-ink placeholder:text-muted focus-visible:border-green focus-visible:outline-none"
                    />
                    {voiceSupported() && (
                      <button
                        type="button"
                        onClick={() => void listen()}
                        aria-label={listening ? 'Stop listening' : 'Talk to Roo'}
                        aria-pressed={listening}
                        className={`flex size-12 shrink-0 items-center justify-center rounded-full transition-colors duration-[var(--dur-quick)] ${listening ? 'bg-red-tint text-red-ink' : 'text-ink-2 [@media(hover:hover)]:hover:bg-sunken'}`}
                      >
                        <Mic size={20} strokeWidth={1.75} aria-hidden="true" />
                      </button>
                    )}
                    <button
                      type="submit"
                      disabled={!draft.trim() || thinking}
                      aria-label="Send"
                      className="flex size-12 shrink-0 items-center justify-center rounded-full bg-green text-on-green transition-[background-color,scale,opacity] duration-[var(--dur-quick)] motion-safe:active:enabled:scale-[0.97] disabled:opacity-40"
                    >
                      <ArrowUp size={20} strokeWidth={2.25} aria-hidden="true" />
                    </button>
                  </form>
                </div>
              </motion.section>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  )
}

/** A change Roo offers: what it is, and one tap to do it. Then what happened. */
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

export default RooChat
