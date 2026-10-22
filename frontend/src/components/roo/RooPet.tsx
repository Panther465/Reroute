import { motion, useReducedMotion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { EASE_OUT } from '@/lib/motion'
import { RooArt, type Mood } from './RooArt'

/**
 * Roo as a pet, big, for the welcome screen. It springs in and waves; breathes; hops (a squash and
 * stretch) each time it says something; looks at your pointer, or glances about when you're still; and
 * giggles, with a few hearts, when you poke it. Springs and transforms only; reduced motion keeps it still.
 */
export function RooPet({ mood, hop, size = 150 }: { mood: Mood; hop: number; size?: number }) {
  const reduce = !!useReducedMotion()
  const ref = useRef<HTMLButtonElement>(null)
  const [look, setLook] = useState({ x: 0, y: 0 })
  const [poked, setPoked] = useState(0)
  const [giggle, setGiggle] = useState(false)
  const lastMove = useRef(0)

  // Eyes on the pointer (or the last touch); when nothing moves for a while, a glance about.
  useEffect(() => {
    if (reduce) return
    let frame = 0
    const onMove = (e: PointerEvent) => {
      lastMove.current = Date.now()
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const r = ref.current?.getBoundingClientRect()
        if (!r) return
        const dx = e.clientX - (r.left + r.width / 2)
        const dy = e.clientY - (r.top + r.height * 0.45)
        const d = Math.hypot(dx, dy) || 1
        const k = Math.min(1, d / 260) * 2.8
        setLook({ x: Math.round((dx / d) * k * 4) / 4, y: Math.round((dy / d) * k * 4) / 4 })
      })
    }
    window.addEventListener('pointermove', onMove, { passive: true })
    window.addEventListener('pointerdown', onMove, { passive: true })
    let back: ReturnType<typeof setTimeout> | undefined
    const glance = setInterval(() => {
      if (document.hidden || Date.now() - lastMove.current < 3500) return
      setLook({ x: Math.random() < 0.5 ? -2.5 : 2.5, y: Math.random() < 0.5 ? -1 : 0.5 })
      back = setTimeout(() => setLook({ x: 0, y: 0 }), 1200)
    }, 5000)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerdown', onMove)
      cancelAnimationFrame(frame)
      clearInterval(glance)
      clearTimeout(back)
    }
  }, [reduce])

  const poke = () => {
    setPoked((n) => n + 1)
    setGiggle(true)
    setTimeout(() => setGiggle(false), 1100)
  }

  const face: Mood = giggle ? 'celebrate' : mood
  return (
    <div className="relative flex flex-col items-center">
      {/* Hearts float up from a poke. */}
      {!reduce &&
        poked > 0 &&
        [0, 1, 2].map((i) => (
          <motion.svg
            key={`${poked}-${i}`}
            aria-hidden="true"
            viewBox="0 0 24 24"
            width={18}
            height={18}
            className="pointer-events-none absolute top-6 text-red"
            style={{ left: `calc(50% + ${(i - 1) * 34}px)` }}
            initial={{ opacity: 0, transform: 'translateY(0px) scale(0.6)' }}
            animate={{ opacity: [0, 1, 0], transform: ['translateY(0px) scale(0.6)', `translateY(-${48 + i * 14}px) scale(1)`, `translateY(-${80 + i * 18}px) scale(0.9)`] }}
            transition={{ duration: 1.1, delay: i * 0.08, ease: EASE_OUT }}
          >
            <path fill="currentColor" d="M12 21s-7.5-4.6-9.6-9.3C.9 8.2 3.1 4.5 6.8 4.5c2.1 0 3.6 1.1 4.6 2.6 1-1.5 2.6-2.6 4.6-2.6 3.7 0 5.9 3.7 4.4 7.2C19.5 16.4 12 21 12 21z" />
          </motion.svg>
        ))}
      <motion.div
        initial={reduce ? { opacity: 0 } : { opacity: 0, transform: 'translateY(40px) scale(0.9)' }}
        animate={{ opacity: 1, transform: 'translateY(0px) scale(1)' }}
        transition={reduce ? { duration: 0.2 } : { type: 'spring', duration: 0.7, bounce: 0.35 }}
      >
        <button
          ref={ref}
          type="button"
          onClick={poke}
          aria-label="Roo. Poke it"
          className="block rounded-full focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--focus)]"
        >
          <span className="rr-roo-breathe block">
            {/* A hop each time Roo speaks, and a bigger one when poked: up, stretch; down, squash; settle. */}
            <motion.span
              key={`${hop}-${poked}`}
              className="block origin-bottom drop-shadow-lg"
              initial={false}
              animate={
                reduce || (hop === 0 && poked === 0)
                  ? {}
                  : {
                      transform: giggle
                        ? ['translateY(0px) scale(1, 1)', 'translateY(-26px) scale(0.94, 1.08)', 'translateY(0px) scale(1.1, 0.9)', 'translateY(0px) scale(1, 1)']
                        : ['translateY(0px) scale(1, 1)', 'translateY(-12px) scale(0.97, 1.04)', 'translateY(0px) scale(1.05, 0.95)', 'translateY(0px) scale(1, 1)'],
                    }
              }
              transition={{ duration: giggle ? 0.7 : 0.5, times: [0, 0.35, 0.7, 1], ease: EASE_OUT }}
            >
              <RooArt mood={face} look={look} size={size} reduce={reduce} />
            </motion.span>
          </span>
        </button>
      </motion.div>
    </div>
  )
}
