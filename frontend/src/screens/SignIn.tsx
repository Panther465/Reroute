import { ArrowUpRight, TriangleAlert } from 'lucide-react'
import { lazy, Suspense, useState, type ReactNode } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router'
import { ApiError } from '@/api/client'
import { AuthCard } from '@/components/AuthCard'
import { RouteMark } from '@/components/icons'
import { Button } from '@/components/ui/Button'
import { loadShell, loadToday } from '@/app/lazy'
import { useDocumentTitle } from '@/lib/hooks'
import { signInDemo, useSessionStatus } from '@/lib/session'

// The live demo (and the animation library) loads after the page is up; its box holds the space meanwhile.
const LandingDemo = lazy(() => import('@/components/LandingDemo').then((m) => ({ default: m.LandingDemo })))

const SOURCE = 'https://github.com/Panther465/Reroute'

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
  const [busy, setBusy] = useState(false)
  // The demo account exists only where the server allows it (DEMO_LOGIN=true); a 404 hides the button.
  const [demoAvailable, setDemoAvailable] = useState(true)
  // Right after an account is made, Roo takes over: don't bounce to Today first.
  const [arriving, setArriving] = useState(false)
  const from = (location.state as { from?: string } | null)?.from ?? '/'
  useDocumentTitle('Running late? We’ll reroute your day')

  if (status === 'signedIn' && !arriving) return <Navigate to={from} replace />

  // Fetch the app while signing in, so the next screen opens straight after.
  const preload = () => {
    void loadShell().catch(() => undefined)
    void loadToday().catch(() => undefined)
  }
  const signedIn = (how: 'created' | 'signedIn' | 'demo') => navigate(how === 'created' ? '/' : from, { replace: true })

  const demoDay = async () => {
    setBusy(true)
    setError(undefined)
    preload()
    try {
      await signInDemo('traveller')
      navigate(from, { replace: true })
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setDemoAvailable(false)
      else setError(err instanceof ApiError || err instanceof Error ? err.message : "Couldn't sign in. Try again.")
    } finally {
      setBusy(false)
    }
  }

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
        <section aria-labelledby="hero-h" className="grid items-start gap-10 pb-16 pt-6 lg:grid-cols-[1fr_26rem] lg:gap-16 lg:pb-20 lg:pt-10">
          <div className="lg:pt-20">
            <h1 id="hero-h" tabIndex={-1} className="max-w-[12ch] font-display text-[2.75rem] font-extrabold leading-[2.875rem] text-ink [font-stretch:87.5%] [text-wrap:balance] lg:text-[4.5rem] lg:leading-[4.5rem]">
              Running late? We’ll reroute your day.
            </h1>
            <p className="mt-6 max-w-[34rem] t-body text-ink-2 lg:text-[1.1875rem] lg:leading-8">
              Reroute plans a work day in a city you don’t know: the order, when to leave, how to get there and what it costs. When a meeting runs over, it re-plans the rest of the day.
            </p>
            <ul className="mt-8 hidden max-w-[34rem] flex-col gap-3 t-body text-ink-2 lg:flex">
              {['Plans the order, the times and the cheapest way there', 'Re-plans the rest of the day when you run late', 'Roo, a companion you can talk to, keeps you on time'].map((line) => (
                <li key={line} className="flex items-start gap-3">
                  <span aria-hidden="true" className="mt-2 size-2 shrink-0 rounded-full bg-green" />
                  {line}
                </li>
              ))}
            </ul>
          </div>
          <div id="account" className="scroll-mt-6">
            <AuthCard
              onLoading={() => {
                setArriving(true)
                preload()
              }}
              onSignedIn={signedIn}
            />
            <p className="mt-4 max-w-[26rem] t-small text-muted">The demo is a sample day in Bengaluru. Bookings and the wallet are simulated: nothing real is booked or charged.</p>
          </div>
        </section>

        <section aria-labelledby="live-h" className="grid items-center gap-10 py-16 lg:grid-cols-[1fr_1.05fr] lg:gap-16 lg:py-24">
          <div>
            <h2 id="live-h" className="t-display-1 text-ink lg:text-[2.75rem] lg:leading-[3rem]">
              Run a meeting late, right here
            </h2>
            <p className="mt-4 max-w-[34rem] t-body text-ink-2 lg:text-[1.0625rem] lg:leading-7">
              This is the sample day as Reroute plans it. Make the meeting 15 minutes late and the later stops simply move. Make it 40 and something has to give: you choose between a cab and keeping it cheap.
            </p>
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
          <div className="mt-8 flex w-full max-w-[22rem] flex-col gap-3">
            {demoAvailable && (
              <Button full loading={busy} loadingLabel="Signing in…" onClick={() => void demoDay()}>
                Try the demo day
              </Button>
            )}
            <a href="#account" className="inline-flex min-h-12 items-center justify-center rounded-control t-title text-ink underline decoration-2 underline-offset-4">
              Or create your own account
            </a>
            {error && (
              <p role="alert" className="flex items-start gap-2 text-left t-small text-red-ink">
                <TriangleAlert size={20} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
                {error}
              </p>
            )}
          </div>
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
