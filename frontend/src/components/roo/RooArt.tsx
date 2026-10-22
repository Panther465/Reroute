import { motion } from 'motion/react'
import { EASE_IN_OUT } from '@/lib/motion'

export type Mood = 'idle' | 'happy' | 'alert' | 'sleeping' | 'celebrate' | 'wave' | 'thinking' | 'listening' | 'talking'

// Roo blinks, and while it talks its mouth moves. Both are CSS animations of transform (off the main
// thread), and both stop with reduced motion (index.css).
const ART_CSS = `
@keyframes roo-blink { 0%, 93%, 100% { transform: scaleY(1) } 96% { transform: scaleY(0.1) } }
@keyframes roo-talk { 0%, 100% { transform: scaleY(0.35) } 50% { transform: scaleY(1) } }
.roo-eyes { animation: roo-blink 4.5s ease-in-out infinite; transform-origin: 40px 46px }
.roo-mouth-talk { animation: roo-talk 260ms ease-in-out infinite; transform-origin: 40px 60px; transform-box: view-box }
@media (prefers-reduced-motion: reduce) { .roo-eyes, .roo-mouth-talk { animation: none } }
`

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
  // Thinking looks up and away; listening looks straight at you, eyes wide.
  const at = mood === 'thinking' ? { x: -2.2, y: -3 } : mood === 'listening' ? { x: 0, y: 0 } : look
  const ry = mood === 'alert' || mood === 'listening' ? 9.5 : 8.5
  return (
    <g className="roo-eyes">
      <ellipse cx="30" cy="46" rx="7.5" ry={ry} fill="#fff" />
      <ellipse cx="50" cy="46" rx="7.5" ry={ry} fill="#fff" />
      <circle cx={31 + at.x} cy={47 + at.y} r={mood === 'listening' ? 4.8 : 4.3} fill={ink} />
      <circle cx={51 + at.x} cy={47 + at.y} r={mood === 'listening' ? 4.8 : 4.3} fill={ink} />
      <circle cx={29.4 + at.x} cy={45 + at.y} r="1.6" fill="#fff" />
      <circle cx={49.4 + at.x} cy={45 + at.y} r="1.6" fill="#fff" />
      {mood === 'alert' && (
        <g stroke={ink} strokeWidth="2.2" strokeLinecap="round">
          <path d="M23 35 L35 32" />
          <path d="M57 35 L45 32" />
        </g>
      )}
      {mood === 'thinking' && (
        <g stroke={ink} strokeWidth="2.2" strokeLinecap="round">
          <path d="M23 34 L35 35" />
          <path d="M45 33 L57 31" />
        </g>
      )}
    </g>
  )
}

function Mouth({ mood }: { mood: Mood }) {
  const ink = 'var(--roo-ink)'
  if (mood === 'sleeping') return <path d="M37 61 Q40 63 43 61" stroke={ink} strokeWidth="2" fill="none" strokeLinecap="round" />
  if (mood === 'alert') return <ellipse cx="40" cy="62" rx="3.2" ry="3.8" fill={ink} />
  if (mood === 'thinking') return <path d="M35 62 Q40 60 45 62" stroke={ink} strokeWidth="2.4" fill="none" strokeLinecap="round" />
  if (mood === 'talking') {
    return (
      <g className="roo-mouth-talk">
        <ellipse cx="40" cy="61" rx="6" ry="5" fill={ink} />
        <ellipse cx="40" cy="63.5" rx="3.5" ry="1.6" fill="var(--roo-blush)" />
      </g>
    )
  }
  if (mood === 'happy' || mood === 'celebrate' || mood === 'wave' || mood === 'listening') {
    return (
      <g>
        <path d="M31 58 Q40 70 49 58 Z" fill={ink} />
        <path d="M35 63 Q40 67 45 63 Q40 61 35 63 Z" fill="var(--roo-blush)" />
      </g>
    )
  }
  return <path d="M33 59 Q40 65 47 59" stroke={ink} strokeWidth="2.4" fill="none" strokeLinecap="round" />
}

/** Roo: a round green sprout with a leaf on top. Its face follows its mood; its eyes can follow the pointer. */
export function RooArt({ mood, look = { x: 0, y: 0 }, size, reduce }: { mood: Mood; look?: { x: number; y: number }; size: number; reduce: boolean }) {
  const waving = mood === 'wave' || mood === 'celebrate'
  const perky = mood === 'listening' || mood === 'alert'
  return (
    <svg viewBox="0 0 80 88" width={size} height={size * 1.1} aria-hidden="true" overflow="visible">
      <style>{ART_CSS}</style>
      <ellipse cx="40" cy="84" rx="20" ry="3.5" fill="#000" opacity="0.18" />
      <ellipse cx="29" cy="77" rx="7.5" ry="5" fill="var(--roo-deep)" />
      <ellipse cx="51" cy="77" rx="7.5" ry="5" fill="var(--roo-deep)" />
      <motion.g style={{ originX: 0.5, originY: 0.1 }} animate={mood === 'thinking' && !reduce ? { rotate: 18 } : { rotate: 0 }} transition={{ duration: 0.3, ease: EASE_IN_OUT }}>
        <ellipse cx="13" cy="56" rx="5" ry="8.5" fill="var(--roo-deep)" transform="rotate(22 13 56)" />
      </motion.g>
      <motion.g style={{ originX: 0.5, originY: 0.1 }} animate={waving && !reduce ? { rotate: [0, -40, -10, -40, 0] } : { rotate: 0 }} transition={{ duration: 1.2, ease: EASE_IN_OUT }}>
        <ellipse cx="67" cy="56" rx="5" ry="8.5" fill="var(--roo-deep)" transform="rotate(-22 67 56)" />
      </motion.g>
      {/* The leaf perks up when Roo listens or has news, and droops a little while it thinks. */}
      <motion.g
        style={{ originX: 0.5, originY: 1 }}
        animate={reduce || mood === 'sleeping' || mood === 'idle' ? { rotate: 0 } : perky ? { rotate: [0, -10, 6, 0] } : mood === 'thinking' ? { rotate: 12 } : { rotate: [0, -7, 7, 0] }}
        transition={{ duration: perky ? 0.6 : 1.4, ease: EASE_IN_OUT }}
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
      <ellipse cx="19" cy="57" rx="4.6" ry="2.9" fill="var(--roo-blush)" opacity={mood === 'happy' || mood === 'celebrate' ? 0.85 : 0.6} />
      <ellipse cx="61" cy="57" rx="4.6" ry="2.9" fill="var(--roo-blush)" opacity={mood === 'happy' || mood === 'celebrate' ? 0.85 : 0.6} />
    </svg>
  )
}
