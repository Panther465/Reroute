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
import { useOpenLate } from '@/lib/late'
import { useRooAnchor } from '@/lib/rooAnchor'
import { useSheetOpen } from '@/lib/sheets'
import { setState, showToast, useStore } from '@/lib/store'
import { activeBooking, isTrainTask } from '@/lib/bookings'
import { addDays, localMinutes, type DayView } from '@/lib/timeline'

type Mood = 'idle' | 'happy' | 'alert' | 'sleeping' | 'celebrate' | 'wave'
// Labels avoid "Running late" and "Plan my day": those name the screens' own buttons.
type ActionId = 'done' | 'more-time' | 'options' | 'describe' | 'plan' | 'summary' | 'today' | 'hide' | 'add' | 'edit' | 'book-train' | 'later'

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
// What Roo says: read from the same day view the Today screen shows
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
  return { id: 'on-track', text: 'Your day is on track. Tap me if you need anything.', mood: 'idle' }
}

function menuFor(trip: Trip | undefined, view: DayView | null, path: string, clock: number | null, ai: boolean): RooMessage {
  const actions: RooAction[] = []
  // On Today, Roo rides the timeline: add to the day, or deal with the stop under way, right here.
  if (path === '/' && view && !view.done) {
    actions.push({ id: 'add', label: 'Add a task', primary: true })
    const task = view.checkInTask
    const stop = task ? view.stops.find((s) => s.id === task.taskId) : undefined
    if (task && stop) {
      if (stop.status === 'now' && clock != null && clock >= stop.time) actions.push({ id: 'done', label: `Mark the ${lowerFirst(task.title)} done` })
      actions.push({ id: 'edit', label: `Edit the ${lowerFirst(task.title)}` })
      actions.push({ id: 'more-time', label: 'Need more time' })
    }
    actions.push({ id: 'summary', label: 'How’s my day?' })
    actions.push({ id: 'hide', label: 'Hide Roo' })
    return { id: 'menu', text: 'Hi! What shall we do?', mood: 'happy', actions }
  }
  if (trip) actions.push(ai ? { id: 'describe', label: 'Describe my day', primary: true } : { id: 'add', label: 'Add a task', primary: true })
  if (view && !view.done && view.checkInTask) actions.push({ id: 'more-time', label: 'Need more time' })
  if (path !== '/' && view) actions.push({ id: 'today', label: 'Show today' })
  if (view) actions.push({ id: 'summary', label: 'How’s my day?' })
  actions.push({ id: 'hide', label: 'Hide Roo' })
  return { id: 'menu', text: 'Hi! What can I do for you?', mood: 'happy', actions }
}

// ---------------------------------------------------------------------------
// The character
// ---------------------------------------------------------------------------

const BLINK_CSS = `@keyframes roo-blink { 0%, 93%, 100% { transform: scaleY(1) } 96% { transform: scaleY(0.1) } }`

function Eyes({ mood, look }: { mood: Mood; look: { x: number; y: number } }) {
  const ink = 'var(--roo-ink)'
  if (mood === 'sleeping') {
    return (
      <g stroke={ink} strokeWidth="2.4" fill="none" strokeLinecap="round">
        <path d="M24 47 Q30 51 36 47" />
        <path d="M44 47 Q50 51 56 47" />
      </g>
    )
  }
  if (mood === 'happy' || mood === 'celebrate' || mood === 'wave') {
    return (
      <g stroke={ink} strokeWidth="2.6" fill="none" strokeLinecap="round">
        <path d="M24 48 Q30 41 36 48" />
        <path d="M44 48 Q50 41 56 48" />
      </g>
    )
  }
  const ry = mood === 'alert' ? 9.5 : 8.5
  return (
    <g style={{ animation: 'roo-blink 4.5s ease-in-out infinite', transformOrigin: '40px 46px' }}>
      <ellipse cx="30" cy="46" rx="7.5" ry={ry} fill="#fff" />
      <ellipse cx="50" cy="46" rx="7.5" ry={ry} fill="#fff" />
      <circle cx={31 + look.x} cy={47 + look.y} r="4.3" fill={ink} />
      <circle cx={51 + look.x} cy={47 + look.y} r="4.3" fill={ink} />
      <circle cx={29.4 + look.x} cy={45 + look.y} r="1.6" fill="#fff" />
      <circle cx={49.4 + look.x} cy={45 + look.y} r="1.6" fill="#fff" />
      {mood === 'alert' && (
        <g stroke={ink} strokeWidth="2.2" strokeLinecap="round">
          <path d="M23 35 L35 32" />
          <path d="M57 35 L45 32" />
        </g>
      )}
    </g>
  )
}

