import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useEffect, useState } from 'react'
import { EASE_FALL, EASE_OUT } from '@/lib/motion'

// Station positions in a 300 x 120 diagram. Times sit under each station, names under the times.
const H = 20
const M = 105
const B = 195
const O = 280
const Y = 46

const STATIONS = [
  { x: H, name: 'Hotel', before: '08:50', after: '08:50' },
  { x: M, name: 'Meeting', before: '10:00', after: '10:00' },
  { x: B, name: 'Bank', before: '12:25', after: '12:35' },
  { x: O, name: 'Office', before: '15:40', after: '15:50' },
]

export function FlipTime({ value, changed, index, reduce }: { value: string; changed: boolean; index: number; reduce: boolean }) {
  return (
    <span className="relative inline-block rounded-[5px] px-1" style={{ perspective: 200 }}>
      {changed && (
        <motion.span
          aria-hidden="true"
          className="absolute inset-0 rounded-[5px] bg-yellow"
          initial={{ opacity: 1 }}
          animate={{ opacity: 0 }}
          transition={reduce ? { delay: 2, duration: 0 } : { delay: 0.3 + index * 0.06, duration: 1.1, ease: EASE_OUT }}
        />
      )}
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={value}
          className="relative inline-block tnum"
          style={{ backfaceVisibility: 'hidden' }}
          initial={reduce ? false : { rotateX: -90 }}
          animate={{ rotateX: 0, transition: { duration: 0.09, ease: EASE_OUT } }}
          exit={reduce ? undefined : { rotateX: 90, transition: { delay: index * 0.06, duration: 0.09, ease: EASE_FALL } }}
        >
          {value}
        </motion.span>
      </AnimatePresence>
    </span>
  )
}

/**
 * "The day that reroutes itself": the sign-in screen's one-shot preview of the signature choreography.
 * The sample day draws as a line, the leg to the bank fades and turns dashed, a cab route draws in its
 * place and the changed times flip. About 2 seconds, once. Reduced motion shows the final state.
 * Sign in loads it after first paint inside a figure that holds its caption, so it doesn't hold up the page.
 */
export function RerouteHero() {
  const reduce = !!useReducedMotion()
  const [flipped, setFlipped] = useState(reduce)
  useEffect(() => {
    if (reduce) return
    const id = setTimeout(() => setFlipped(true), 1300)
    return () => clearTimeout(id)
  }, [reduce])

  const draw = (delay: number, duration: number) => (reduce ? { initial: false as const } : { initial: { pathLength: 0 }, animate: { pathLength: 1 }, transition: { delay, duration, ease: EASE_OUT } })
  const fadeOld = reduce ? { initial: false as const, animate: { opacity: 0 } } : { initial: { opacity: 1 }, animate: { opacity: 0 }, transition: { delay: 0.86, duration: 0.2 } }
  const dashIn = reduce ? { initial: false as const, animate: { opacity: 0.3 } } : { initial: { opacity: 0 }, animate: { opacity: 0.3 }, transition: { delay: 0.86, duration: 0.2 } }

  return (
    <div className="relative aspect-[5/2] w-full" aria-hidden="true">
      <svg viewBox="0 0 300 120" className="absolute inset-0 size-full overflow-visible" fill="none" strokeLinecap="round">
        {/* Hotel to meeting: metro, then shared auto */}
        <motion.path d={`M${H} ${Y}H${M - 25}`} stroke="var(--blue)" strokeWidth="6" {...draw(0, 0.22)} />
        <motion.path d={`M${M - 25} ${Y}H${M}`} stroke="var(--green)" strokeWidth="6" {...draw(0.2, 0.1)} />
        {/* Meeting to bank: the leg that changes */}
        <motion.g {...fadeOld}>
          <motion.path d={`M${M} ${Y}H${B - 28}`} stroke="var(--blue)" strokeWidth="6" {...draw(0.28, 0.22)} />
          <motion.path d={`M${B - 28} ${Y}H${B}`} stroke="var(--green)" strokeWidth="6" {...draw(0.48, 0.1)} />
        </motion.g>
        <motion.path d={`M${M} ${Y}H${B}`} stroke="var(--ink)" strokeWidth="6" strokeDasharray="5 7" {...dashIn} />
        {/* Bank to office: verified shared auto */}
        <motion.path d={`M${B} ${Y}H${O}`} stroke="var(--green)" strokeWidth="6" {...draw(0.56, 0.24)} />
        {/* The reroute: a cab arcs over the old leg */}
        <motion.path d={`M${M} ${Y}C${M + 22} ${Y - 46} ${B - 22} ${Y - 46} ${B} ${Y}`} stroke="var(--ink)" strokeWidth="6" {...draw(1.0, 0.6)} />
        {STATIONS.map((s, i) => (
          <motion.circle
            key={s.name}
            cx={s.x}
            cy={Y}
            r="7"
            fill={i === 1 ? 'var(--yellow)' : 'var(--surface)'}
            stroke="var(--ink)"
            strokeWidth="3"
            style={{ transformOrigin: `${s.x}px ${Y}px` }}
            initial={reduce ? false : { scale: 0.6, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ delay: 0.05 + i * 0.14, duration: 0.24, ease: EASE_OUT }}
          />
        ))}
      </svg>
      {STATIONS.map((s, i) => (
        <div key={s.name} className="absolute flex -translate-x-1/2 flex-col items-center text-center" style={{ left: `${(s.x / 300) * 100}%`, top: `${((Y + 14) / 120) * 100}%` }}>
          <span className="t-caption text-ink">
            <FlipTime value={flipped ? s.after : s.before} changed={flipped && s.after !== s.before} index={i - 2} reduce={reduce} />
          </span>
          <span className="t-small text-ink-2">{s.name}</span>
        </div>
      ))}
      <motion.span
        className="absolute rounded-tag bg-ink px-2 py-0.5 t-caption text-on-ink"
        style={{ left: `${((M + B) / 2 / 300) * 100}%`, top: '-4%', x: '-50%' }}
        initial={reduce ? false : { opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 1.35, duration: 0.24, ease: EASE_OUT }}
      >
        Cab, +₹350
      </motion.span>
    </div>
  )
}
