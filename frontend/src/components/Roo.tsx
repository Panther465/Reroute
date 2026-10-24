import * as Popover from '@radix-ui/react-popover'
import { X } from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLocation, useNavigate } from 'react-router'
import { useAiHelperEnabled, useBookings, useBookingsEnabled, useDay } from '@/api/queries'
import type { Booking, Trip } from '@/api/types'
import { checkIn } from '@/lib/actions'
import { hhmm, lowerFirst } from '@/lib/format'
import { EASE_OUT } from '@/lib/motion'
import { useOpenLate } from '@/lib/late'
import { useRooAnchor } from '@/lib/rooAnchor'
import { useSheetOpen } from '@/lib/sheets'
import { setState, useStore } from '@/lib/store'
import { activeBooking, isTrainTask } from '@/lib/bookings'
import { addDays, localMinutes, type DayView } from '@/lib/timeline'
import { RooAvatar, useRoo3D } from './roo3d/RooAvatar'
import type { Mood } from './roo/mood'

// Labels avoid "Running late" and "Plan my day": those name the screens' own buttons.
type ActionId = 'done' | 'more-time' | 'options' | 'describe' | 'plan' | 'summary' | 'add' | 'book-train' | 'later' | 'chat'

interface RooAction {
  id: ActionId
  label: string
  primary?: boolean
}

interface RooMessage {
  id: string
  text: string
  mood: Mood
  /** Shown at once and kept until answered; otherwise shown after a moment and allowed to fade. */
  urgent?: boolean
  actions?: RooAction[]
  /** The task an action is about (the train task for "Book my ticket"). */
  ref?: string
}

const GREETED_KEY = 'reroute.roo.greeted'

const stored = (key: string) => {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}
const store = (key: string, on: boolean) => {
  try {
    if (on) localStorage.setItem(key, '1')
    else localStorage.removeItem(key)
  } catch {
    // Private mode: Roo just forgets.
  }
}

// ---------------------------------------------------------------------------
// What Roo says by itself: read from the same day view the Today screen shows
// ---------------------------------------------------------------------------

