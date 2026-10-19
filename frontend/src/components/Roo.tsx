import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router'
import type { Trip } from '@/api/types'
import { useIsDesktop } from '@/lib/hooks'
import { localMinutes } from '@/lib/timeline'

type Mood = 'idle' | 'happy' | 'alert' | 'thinking' | 'sleeping'

interface RooMessage {
  id: string
  text: string
  mood: Mood
  priority: number
}

// ---------------------------------------------------------------------------
// Context engine: pick the right message for the current state
// ---------------------------------------------------------------------------

function deriveMessage(trip: Trip | undefined, clock: number | null, path: string): RooMessage | null {
  if (!trip) {
    if (path === '/plan') return { id: 'plan-new', text: "Let's set up your trip!", mood: 'idle', priority: 1 }
    return { id: 'no-trip', text: 'Ready to plan your day?', mood: 'idle', priority: 0 }
  }

  const todayTasks = trip.tasks.filter((t) => t.day === trip.day)
  const openTasks = todayTasks.filter((t) => t.state !== 'done' && t.state !== 'skipped')
  const plan = trip.activePlan

  if (path === '/plan') {
    if (trip.tasks.length === 0) return { id: 'plan-empty', text: 'Describe your day and I’ll work out the route!', mood: 'idle', priority: 1 }
    if (!plan) return { id: 'plan-ready', text: `${openTasks.length} task${openTasks.length === 1 ? '' : 's'} ready. Tap Plan my day!`, mood: 'happy', priority: 1 }
    return null
  }

  if (path === '/summary') return { id: 'summary', text: 'Here’s how your day went.', mood: 'happy', priority: 1 }
  if (path === '/me') return null
  if (path.startsWith('/raasta')) return null

  if (!plan || clock == null) {
    if (openTasks.length > 0) return { id: 'need-plan', text: 'Head to Plan to get your route!', mood: 'idle', priority: 1 }
    return null
  }

  if (trip.openOptions) {
    return { id: 'options', text: 'You have options to review!', mood: 'alert', priority: 5 }
  }

  if (openTasks.length === 0) {
    return { id: 'all-done', text: 'All done! Great day.', mood: 'happy', priority: 3 }
  }

  for (const leg of plan.legs) {
    const task = trip.tasks.find((t) => t.taskId === leg.taskId)
    if (!task || task.state === 'done' || task.state === 'skipped') continue
    const start = localMinutes(leg.taskStart, trip.day, trip.utcOffset)
    const end = start + task.durationMin
    const leave = localMinutes(leg.leaveBy, trip.day, trip.utcOffset)

    if (clock > end) {
      return { id: `done-${task.taskId}`, text: `Done with ${task.title.toLowerCase()}?`, mood: 'alert', priority: 4 }
    }
    if (clock >= start) {
      return { id: `at-${task.taskId}`, text: `At the ${task.title.toLowerCase()}. Take your time!`, mood: 'happy', priority: 1 }
    }
    if (clock >= leave - 10 && clock < leave) {
      const mins = Math.max(1, Math.round(leave - clock))
      return { id: `leave-${task.taskId}`, text: `Leave in ${mins} min for ${task.title.toLowerCase()}!`, mood: 'alert', priority: 3 }
    }
    if (clock < leave) {
      const mins = Math.round(leave - clock)
      if (mins <= 30) return { id: `next-${task.taskId}`, text: `Next: ${task.title.toLowerCase()} — leave in ${mins} min.`, mood: 'idle', priority: 1 }
      break
    }
  }

  return { id: 'on-track', text: 'Your day is on track.', mood: 'idle', priority: 0 }
}

// ---------------------------------------------------------------------------
// SVG character
// ---------------------------------------------------------------------------

const BLINK_CSS = `
@keyframes roo-blink {
  0%, 92%, 100% { transform: scaleY(1); }
  95% { transform: scaleY(0.1); }
}
`

