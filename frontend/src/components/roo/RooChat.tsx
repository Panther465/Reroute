import * as Dialog from '@radix-ui/react-dialog'
import { Volume2, VolumeX, X } from 'lucide-react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useEffect, useMemo, useRef } from 'react'
import { useNavigate } from 'react-router'
import { useAiHelperEnabled, useDay, useMe, useWallet } from '@/api/queries'
import type { Trip } from '@/api/types'
import { useIsDesktop, useOnline } from '@/lib/hooks'
import { EASE_DRAWER, EASE_OUT } from '@/lib/motion'
import { greeting, suggestions, type RooContext } from '@/lib/roo/brain'
import { setState, useStore } from '@/lib/store'
import { dayLabel } from '@/lib/timeline'
import { ChatThread } from './ChatThread'
import { RooArt, type Mood } from './RooArt'
import { useConversation } from './useConversation'

const PANEL_DESKTOP = 'fixed right-4 top-20 bottom-4 z-50 flex w-[400px] flex-col overflow-hidden rounded-sheet border border-line bg-surface text-ink shadow-[var(--shadow-toast)] outline-none'
const PANEL_PHONE = 'fixed inset-x-0 bottom-0 z-50 mx-auto flex h-[88dvh] w-full max-w-[560px] flex-col overflow-hidden rounded-t-sheet bg-surface text-ink shadow-[var(--shadow-sheet)] outline-none'

/**
 * Talking with Roo. Roo answers from the day as it is (on the phone; the server's AI helper for what the
 * phone can't place, when that's on), asks questions to re-plan or start a new trip, and offers every
 * change as a card. On a desktop the chat sits beside the page, so the timeline re-routes in view.
 */
export function RooChat({ trip, clock }: { trip: Trip | undefined; clock: number | null }) {
  const open = useStore((s) => s.rooChat)
  const voice = useStore((s) => s.rooVoice)
  const desktop = useIsDesktop()
  const reduce = !!useReducedMotion()
  const navigate = useNavigate()
  const online = useOnline()
  const ai = useAiHelperEnabled()
  const me = useMe()
  const wallet = useWallet(open)
  const view = useDay(trip, clock)
  const leftFor = useStore((s) => (s.started && s.started.tripId === trip?.tripId ? s.started.toId : null))

  const ctx: RooContext = { trip, view, clock, leftFor, name: me.data?.name, walletInr: wallet.data?.balanceInr ?? null }
  const close = () => setState({ rooChat: false })
  const c = useConversation({
    storageKey: trip ? `reroute.roo.chat.v2:${trip.tripId}` : null,
    ctx,
    ai,
    online,
    voice,
    stepAside: () => {
      if (!desktop) close()
    },
    onShow: () => {
      close()
      navigate('/')
    },
  })
  const chips = useMemo(() => suggestions(ctx), [trip, view, clock]) // eslint-disable-line react-hooks/exhaustive-deps

  // Opening the chat: Roo says hello (again, after a long gap). Closing it turns the microphone off.
  // The effect can run twice as the panel mounts, before the first hello shows: one hello only.
  const greeted = useRef(0)
  useEffect(() => {
    if (!open) return c.stopListening()
    const last = c.msgs[c.msgs.length - 1]
    if (last && Date.now() - last.at < 2 * 60 * 60 * 1000) return
    if (Date.now() - greeted.current < 10_000) return
    greeted.current = Date.now()
    void c.say([greeting(ctx).reply], { mood: 'wave' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const face: Mood = c.listening ? 'listening' : c.talking ? 'talking' : c.thinking || c.busy ? 'thinking' : c.mood
  const status = c.listening ? 'Listening…' : c.thinking || c.busy ? 'Thinking…' : c.talking ? 'Talking…' : trip ? `Your plan: ${trip.cityName}, ${dayLabel(trip.day)}` : 'Your travel companion'

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
                }
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
                    <p className="truncate t-small text-muted" aria-live="polite">
                      {status}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setState({ rooVoice: !voice })}
                    aria-pressed={voice}
                    aria-label={voice ? 'Mute Roo' : 'Let Roo speak'}
                    className="flex size-12 shrink-0 items-center justify-center rounded-control text-ink-2 [@media(hover:hover)]:hover:bg-sunken"
                  >
                    {voice ? <Volume2 size={20} strokeWidth={1.75} aria-hidden="true" /> : <VolumeX size={20} strokeWidth={1.75} aria-hidden="true" />}
                  </button>
                  <Dialog.Close className="flex size-12 shrink-0 items-center justify-center rounded-control text-ink-2 [@media(hover:hover)]:hover:bg-sunken" aria-label="Close the chat">
                    <X size={20} strokeWidth={1.75} aria-hidden="true" />
                  </Dialog.Close>
                </header>

                <ChatThread
                  className="flex-1"
                  msgs={c.msgs}
                  thinking={c.thinking}
                  listening={c.listening}
                  expect={c.expect}
                  suggestions={chips}
                  inFlow={!!c.flow}
                  busy={c.busy}
                  autoFocus={desktop}
                  onSend={(t) => void c.send(t)}
                  onPick={c.pick}
                  onPlace={c.pickPlace}
                  onDate={c.pickDate}
                  onTime={c.pickTime}
                  onLeave={c.leaveFlow}
                  onRun={(id, card) => void c.run(id, card)}
                  onDecline={c.decline}
                  onListen={() => void c.listen()}
                  onLink={(to) => {
                    if (!desktop) close()
                    navigate(to)
                  }}
                />
              </motion.section>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  )
}

export default RooChat