function deriveMessage(trip: Trip | undefined, view: DayView | null, clock: number | null, path: string, bookings: Booking[] | undefined, ai: boolean): RooMessage | null {
  if (path !== '/') return null
  if (!trip) return { id: 'no-trip', text: 'No trip yet. Shall we set one up?', mood: 'wave', actions: [{ id: 'plan', label: 'Start a trip', primary: true }] }
  const open = trip.tasks.filter((t) => t.day === trip.day && t.state !== 'done' && t.state !== 'skipped')

  if (!view || clock == null) {
    if (open.length) return { id: 'need-plan', text: 'You have tasks but no route yet. Want me to work it out?', mood: 'idle', actions: [{ id: 'plan', label: 'Go to Plan', primary: true }] }
    return ai
      ? { id: 'empty-day', text: 'Nothing planned yet. Tell me about your day?', mood: 'idle', actions: [{ id: 'describe', label: 'Describe my day', primary: true }] }
      : { id: 'empty-day', text: 'Nothing planned yet. Add your first task?', mood: 'idle', actions: [{ id: 'add', label: 'Add a task', primary: true }] }
  }
  if (trip.openOptions) {
    return { id: 'options', text: 'Your later stops don’t fit any more. Let’s pick a fix together.', mood: 'alert', urgent: true, actions: [{ id: 'options', label: 'Show me the fixes', primary: true }] }
  }
  if (view.done) return { id: 'all-done', text: 'All done! What a day.', mood: 'happy', actions: [{ id: 'summary', label: 'See how it went', primary: true }] }

  const night = clock >= 22 * 60 || clock < 6 * 60
  const target = view.checkInTask
  const stop = target ? view.stops.find((s) => s.id === target.taskId) : undefined
  if (target && stop && clock > stop.end) {
    return {
      id: `ask-${target.taskId}-${stop.end}`,
      text: `Time’s up for the ${lowerFirst(target.title)}. All done?`,
      mood: 'alert',
      urgent: true,
      actions: [
        { id: 'done', label: 'Yes, done', primary: true },
        { id: 'more-time', label: 'Need more time' },
      ],
    }
  }

  const leg = view.nextLeg
  const to = leg ? view.stops.find((s) => s.id === leg.toId) : undefined
  const dest = to ? (to.kind === 'end' ? 'the hotel' : `the ${lowerFirst(to.title)}`) : 'your next stop'
  if (leg && clock >= leg.leaveMin - 10 && clock <= leg.leaveMin) {
    const mins = Math.round(leg.leaveMin - clock)
    return {
      id: `leave-${leg.seq}-${leg.leaveMin}`,
      text: mins > 0 ? `Leave in ${mins} min for ${dest}!` : `Time to head out for ${dest}!`,
      mood: 'alert',
      urgent: true,
      actions: [{ id: 'more-time', label: 'Need more time' }],
    }
  }
  // A train today or tomorrow with no ticket yet: offer to book one (a demo booking).
  const train = trip.tasks.find((t) => (t.day === trip.day || t.day === addDays(trip.day, 1)) && t.state !== 'done' && t.state !== 'skipped' && isTrainTask(t) && !activeBooking(bookings, { taskId: t.taskId }))
  if (train && bookings) {
    const at = train.fixedStart ? hhmm(localMinutes(train.fixedStart, train.day, trip.utcOffset)) : null
    const when = train.day === trip.day ? 'today' : 'tomorrow'
    return {
      id: `book-train-${train.taskId}`,
      text: `You’re catching a train${at ? ` at ${at}` : ''} ${when}. Shall I book your ticket?`,
      mood: 'happy',
      ref: train.taskId,
      actions: [
        { id: 'book-train', label: 'Book my ticket', primary: true },
        { id: 'later', label: 'Not now' },
      ],
    }
  }
  if (stop && view.stops[view.nowIndex]?.id === stop.id && clock >= stop.time) {
    return { id: `at-${stop.id}`, text: `Enjoy the ${lowerFirst(stop.title)}. I’ll check on you at ${hhmm(stop.end)}.`, mood: 'happy' }
  }
  if (night) return { id: 'night', text: 'It’s late. Rest up, I’ll keep watch.', mood: 'sleeping' }
  if (leg && to && leg.leaveMin - clock <= 90) {
    return { id: `next-${leg.seq}-${leg.leaveMin}`, text: `Next: leave at ${leg.leaveBy} for ${dest}. Plenty of time.`, mood: 'idle' }
  }
  return { id: 'on-track', text: 'Your day is on track. Tap me to chat.', mood: 'idle' }
}

// ---------------------------------------------------------------------------
// Speech bubble with answers
// ---------------------------------------------------------------------------

