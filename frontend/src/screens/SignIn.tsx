import { ArrowUpRight, TriangleAlert } from 'lucide-react'
import { lazy, Suspense, useState, type ReactNode } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router'
import { ApiError } from '@/api/client'
import { RouteMark } from '@/components/icons'
import { Button } from '@/components/ui/Button'
import { loadShell, loadToday } from '@/app/lazy'
import { googleEnabled, requestGoogleCode } from '@/lib/google'
import { useDocumentTitle } from '@/lib/hooks'
import { signInDemo, signInWithGoogle, useSessionStatus } from '@/lib/session'

// The live demo (and the animation library) loads after the page is up; its box holds the space meanwhile.
const LandingDemo = lazy(() => import('@/components/LandingDemo').then((m) => ({ default: m.LandingDemo })))

const SOURCE = 'https://github.com/Panther465/Reroute'

function GoogleG() {
  return (
    <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  )
}

/** A real screen of the app, in the theme the reader is using: its top, where the screen says what it is. */
function Screen({ name, alt }: { name: string; alt: string }) {
  return (
    <div className="mx-auto aspect-[390/640] w-full max-w-[320px] overflow-hidden rounded-card border border-line bg-surface">
      <picture>
        <source srcSet={`/landing/${name}-dark.jpg`} media="(prefers-color-scheme: dark)" />
        <img src={`/landing/${name}-light.jpg`} alt={alt} width={390} height={844} loading="lazy" decoding="async" className="block h-auto w-full" />
      </picture>
    </div>
  )
}

/** One claim and its proof: text on one side, the app's own screen on the other (alternating sides). */
function Claim({ id, title, flip, screen, children }: { id: string; title: string; flip?: boolean; screen: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="grid items-center gap-10 py-16 lg:grid-cols-2 lg:gap-16 lg:py-24">
      <div className={flip ? 'lg:order-2' : ''}>
        <h2 id={id} className="t-display-1 text-ink lg:text-[2.75rem] lg:leading-[3rem]">
          {title}
        </h2>
        <div className="mt-4 flex max-w-[34rem] flex-col gap-3 t-body text-ink-2 lg:text-[1.0625rem] lg:leading-7">{children}</div>
      </div>
      <div className={flip ? 'lg:order-1' : ''}>{screen}</div>
    </section>
  )
}