function RooFace({ mood, size = 56 }: { mood: Mood; size?: number }) {
  const h = size * (72 / 64)
  const eyes = mood === 'sleeping'
    ? (
      <>
        <path d="M17 36 Q22 33 27 36" stroke="var(--ink)" strokeWidth="2.5" fill="none" strokeLinecap="round" />
        <path d="M37 36 Q42 33 47 36" stroke="var(--ink)" strokeWidth="2.5" fill="none" strokeLinecap="round" />
      </>
    )
    : mood === 'happy'
    ? (
      <>
        <path d="M17 37 Q22 33 27 37" stroke="var(--ink)" strokeWidth="2.5" fill="none" strokeLinecap="round" />
        <path d="M37 37 Q42 33 47 37" stroke="var(--ink)" strokeWidth="2.5" fill="none" strokeLinecap="round" />
      </>
    )
    : (
      <g style={{ animation: 'roo-blink 4s ease-in-out infinite', transformOrigin: '32px 36px' }}>
        <circle cx="22" cy="36" r={mood === 'alert' ? 8 : 7} fill="white" />
        <circle cx="42" cy="36" r={mood === 'alert' ? 8 : 7} fill="white" />
        <circle cx={mood === 'thinking' ? 25 : 24} cy={mood === 'thinking' ? 34 : 37} r="3.5" fill="var(--ink)" />
        <circle cx={mood === 'thinking' ? 45 : 44} cy={mood === 'thinking' ? 34 : 37} r="3.5" fill="var(--ink)" />
        <circle cx="20" cy="34" r="2" fill="white" opacity="0.8" />
        <circle cx="40" cy="34" r="2" fill="white" opacity="0.8" />
      </g>
    )

  const mouth = mood === 'sleeping'
    ? null
    : mood === 'happy'
    ? <path d="M24 44 Q32 52 40 44" stroke="white" strokeWidth="2" fill="none" strokeLinecap="round" />
    : mood === 'alert'
    ? <ellipse cx="32" cy="46" rx="3" ry="4" fill="white" opacity="0.9" />
    : <path d="M26 46 Q32 50 38 46" stroke="white" strokeWidth="2" fill="none" strokeLinecap="round" />

  return (
    <svg viewBox="0 0 64 72" width={size} height={h} aria-hidden="true" role="presentation">
      <style>{BLINK_CSS}</style>
      <ellipse cx="32" cy="67" rx="14" ry="3" fill="currentColor" opacity="0.07" />
      <circle cx="32" cy="38" r="24" fill="var(--green)" />
      <circle cx="24" cy="28" r="10" fill="white" opacity="0.1" />
      <path d="M32 14 C30 8 28 4 32 2 C36 4 34 8 32 14" fill="var(--green-ink)" />
      <ellipse cx="36" cy="5" rx="5" ry="3" fill="var(--green)" transform="rotate(-25 36 5)" />
      <ellipse cx="28" cy="6" rx="4" ry="2.5" fill="var(--green)" transform="rotate(20 28 6)" />
      {eyes}
      {mouth}
      <circle cx="13" cy="42" r="4" fill="#ff9eb1" opacity="0.3" />
      <circle cx="51" cy="42" r="4" fill="#ff9eb1" opacity="0.3" />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Speech bubble
// ---------------------------------------------------------------------------

function Bubble({ text, onDismiss }: { text: string; onDismiss: () => void }) {
  const reduce = useReducedMotion()
  return (
    <motion.button
      type="button"
      onClick={onDismiss}
      className="absolute bottom-full right-0 mb-2 max-w-[220px] rounded-card bg-surface px-4 py-3 text-left shadow-[var(--shadow-toast)] lg:max-w-[260px]"
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, y: 4, scale: 0.97 }}
      transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
      aria-label={`Roo says: ${text}. Tap to dismiss.`}
    >
      <p className="t-body text-ink leading-snug">{text}</p>
      <span
        className="absolute -bottom-[6px] right-5 size-3 rotate-45 bg-surface"
        aria-hidden="true"
      />
    </motion.button>
  )
}

// ---------------------------------------------------------------------------
// Sleeping z-z-z
// ---------------------------------------------------------------------------

