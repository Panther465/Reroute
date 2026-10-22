import { Ban, ChevronRight, Clock, Route, TriangleAlert, WifiOff } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { EASE_OUT } from '@/lib/motion'
import { useDelayed, type Status } from '@/lib/hooks'
import { useT } from '@/lib/i18n'
import { useStore } from '@/lib/store'

const look: Record<Status['kind'], { cls: string; Icon: typeof Clock }> = {
  on_time: { cls: 'bg-green-tint text-green-ink', Icon: Clock },
  behind: { cls: 'bg-red-tint text-red-ink', Icon: TriangleAlert },
  rerouted: { cls: 'bg-green-tint text-green-ink', Icon: Route },
  offline: { cls: 'bg-sunken text-ink', Icon: WifiOff },
  blocked: { cls: 'bg-red-tint text-red-ink', Icon: Ban },
}

/** Status pill: 32 px visual inside a 48 px target. Opens the Reroute log. */
export function StatusPill({ live, onOpen }: { live: Status; onOpen: () => void }) {
  const change = useStore((s) => s.change)
  const lang = useStore((s) => s.lang)
  // During the reroute choreography the pill changes at 1000 ms.
  const status = useDelayed(live, change?.kind === 'reroute' && live.kind === 'rerouted' ? change.pillDelayMs : 0, `${live.kind}${live.text}${change?.token}`)
  const t = useT()
  const { cls, Icon } = look[status.kind]
  const text = t(status.text)
  return (
    <button type="button" onClick={onOpen} className="group -my-2 flex min-h-12 items-center rounded-full" aria-label={`${text}. Open the Reroute log`}>
      <motion.span layout transition={{ layout: { duration: 0.24, ease: EASE_OUT } }} className={`inline-flex h-8 items-center gap-1.5 overflow-hidden rounded-full px-3 t-caption ${cls}`} style={{ borderRadius: 999 }}>
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={status.kind + status.text}
            className="inline-flex items-center gap-1.5 whitespace-nowrap"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: { duration: 0.16 } }}
            exit={{ opacity: 0, transition: { duration: 0.12 } }}
            lang={lang === 'hi' && text !== status.text ? 'hi' : undefined}
          >
            <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
            {text}
            <ChevronRight size={14} strokeWidth={2} aria-hidden="true" className="-mr-1 opacity-70" />
          </motion.span>
        </AnimatePresence>
      </motion.span>
      {/* After a change, say plainly that the reason is one tap away. */}
      {status.kind === 'rerouted' && (
        <span aria-hidden="true" className="ml-2 t-small font-bold text-ink underline decoration-2 underline-offset-4 [@media(hover:hover)]:group-hover:decoration-green">
          See why
        </span>
      )}
    </button>
  )
}