export default function SignIn() {
  const status = useSessionStatus()
  const navigate = useNavigate()
  const location = useLocation()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState<'google' | 'demo' | null>(null)
  // The demo account exists only where the server allows it (DEMO_LOGIN=true); a 404 hides the button.
  const [demoAvailable, setDemoAvailable] = useState(true)
  const from = (location.state as { from?: string } | null)?.from ?? '/'
  useDocumentTitle('Running late? We’ll reroute your day')

  if (status === 'signedIn') return <Navigate to={from} replace />

  const run = async (kind: 'google' | 'demo') => {
    setBusy(kind)
    setError(undefined)
    // Fetch the app while signing in, so Today opens straight after.
    void loadShell().catch(() => undefined)
    void loadToday().catch(() => undefined)
    try {
      if (kind === 'google') await signInWithGoogle(await requestGoogleCode())
      else await signInDemo('traveller')
      navigate(from, { replace: true })
    } catch (err) {
      if (kind === 'demo' && err instanceof ApiError && err.status === 404) {
        setDemoAvailable(false)
        return
      }
      setError(err instanceof ApiError || err instanceof Error ? err.message : "Couldn't sign in. Try again.")
    } finally {
      setBusy(null)
    }
  }

  const signIn = (demoLabel: string) => (
    <div className="flex flex-col gap-3 sm:max-w-[22rem]">
      {googleEnabled && (
        <button
          type="button"
          onClick={() => void run('google')}
          disabled={busy !== null}
          className="flex min-h-12 items-center justify-center gap-[10px] rounded-full border border-[var(--google-border)] bg-[var(--google-bg)] px-3 text-[var(--google-text)] disabled:opacity-60"
          style={{ fontFamily: "'Roboto', 'Atkinson Hyperlegible', sans-serif", fontWeight: 500, fontSize: 14, lineHeight: '20px' }}
        >
          <GoogleG />
          {busy === 'google' ? 'Signing in…' : 'Continue with Google'}
        </button>
      )}
      {demoAvailable && (
        <Button variant={googleEnabled ? 'secondary' : 'primary'} full loading={busy === 'demo'} loadingLabel="Signing in…" onClick={() => void run('demo')}>
          {demoLabel}
        </Button>
      )}
      {!googleEnabled && !demoAvailable && <p className="t-body text-ink-2">Sign-in isn't set up on this server yet.</p>}
    </div>
  )

  return (
    <div className="min-h-dvh bg-ground text-ink">
      <header className="mx-auto flex max-w-[1200px] items-center justify-between px-5 py-5 lg:px-8">
        <span className="flex items-center gap-2">
          <RouteMark size={32} />
          <span className="font-display text-[1.75rem] font-extrabold leading-none text-ink [font-stretch:75%]">Reroute</span>
        </span>
        <a href={SOURCE} className="inline-flex min-h-12 items-center gap-1 rounded-control px-2 t-small font-bold text-ink-2 underline decoration-line-strong decoration-2 underline-offset-4 [@media(hover:hover)]:hover:text-ink">
          Source code
          <ArrowUpRight size={16} strokeWidth={2} aria-hidden="true" />
        </a>
      </header>

      <main className="mx-auto max-w-[1200px] px-5 lg:px-8">
        <section aria-labelledby="hero-h" className="grid items-center gap-10 pb-16 pt-6 lg:grid-cols-[1fr_1.05fr] lg:gap-16 lg:pb-24 lg:pt-12">
          <div>
            <h1 id="hero-h" tabIndex={-1} className="max-w-[12ch] font-display text-[2.75rem] font-extrabold leading-[2.875rem] text-ink [font-stretch:87.5%] [text-wrap:balance] lg:text-[4.5rem] lg:leading-[4.5rem]">
              Running late? We’ll reroute your day.
            </h1>
            <p className="mt-6 max-w-[34rem] t-body text-ink-2 lg:text-[1.1875rem] lg:leading-8">
              Reroute plans a work day in a city you don’t know: the order, when to leave, how to get there and what it costs. When a meeting runs over, it re-plans the rest of the day.
            </p>
            <div className="mt-8">{signIn('Use the demo account')}</div>
            {error && (
              <p role="alert" className="mt-3 flex items-start gap-2 t-small text-red-ink">
                <TriangleAlert size={20} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
                {error}
              </p>
            )}
            <p className="mt-4 t-small text-muted">The demo is a sample day in Bengaluru. Nothing is booked or charged.</p>
          </div>
          <Suspense fallback={<div className="aspect-[4/5] w-full rounded-card border border-line bg-surface" aria-hidden="true" />}>
            <LandingDemo />
          </Suspense>
        </section>

        <Claim id="plan-h" title="Plan once, then just go" screen={<Screen name="today" alt="Today in Reroute: leave by 08:50 for the meeting in Whitefield, with the day's stops on a line" />}>
          <p>Tell it your meetings, the bank that closes at four and where you’re staying, or describe the day in a sentence. Reroute works out the order, when to leave and how to travel: metro, shared autos, walking or a cab.</p>
          <p>Then it follows the day with you, from “Leave in 5 minutes” to “You’ve arrived”, and checks every five minutes whether you’re behind.</p>
        </Claim>

        <Claim id="why-h" title="Every plan explains itself" flip screen={<Screen name="why" alt="Why this plan: your plan costs ₹1,320 less than cabs door to door; the day three ways, with fares and time travelling" />}>
          <p>Tap “Why this plan?” to see the day three ways, priced the same way: your plan, cabs door to door, and no cabs at all.</p>
          <p>Every leg lists the ways Reroute weighed and what each would change: fifteen minutes faster, ₹350 more. A small delay shifts the day by itself; a big one offers two or three explained options, and Undo puts the old plan back.</p>
        </Claim>

        <Claim id="raasta-h" title="Shared autos, checked by riders" screen={<Screen name="raasta" alt="A verified shared auto from Koramangala to Jayanagar: ₹30 a person, about every 10 minutes, last one around 21:30" />}>
          <p>Raasta maps the shared autos, e-rickshaws and tempos that cross Indian cities for a fraction of a cab: the stands, the fare, how often they come and when the last one leaves.</p>
          <p>A route counts only once a moderator or two different riders confirm it, and Reroute never sends you to one that isn’t verified.</p>
        </Claim>

        <section aria-labelledby="built-h" className="py-16 lg:py-24">
          <h2 id="built-h" className="t-display-1 text-ink lg:text-[2.75rem] lg:leading-[3rem]">
            Built like a product
          </h2>
          <dl className="mt-8 grid gap-x-16 gap-y-8 md:grid-cols-2">
            {[
              ['An exact planner', 'It tries every order of up to eight tasks and every way to travel each leg, and keeps the cheapest day that keeps every fixed time and opening hour.'],
              ['It works offline', 'The plan stays on the phone. Check-ins made without signal wait with their keys and sync once you’re back, never twice.'],
              ['Your location stays yours', 'Live tracking runs on the phone. Family get a link to your stops and progress, never to where you are.'],
              ['About 400 automated tests', 'The planner, both APIs, the web app, and the full demo day in a real browser, with accessibility checks on every main screen.'],
            ].map(([term, text]) => (
              <div key={term}>
                <dt className="t-title text-ink lg:text-[1.25rem]">{term}</dt>
                <dd className="mt-2 max-w-[34rem] t-body text-ink-2">{text}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section aria-labelledby="try-h" className="flex flex-col items-center py-16 text-center lg:py-24">
          <h2 id="try-h" className="t-display-1 text-ink lg:text-[2.75rem] lg:leading-[3rem]">
            Try the demo day
          </h2>
          <p className="mt-4 max-w-[34rem] t-body text-ink-2">A Wednesday in Bengaluru with a meeting, a bank and a university office. Run late on purpose and see what Reroute does.</p>
          <div className="mt-8 w-full max-w-[22rem]">{signIn('Try the demo day')}</div>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-[1200px] flex-col gap-4 px-5 py-10 lg:flex-row lg:items-end lg:justify-between lg:px-8">
          <span className="flex items-center gap-3">
            <RouteMark size={40} />
            <span className="font-display text-[2.5rem] font-extrabold leading-none text-ink [font-stretch:75%]">Reroute</span>
          </span>
          <p className="max-w-[34rem] t-small text-muted lg:text-right">
            A work-trip planner for Indian cities. The demo uses sample places and travel times for Bengaluru; every time and fare is an estimate. <a href={SOURCE} className="font-bold text-ink-2 underline underline-offset-4">Source code</a>
          </p>
        </div>
      </footer>
    </div>
  )
}
