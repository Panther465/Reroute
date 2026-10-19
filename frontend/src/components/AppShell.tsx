import * as Tooltip from '@radix-ui/react-tooltip'
import { CalendarClock, CircleUserRound, ListChecks } from 'lucide-react'
import { motion, MotionConfig } from 'motion/react'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Navigate, NavLink, Outlet, ScrollRestoration, useLocation, useMatches } from 'react-router'
import { AutoRickshaw, RouteMark } from '@/components/icons'
import { TodaySkeleton } from '@/components/TodaySkeleton'
import { Toaster } from '@/components/ui/Toaster'
import { useCurrentTripId, useMe, useTrip } from '@/api/queries'
import { flushQueue } from '@/lib/actions'
import { useIsDesktop, useOnline, useTripClock } from '@/lib/hooks'
import { useLive } from '@/lib/live'
import { useSessionStatus } from '@/lib/session'
import { T } from '@/lib/i18n'
import { getState, setState, useAnnouncement, useStore } from '@/lib/store'
import { LateContext } from '@/lib/late'
import { localMinutes } from '@/lib/timeline'

// Loaded the first time they're needed, so the shell stays small.
const RunningLateSheet = lazy(() => import('@/screens/RunningLateSheet').then((m) => ({ default: m.RunningLateSheet })))
const DemoPanel = lazy(() => import('@/components/DemoPanel').then((m) => ({ default: m.DemoPanel })))
const Roo = lazy(() => import('@/components/Roo').then((m) => ({ default: m.Roo })))

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

/**
 * After moving to another screen (not on the first load), put focus on the new screen's h1 so screen
 * readers start there. Lazy screens and loading states may draw the heading a moment later.
 */
function useFocusHeadingOnNavigate(pathname: string) {
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    let tries = 0
    let id = 0
    const find = () => {
      const h1 = document.querySelector<HTMLElement>('#main h1')
      if (h1) {
        if (!h1.hasAttribute('tabindex')) h1.tabIndex = -1
        h1.focus({ preventScroll: true })
      } else if (++tries < 40) id = window.setTimeout(find, 50)
    }
    id = window.setTimeout(find, 0)
    return () => clearTimeout(id)
  }, [pathname])
}

function TabBar() {
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
                  <span>
                    <T k={label} />
                  </span>
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
  const demo = useStore((s) => s.demo.enabled)
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-surface">
      <a
        href="#main"
        onClick={(e) => {
          e.preventDefault()
          document.getElementById('main')?.focus()
        }}
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-2 focus:z-50 focus:flex focus:min-h-12 focus:items-center focus:rounded-control focus:bg-surface focus:px-4 focus:t-title focus:text-ink focus:shadow-[var(--shadow-toast)]"
      >
        <T k="Skip to content" />
      </a>
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
                      <T k={label} />
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
  const demoEnabled = useStore((s) => s.demo.enabled)
  const [late, setLate] = useState<{ open: boolean; delay: number | null; mode: 'late' | 'options' }>({ open: false, delay: null, mode: 'late' })
  // The sheet stays mounted after it first opens, so it can animate closed.
  const [lateLoaded, setLateLoaded] = useState(false)
  const serverNow = trip.data ? localMinutes(trip.data.now, trip.data.day, trip.data.utcOffset) : null
  const clock = useTripClock(serverNow, trip.dataUpdatedAt, trip.data?.clockSimulated ?? false)
  useFocusHeadingOnNavigate(location.pathname)

  // The demo account always gets the Simulate panel.
  useEffect(() => {
    if (me.data?.isDemo && !getState().demo.enabled) setState((s) => ({ demo: { ...s.demo, enabled: true } }))
  }, [me.data?.isDemo])

  useLive(current.tripId, session === 'signedIn' && online)

  // Check-ins saved offline go out as soon as the phone is back.
  useEffect(() => {
    if (online && session === 'signedIn') void flushQueue(current.tripId)
  }, [online, session, current.tripId])

  if (session === 'loading') {
    return (
      <div className="min-h-dvh bg-ground text-ink">
        <TodaySkeleton />
      </div>
    )
  }
  // Signed out (or the session ran out): back to Sign in, which returns here afterwards.
  if (session === 'signedOut') return <Navigate to="/signin" replace state={{ from: location.pathname + location.search }} />
  const pushed = matches.some((m) => (m.handle as { pushed?: boolean } | undefined)?.pushed)
  const group = location.pathname.split('/')[1] ?? ''
  const openLate = (delay: number | null = null, mode: 'late' | 'options' = 'late') => {
    setLateLoaded(true)
    setLate({ open: true, delay, mode })
  }
  const moderator = me.data?.role === 'moderator' || me.data?.role === 'admin'

  return (
    <LateContext.Provider value={openLate}>
      {/* Reduced motion and tooltips are set up here, inside the app, so Sign in loads neither library. */}
      <MotionConfig reducedMotion="user">
        <Tooltip.Provider delayDuration={400}>
          <div className="min-h-dvh bg-ground text-ink">
            {desktop && <TopBar />}
            <motion.main
              id="main"
              tabIndex={-1}
              key={group}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.16 }}
              className={desktop ? '' : pushed ? 'pb-8' : 'pb-[calc(64px+env(safe-area-inset-bottom))]'}
            >
              <Outlet context={{ moderator }} />
            </motion.main>
            {!desktop && !pushed && <TabBar />}
            {lateLoaded && (
              <Suspense fallback={null}>
                <RunningLateSheet
                  trip={trip.data}
                  clock={clock}
                  open={late.open}
                  initialDelay={late.delay}
                  mode={late.mode}
                  onOpenChange={(open) => {
                    setLate((l) => ({ ...l, open }))
                    if (!open) setState({ pendingDelay: null })
                  }}
                />
              </Suspense>
            )}
            {demoEnabled && trip.data && (
              <Suspense fallback={null}>
                <DemoPanel trip={trip.data} onLate={openLate} />
              </Suspense>
            )}
            <Suspense fallback={null}>
              <Roo trip={trip.data ?? undefined} clock={clock ?? null} />
            </Suspense>
            <Toaster tripId={current.tripId} />
            <Announcer />
            <ScrollRestoration />
          </div>
        </Tooltip.Provider>
      </MotionConfig>
    </LateContext.Provider>
  )
}