function Zzz() {
  return (
    <span className="absolute -top-3 right-0 select-none text-muted" aria-hidden="true">
      <motion.span
        className="absolute -top-4 right-1 text-[10px] font-bold opacity-0"
        animate={{ y: [0, -12], opacity: [0, 0.7, 0], rotate: [0, -15] }}
        transition={{ duration: 2, repeat: Infinity, repeatDelay: 1, ease: 'easeOut' }}
      >
        z
      </motion.span>
      <motion.span
        className="absolute -top-2 right-4 text-xs font-bold opacity-0"
        animate={{ y: [0, -14], opacity: [0, 0.6, 0], rotate: [0, 10] }}
        transition={{ duration: 2.2, repeat: Infinity, repeatDelay: 0.8, delay: 0.5, ease: 'easeOut' }}
      >
        z
      </motion.span>
    </span>
  )
}

// ---------------------------------------------------------------------------
// Main Roo component
// ---------------------------------------------------------------------------

export function Roo({ trip, clock }: { trip: Trip | undefined; clock: number | null }) {
  const { pathname } = useLocation()
  const desktop = useIsDesktop()
  const reduce = useReducedMotion()
  const [bubbleVisible, setBubbleVisible] = useState(false)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const lastMsgRef = useRef<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const msg = useMemo(() => deriveMessage(trip, clock, pathname), [trip, clock, pathname])

  const showBubble = useCallback((auto: boolean) => {
    setBubbleVisible(true)
    clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setBubbleVisible(false), auto ? 8000 : 6000)
  }, [])

  const dismissBubble = useCallback(() => {
    setBubbleVisible(false)
    clearTimeout(timerRef.current)
    if (msg) setDismissed(msg.id)
  }, [msg])

  useEffect(() => {
    if (!msg || msg.id === dismissed) return
    if (msg.id !== lastMsgRef.current) {
      lastMsgRef.current = msg.id
      if (msg.priority >= 3) {
        showBubble(true)
      } else {
        const delay = setTimeout(() => showBubble(true), 2000)
        return () => clearTimeout(delay)
      }
    }
  }, [msg, dismissed, showBubble])

  useEffect(() => () => clearTimeout(timerRef.current), [])

  const handleTap = () => {
    if (bubbleVisible) {
      dismissBubble()
    } else if (msg && msg.id !== dismissed) {
      showBubble(false)
    }
  }

  const mood: Mood = msg?.mood ?? 'idle'
  const rooSize = desktop ? 60 : 52

  const idleMotion = mood === 'sleeping'
    ? {}
    : mood === 'alert'
    ? reduce ? {} : { y: [0, -2, 2, -2, 0], transition: { duration: 0.35, ease: 'easeInOut' as const } }
    : mood === 'happy'
    ? reduce ? {} : { y: [0, -6, 0], transition: { duration: 0.5, ease: [0.16, 1, 0.3, 1] as const } }
    : reduce ? {} : { y: [0, -3, 0], transition: { duration: 2.5, repeat: Infinity, ease: 'easeInOut' as const } }

  return (
    <div
      className={[
        'fixed z-30',
        desktop
          ? 'bottom-6 right-6'
          : 'bottom-[calc(80px+env(safe-area-inset-bottom))] right-4',
      ].join(' ')}
    >
      <div className="relative">
        <AnimatePresence>
          {bubbleVisible && msg && (
            <Bubble key={msg.id} text={msg.text} onDismiss={dismissBubble} />
          )}
        </AnimatePresence>
        {mood === 'sleeping' && <Zzz />}
        <motion.button
          type="button"
          onClick={handleTap}
          aria-label="Roo, your travel companion"
          className="block cursor-pointer rounded-full focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--focus)]"
          animate={idleMotion}
          whileHover={reduce ? {} : { scale: 1.08 }}
          whileTap={reduce ? {} : { scale: 0.92 }}
          transition={{ duration: 0.15 }}
        >
          <RooFace mood={mood} size={rooSize} />
        </motion.button>
      </div>
    </div>
  )
}
