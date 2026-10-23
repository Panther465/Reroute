import { Volume2, VolumeX } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, Navigate, useNavigate } from 'react-router'
import { useAgentEnabled, useAiHelperEnabled, useMe } from '@/api/queries'
import { RouteMark } from '@/components/icons'
import { ThemeToggle } from '@/components/ThemeToggle'
import { ChatThread } from '@/components/roo/ChatThread'
import type { Mood } from '@/components/roo/RooArt'
import { RooPet } from '@/components/roo/RooPet'
import { useConversation } from '@/components/roo/useConversation'
import { useDocumentTitle, useIsDesktop, useOnline } from '@/lib/hooks'
import { useSessionStatus } from '@/lib/session'
import { setState, useStore } from '@/lib/store'

/**
 * A new account meets Roo: full screen, Roo introduces itself and sets up the first trip by chatting
 * (lib/roo/flows.ts), then plans the day and shows it. "Set it up myself" goes to the form on Plan.
 */
export default function Welcome() {
  const status = useSessionStatus()
  const me = useMe(status === 'signedIn')
  const navigate = useNavigate()
  const desktop = useIsDesktop()
  const online = useOnline()
  const ai = useAiHelperEnabled()
  const agent = useAgentEnabled()
  const voice = useStore((s) => s.rooVoice)
  useDocumentTitle('Meet Roo')

  const c = useConversation({
    storageKey: null,
    ctx: { trip: undefined, view: null, clock: null, leftFor: null, name: me.data?.name },
    ai,
    agent,
    online,
    voice,
    stepAside: () => undefined,
    onShow: () => navigate('/', { replace: true }),
  })

  // Roo's hello, once the account's name is known.
  const started = useRef(false)
  useEffect(() => {
    if (started.current || !me.data) return
    started.current = true
    void c.startFlow('onboard', true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me.data])

  // Roo hops each time it says something.
  const [hop, setHop] = useState(0)
  const rooLines = c.msgs.filter((m) => m.from === 'roo').length
  useEffect(() => {
    if (rooLines) setHop((h) => h + 1)
  }, [rooLines])

  if (status === 'signedOut') return <Navigate to="/signin" replace />

  const face: Mood = c.listening ? 'listening' : c.talking ? 'talking' : c.thinking || c.busy ? 'thinking' : c.mood
  return (
    <div className="flex h-dvh flex-col bg-ground text-ink">
      <div aria-hidden="true" className="pointer-events-none fixed inset-x-0 top-0 h-[60vh] bg-[radial-gradient(ellipse_at_top,var(--green-tint),transparent_65%)]" />
      <header className="relative mx-auto flex w-full max-w-[1200px] items-center justify-between gap-3 px-5 py-3 lg:px-8">
        <span className="flex items-center gap-2">
          <RouteMark size={28} />
          <span className="font-display text-[1.5rem] font-extrabold leading-none text-ink [font-stretch:75%]">Reroute</span>
        </span>
        <span className="flex items-center gap-1">
          <ThemeToggle />
          <button
            type="button"
            onClick={() => setState({ rooVoice: !voice })}
            aria-pressed={voice}
            aria-label={voice ? 'Mute Roo' : 'Let Roo speak'}
            className="flex size-12 items-center justify-center rounded-control text-ink-2 [@media(hover:hover)]:hover:bg-sunken"
          >
            {voice ? <Volume2 size={20} strokeWidth={1.75} aria-hidden="true" /> : <VolumeX size={20} strokeWidth={1.75} aria-hidden="true" />}
          </button>
          <Link to="/plan" state={{ newTrip: true }} className="inline-flex min-h-12 items-center rounded-control px-3 t-small font-bold text-ink-2 underline decoration-line-strong decoration-2 underline-offset-4">
            Set it up myself
          </Link>
        </span>
      </header>

      <main className="relative mx-auto flex min-h-0 w-full max-w-[680px] flex-1 flex-col">
        <h1 className="sr-only">Meet Roo, your travel companion</h1>
        <div className="flex shrink-0 justify-center pb-2 pt-1">
          <RooPet mood={face} hop={hop} size={desktop ? 170 : 116} />
        </div>
        <ChatThread
          className="flex-1 rounded-t-sheet border border-b-0 border-line bg-surface shadow-[var(--shadow-sheet)] lg:mb-6 lg:rounded-sheet lg:border-b"
          msgs={c.msgs}
          thinking={c.thinking}
          listening={c.listening}
          expect={c.expect}
          suggestions={[]}
          inFlow={!!c.flow}
          busy={c.busy}
          working={c.working}
          autoFocus={desktop}
          onSend={(t) => void c.send(t)}
          onPick={c.pick}
          onPlace={c.pickPlace}
          onDate={c.pickDate}
          onTime={c.pickTime}
          onLeave={c.leaveFlow}
          onRun={(id, card) => void c.run(id, card)}
          onDecline={c.decline}
          onPlanRun={(id, plan) => void c.runPlan(id, plan)}
          onPlanDecline={c.declinePlan}
          onPlanUndo={(id, plan) => void c.undoPlan(id, plan)}
          onListen={() => void c.listen()}
          onLink={(to) => navigate(to)}
        />
      </main>
    </div>
  )
}