function BubbleBody({ msg, onAction, onClose }: { msg: RooMessage; onAction: (id: ActionId) => void; onClose: () => void }) {
  return (
    <>
      <p className="t-body leading-snug text-ink">{msg.text}</p>
      {!!msg.actions?.length && (
        <div className="mt-3 flex flex-wrap gap-2">
          {msg.actions.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => onAction(a.id)}
              className={`min-h-12 rounded-full px-4 t-small font-bold transition-[color,background-color,scale] duration-[var(--dur-quick)] motion-safe:active:scale-[0.97] ${
                a.primary ? 'bg-green text-on-green [@media(hover:hover)]:hover:bg-green-ink' : 'border border-line-strong text-ink [@media(hover:hover)]:hover:bg-sunken'
              }`}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        onClick={onClose}
        aria-label="Close Rico’s message"
        className="absolute right-1 top-1 flex size-12 items-center justify-center rounded-full text-muted [@media(hover:hover)]:hover:bg-sunken"
      >
        <X size={18} strokeWidth={1.75} aria-hidden="true" />
      </button>
    </>
  )
}

// ---------------------------------------------------------------------------
// Roo
// ---------------------------------------------------------------------------

/**
 * Roo on Today's Now line: it breathes, looks around, follows the pointer, speaks up when there's news,
 * and opens a chat when tapped (components/roo/RooChat).
 */
export function Roo({ trip, clock }: { trip: Trip | undefined; clock: number | null }) {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const openLate = useOpenLate()
  const reduce = !!useReducedMotion()
  const view = useDay(trip, clock)
  const bookingsOn = useBookingsEnabled()
  const bookings = useBookings(bookingsOn ? trip?.tripId : null)
  const ai = useAiHelperEnabled()
  const derived = useMemo(() => deriveMessage(trip, view, clock, pathname, bookings.data, ai), [trip, view, clock, pathname, bookings.data, ai])

  const shownPref = useStore((st) => st.roo)
  const chatting = useStore((st) => st.rooChat)
  const hidden = !shownPref
  const [greeted, setGreeted] = useState(() => stored(GREETED_KEY))
  const [override, setOverride] = useState<RooMessage | null>(null)
  const [open, setOpen] = useState(false)
  const dismissed = useRef(new Set<string>())
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // Hello waits for Today: on the start form it would sit over "Plan my day", the one button that matters.
  const greeting: RooMessage | null =
    greeted || pathname !== '/' ? null : { id: 'greet', text: 'Hi, I’m Rico! I’ll keep an eye on your day and nudge you when it’s time. Tap me to chat, any time.', mood: 'wave' }
  const msg = override ?? greeting ?? (derived && !dismissed.current.has(derived.id) ? derived : null)

  const schedule = useCallback((m: RooMessage) => {
    clearTimeout(fadeTimer.current)
    if (m.urgent) return
    fadeTimer.current = setTimeout(() => {
      setOpen(false)
      setOverride(null)
      if (m.id === 'greet') {
        setGreeted(true)
        store(GREETED_KEY, true)
      }
    }, m.actions?.length ? 15000 : 8000)
  }, [])

  // Speak up when there is something new to say: at once when it matters, after a beat otherwise.
  const msgId = msg?.id ?? null
  const lastShown = useRef<string | null>(null)
  useEffect(() => {
    if (!msg || hidden || msgId === lastShown.current) return
    lastShown.current = msgId
    const id = setTimeout(
      () => {
        setOpen(true)
        schedule(msg)
      },
      msg.urgent || override ? 0 : 1200,
    )
    return () => clearTimeout(id)
    // `msg` is described by its id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msgId, hidden, schedule])
  useEffect(() => () => clearTimeout(fadeTimer.current), [])

  // A task newly checked in done: celebrate it.
  const doneKey = view ? view.stops.filter((s) => s.task?.state === 'done').map((s) => s.id).join('|') : ''
  const prevDone = useRef<string | null>(null)
  useEffect(() => {
    const prev = prevDone.current
    prevDone.current = doneKey
    if (prev === null || !view) return
    const before = new Set(prev.split('|'))
    const fresh = view.stops.find((s) => s.task?.state === 'done' && !before.has(s.id))
    if (!fresh) return
    setOverride({ id: `yay-${fresh.id}`, text: `Nice one! The ${lowerFirst(fresh.title)} is done.`, mood: 'celebrate' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doneKey])

  const artRef = useRef<HTMLButtonElement>(null)

  const close = () => {
    clearTimeout(fadeTimer.current)
    setOpen(false)
    if (msg?.id === 'greet') {
      setGreeted(true)
      store(GREETED_KEY, true)
    } else if (msg && !override) dismissed.current.add(msg.id)
    setOverride(null)
    // Closing one message doesn't pop up the one underneath it.
    lastShown.current = derived?.id ?? null
  }

  const act = (id: ActionId) => {
    close()
    if (id === 'done' && trip && view && clock != null) checkIn(trip.tripId, view, clock)
    else if (id === 'more-time') openLate()
    else if (id === 'options') openLate(null, 'options')
    else if (id === 'describe') navigate('/plan', { state: { openAi: true } })
    else if (id === 'plan') navigate('/plan')
    else if (id === 'summary') navigate('/summary')
    else if (id === 'add') navigate('/', { state: { add: Date.now() } })
    else if (id === 'book-train' && msg?.ref) navigate('/', { state: { bookTrain: msg.ref } })
    else if (id === 'chat') setState({ rooChat: true })
  }

  // A tap opens the chat. A message Roo was showing can wait: the chat's hello says where the day stands.
  const tap = () => {
    if (open && msg) close()
    setState({ rooChat: true })
  }
  const anchor = useRooAnchor()
  // A message waits while a sheet or the chat is open: their buttons and Escape belong to them.
  const sheetOpen = useSheetOpen()

  if (hidden) return null

  const shown = open && msg && !sheetOpen && !chatting ? msg : null
  const mood: Mood = chatting ? 'happy' : (shown?.mood ?? (derived?.mood === 'sleeping' ? 'sleeping' : derived?.urgent ? 'alert' : 'idle'))

  // On Today, Roo rides the timeline at the Now line; its words open in a popover above the page.
  // The live 3D Roo breathes and hops by itself; its still needs the wrapper to.
  const solid = useRoo3D(reduce)
  if (anchor && pathname === '/') {
    return createPortal(
      <Popover.Root
        open={!!shown}
        onOpenChange={(o) => {
          if (!o) close()
        }}
      >
        <Popover.Anchor asChild>
          <div className="relative">
            {/* The button stays still (a steady target); only Roo inside it moves. */}
            <button
              ref={artRef}
              type="button"
              onClick={tap}
              aria-label="Rico, your travel companion. Chat with Rico"
              aria-haspopup="dialog"
              aria-expanded={chatting}
              className="group flex size-12 cursor-pointer items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--focus)]"
            >
              <span className={solid ? 'block' : 'rr-roo-breathe block'}>
                <span className="block transition-[scale] duration-[var(--dur-quick)] motion-safe:group-active:scale-[0.9]">
                  <motion.span
                    className="block"
                    animate={
                      reduce || solid
                        ? {}
                        : mood === 'celebrate'
                          ? { transform: ['translateY(0px)', 'translateY(-14px)', 'translateY(0px)'], transition: { duration: 0.8, ease: EASE_OUT } }
                          : mood === 'alert'
                            ? { transform: ['translateY(0px)', 'translateY(-6px)', 'translateY(0px)'], transition: { duration: 0.5, ease: EASE_OUT } }
                            : { transform: 'translateY(0px)' }
                    }
                  >
                    <RooAvatar mood={mood} size={46} reduce={reduce} quiet />
                  </motion.span>
                </span>
              </span>
            </button>
          </div>
        </Popover.Anchor>
        <Popover.Portal>
          {shown && (
            <Popover.Content
              side="bottom"
              align="end"
              sideOffset={6}
              collisionPadding={16}
              // A message Roo raises never takes focus.
              onOpenAutoFocus={(e) => e.preventDefault()}
              onInteractOutside={(e) => {
                if (artRef.current?.contains(e.target as Node)) e.preventDefault()
              }}
              role="status"
              className="relative z-[60] w-[min(300px,calc(100vw-32px))] rounded-card border border-line bg-surface p-4 pr-14 text-left shadow-[var(--shadow-toast)]"
            >
              <BubbleBody msg={shown} onAction={act} onClose={close} />
              <Popover.Arrow className="fill-[var(--surface)]" width={14} height={7} />
            </Popover.Content>
          )}
        </Popover.Portal>
      </Popover.Root>,
      anchor,
    )
  }

  return null
}