function Mouth({ mood }: { mood: Mood }) {
  const ink = 'var(--roo-ink)'
  if (mood === 'sleeping') return <path d="M37 61 Q40 63 43 61" stroke={ink} strokeWidth="2" fill="none" strokeLinecap="round" />
  if (mood === 'alert') return <ellipse cx="40" cy="62" rx="3.2" ry="3.8" fill={ink} />
  if (mood === 'happy' || mood === 'celebrate' || mood === 'wave') {
    return (
      <g>
        <path d="M31 58 Q40 70 49 58 Z" fill={ink} />
        <path d="M35 63 Q40 67 45 63 Q40 61 35 63 Z" fill="var(--roo-blush)" />
      </g>
    )
  }
  return <path d="M33 59 Q40 65 47 59" stroke={ink} strokeWidth="2.4" fill="none" strokeLinecap="round" />
}

function RooArt({ mood, look, size, reduce }: { mood: Mood; look: { x: number; y: number }; size: number; reduce: boolean }) {
  const waving = mood === 'wave' || mood === 'celebrate'
  return (
    <svg viewBox="0 0 80 88" width={size} height={size * 1.1} aria-hidden="true" overflow="visible">
      <style>{BLINK_CSS}</style>
      <ellipse cx="40" cy="84" rx="20" ry="3.5" fill="#000" opacity="0.18" />
      <ellipse cx="29" cy="77" rx="7.5" ry="5" fill="var(--roo-deep)" />
      <ellipse cx="51" cy="77" rx="7.5" ry="5" fill="var(--roo-deep)" />
      <ellipse cx="13" cy="56" rx="5" ry="8.5" fill="var(--roo-deep)" transform="rotate(22 13 56)" />
      <motion.g
        style={{ originX: 0.5, originY: 0.1 }}
        animate={waving && !reduce ? { rotate: [0, -40, -10, -40, 0] } : { rotate: 0 }}
        transition={{ duration: 1.2, ease: 'easeInOut' }}
      >
        <ellipse cx="67" cy="56" rx="5" ry="8.5" fill="var(--roo-deep)" transform="rotate(-22 67 56)" />
      </motion.g>
      <motion.g
        style={{ originX: 0.5, originY: 1 }}
        animate={reduce || mood === 'sleeping' || mood === 'idle' ? { rotate: 0 } : { rotate: [0, -7, 7, 0] }}
        transition={{ duration: 1.4, ease: 'easeInOut' }}
      >
        <path d="M40 28 C39 21 40 16 41 12" stroke="var(--roo-deep)" strokeWidth="2.6" fill="none" strokeLinecap="round" />
        <path d="M41 14 C46 6 55 6 57 10 C53 15 46 16 41 14 Z" fill="var(--roo-leaf)" />
        <path d="M40 16 C35 10 27 10 25 13 C29 18 36 18 40 16 Z" fill="var(--roo-leaf)" />
      </motion.g>
      <ellipse cx="40" cy="52" rx="29" ry="27" fill="var(--roo-body)" />
      <ellipse cx="40" cy="63" rx="17" ry="11.5" fill="#fff" opacity="0.15" />
      <ellipse cx="28" cy="36" rx="9" ry="5.5" fill="#fff" opacity="0.25" transform="rotate(-28 28 36)" />
      <Eyes mood={mood} look={look} />
      <Mouth mood={mood} />
      <ellipse cx="19" cy="57" rx="4.6" ry="2.9" fill="var(--roo-blush)" opacity="0.6" />
      <ellipse cx="61" cy="57" rx="4.6" ry="2.9" fill="var(--roo-blush)" opacity="0.6" />
    </svg>
  )
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
              className={`min-h-12 rounded-full px-4 t-small font-bold transition-colors duration-[var(--dur-quick)] ${
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
        aria-label="Close Roo’s message"
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
  const hidden = !shownPref
  const [greeted, setGreeted] = useState(() => stored(GREETED_KEY))
  const [override, setOverride] = useState<RooMessage | null>(null)
  const [open, setOpen] = useState(false)
  const dismissed = useRef(new Set<string>())
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // Hello waits for Today: on the start form it would sit over "Plan my day", the one button that matters.
  const greeting: RooMessage | null =
    greeted || pathname !== '/' ? null : { id: 'greet', text: 'Hi, I’m Roo! I’ll keep an eye on your day and nudge you when it’s time. Tap me anytime.', mood: 'wave' }
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

  // Eyes follow the pointer on devices that have one.
  const artRef = useRef<HTMLButtonElement>(null)
  const [look, setLook] = useState({ x: 0, y: 0 })
  useEffect(() => {
    if (reduce || hidden || !window.matchMedia('(pointer: fine)').matches) return
    let frame = 0
    const onMove = (e: PointerEvent) => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const r = artRef.current?.getBoundingClientRect()
        if (!r) return
        const dx = e.clientX - (r.left + r.width / 2)
        const dy = e.clientY - (r.top + r.height * 0.45)
        const d = Math.hypot(dx, dy) || 1
        const k = Math.min(1, d / 240) * 2.6
        const next = { x: Math.round((dx / d) * k * 4) / 4, y: Math.round((dy / d) * k * 4) / 4 }
        setLook((l) => (l.x === next.x && l.y === next.y ? l : next))
      })
    }
    window.addEventListener('pointermove', onMove, { passive: true })
    return () => {
      window.removeEventListener('pointermove', onMove)
      cancelAnimationFrame(frame)
    }
  }, [reduce, hidden])

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
    else if (id === 'today') navigate('/')
    else if (id === 'add') navigate('/', { state: { add: Date.now() } })
    else if (id === 'book-train' && msg?.ref) navigate('/', { state: { bookTrain: msg.ref } })
    else if (id === 'edit' && view?.checkInTask) navigate('/', { state: { stop: view.checkInTask.taskId } })
    else if (id === 'hide') {
      setState({ roo: false })
      showToast({ title: 'Roo is hidden. Bring it back in Me.' })
    }
  }

  // A menu opened by a tap takes keyboard focus; a message Roo raises by itself never does.
  const tapped = useRef(false)
  const tap = () => {
    // A tap closes the menu, but over a message it opens the menu (the message can wait).
    if (open && msg?.id === 'menu') return close()
    if (open && msg && !override) dismissed.current.add(msg.id)
    const menu = menuFor(trip, view, pathname, clock, ai)
    lastShown.current = menu.id
    tapped.current = true
    setOverride(menu)
    setOpen(true)
    schedule(menu)
  }
  const anchor = useRooAnchor()
  // A message waits while a sheet is open: the sheet's buttons and Escape belong to it.
  const sheetOpen = useSheetOpen()

  if (hidden) return null

  const shown = open && msg && !sheetOpen ? msg : null
  const mood: Mood = shown?.mood ?? (derived?.mood === 'sleeping' ? 'sleeping' : derived?.urgent ? 'alert' : 'idle')
  const eyes = shown ? { x: -1.5, y: -2 } : look

  // On Today, Roo rides the timeline at the Now line; its words open in a popover above the page.
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
            {/* The button stays still (a steady target); only Roo inside it moves, and only when it has news. */}
            <button
              ref={artRef}
              type="button"
              onClick={tap}
              aria-label={open && msg?.id === 'menu' ? 'Roo, your travel companion. Close the menu' : 'Roo, your travel companion. Add a task or change this stop'}
              aria-expanded={open && msg?.id === 'menu'}
              className="flex size-12 cursor-pointer items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--focus)]"
            >
              <motion.span
                className="block drop-shadow-md"
                animate={reduce ? {} : mood === 'celebrate' ? { y: [0, -14, 0], transition: { duration: 0.8 } } : mood === 'alert' ? { y: [0, -6, 0], transition: { duration: 0.5 } } : { y: 0 }}
              >
                <RooArt mood={mood} look={eyes} size={46} reduce={reduce} />
              </motion.span>
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
              onOpenAutoFocus={(e) => {
                if (!tapped.current) e.preventDefault()
                tapped.current = false
              }}
              onInteractOutside={(e) => {
                if (artRef.current?.contains(e.target as Node)) e.preventDefault()
              }}
              // A message Roo raises is announced as a status; only the menu a tap opens is a dialog.
              role={shown.id === 'menu' ? 'dialog' : 'status'}
              aria-label={shown.id === 'menu' ? 'Roo' : undefined}
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
