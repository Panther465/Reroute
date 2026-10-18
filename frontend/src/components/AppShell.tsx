import { CalendarClock, CircleUserRound, ListChecks } from 'lucide-react'
import { motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { Navigate, NavLink, Outlet, ScrollRestoration, useLocation, useMatches } from 'react-router'
import { DemoPanel } from '@/components/DemoPanel'
import { AutoRickshaw, RouteMark } from '@/components/icons'
import { RunningLateSheet } from '@/screens/RunningLateSheet'
import { Toaster } from '@/components/ui/Toaster'
import { useCurrentTripId, useMe, useTrip } from '@/api/queries'
import { flushQueue } from '@/lib/actions'
import { useIsDesktop, useOnline } from '@/lib/hooks'
import { useLive } from '@/lib/live'
import { useSessionStatus } from '@/lib/session'
import { useT } from '@/lib/i18n'
import { getState, setState, useAnnouncement, useStore } from '@/lib/store'
import { LateContext } from '@/lib/late'

const TABS = [
  { to: '/', label: 'Today', Icon: CalendarClock, end: true },
  { to: '/plan', label: 'Plan', Icon: ListChecks, end: false },
  { to: '/raasta', label: 'Raasta', Icon: AutoRickshaw, end: false },
  { to: '/me', label: 'Me', Icon: CircleUserRound, end: false },
] as const

export function Announcer() {
  const text = useAnnouncement()
  return (
    <div aria-live="polite" aria-atomic="true" className="sr-only">
      {text}
    </div>
  )
}

function TabBar() {
  const t = useT()
  const lang = useStore((s) => s.lang)
  return (
    <nav aria-label="Main" className="pb-safe fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface">
      <ul className="mx-auto grid h-16 max-w-[560px] grid-cols-4">
        {TABS.map(({ to, label, Icon, end }) => (
          <li key={to}>
            <NavLink
              to={to}
              end={end}
              className={({ isActive }) =>
                `relative flex h-16 flex-col items-center justify-center gap-0.5 t-caption transition-colors duration-[var(--dur-quick)] ${isActive ? 'text-green' : 'text-muted'}`
              }
            >
              {({ isActive }) => (
                <>
                  {isActive && <span aria-hidden="true" className="absolute inset-x-5 top-0 h-[3px] rounded-b-full bg-green" />}
                  <Icon size={24} strokeWidth={1.75} aria-hidden="true" />
                  <span lang={lang === 'hi' ? 'hi' : undefined}>{t(label)}</span>
                </>
              )}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  )
}

function TopBar() {
  const t = useT()
  const demo = useStore((s) => s.demo.enabled)
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-surface">
      <div className="mx-auto flex h-16 max-w-[1440px] items-center gap-8 px-8">
        <NavLink to="/" className="flex min-h-12 items-center gap-2 rounded-control" aria-label="Reroute, Today">
          <RouteMark size={28} />
          <span className="font-display text-[1.5rem] font-extrabold leading-none tracking-[-0.01em] text-ink [font-stretch:75%]">Reroute</span>
        </NavLink>
        <nav aria-label="Main">
          <ul className="flex gap-1">
            {TABS.map(({ to, label, Icon, end }) => (
              <li key={to}>
                <NavLink
                  to={to}
                  end={end}
                  className={({ isActive }) =>
                    `relative flex h-16 items-center gap-2 px-4 t-title transition-colors duration-[var(--dur-quick)] [@media(hover:hover)]:hover:bg-sunken ${isActive ? 'text-green' : 'text-ink-2'}`
                  }
                >
                  {({ isActive }) => (
                    <>
                      <Icon size={24} strokeWidth={1.75} aria-hidden="true" />
                      {t(label)}
                      {isActive && <span aria-hidden="true" className="absolute inset-x-3 bottom-0 h-[3px] rounded-t-full bg-green" />}
                    </>
                  )}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        {demo && <span className="ml-auto rounded-tag bg-sunken px-2 py-0.5 t-caption text-ink-2">Demo</span>}
      </div>
    </header>
  )
}

export default function AppShell() {
  const session = useSessionStatus()
  const desktop = useIsDesktop()
  const matches = useMatches()
  const location = useLocation()
  const online = useOnline()
  const me = useMe(session === 'signedIn')
  const current = useCurrentTripId()
  const trip = useTrip(current.tripId)
  const [late, setLate] = useState<{ open: boolean; delay: number | null; mode: 'late' | 'options' }>({ open: false, delay: null, mode: 'late' })

  // The demo account always gets the Simulate panel.
  useEffect(() => {
    if (me.data?.isDemo && !getState().demo.enabled) setState((s) => ({ demo: { ...s.demo, enabled: true } }))
  }, [me.data?.isDemo])

  useLive(current.tripId, session === 'signedIn' && online)

  // Check-ins saved offline go out as soon as the phone is back.
  useEffect(() => {
    if (online && session === 'signedIn') void flushQueue(current.tripId)
  }, [online, session, current.tripId])

  if (session === 'loading') return <div className="min-h-dvh bg-ground" aria-busy="true" />
  if (session === 'signedOut') return <Navigate to="/signin" replace state={{ from: location.pathname }} />
  const pushed = matches.some((m) => (m.handle as { pushed?: boolean } | undefined)?.pushed)
  const group = location.pathname.split('/')[1] ?? ''
  const openLate = (delay: number | null = null, mode: 'late' | 'options' = 'late') => setLate({ open: true, delay, mode })
  const moderator = me.data?.role === 'moderator' || me.data?.role === 'admin'

  return (
    <LateContext.Provider value={openLate}>
      <div className="min-h-dvh bg-ground text-ink">
        {desktop && <TopBar />}
        <motion.main
          id="main"
          key={group}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.16 }}
          className={desktop ? '' : pushed ? 'pb-8' : 'pb-[calc(64px+env(safe-area-inset-bottom))]'}
        >
          <Outlet context={{ moderator }} />
        </motion.main>
        {!desktop && !pushed && <TabBar />}
        <RunningLateSheet
          trip={trip.data}
          open={late.open}
          initialDelay={late.delay}
          mode={late.mode}
          onOpenChange={(open) => {
            setLate((l) => ({ ...l, open }))
            if (!open) setState({ pendingDelay: null })
          }}
        />
        <DemoPanel trip={trip.data} onLate={openLate} />
        <Toaster tripId={current.tripId} />
        <Announcer />
        <ScrollRestoration />
      </div>
    </LateContext.Provider>
  )
}
