import { TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router'
import { ApiError } from '@/api/client'
import { RouteMark } from '@/components/icons'
import { RerouteHero } from '@/components/RerouteHero'
import { Button } from '@/components/ui/Button'
import { googleEnabled, requestGoogleCode } from '@/lib/google'
import { signInDemo, signInWithGoogle, useSessionStatus } from '@/lib/session'

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

export default function SignIn() {
  const status = useSessionStatus()
  const navigate = useNavigate()
  const location = useLocation()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState<'google' | 'demo' | null>(null)
  // The demo account exists only where the server allows it (DEMO_LOGIN=true); a 404 hides the button.
  const [demoAvailable, setDemoAvailable] = useState(true)
  const from = (location.state as { from?: string } | null)?.from ?? '/'

  if (status === 'signedIn') return <Navigate to={from} replace />

  const run = async (kind: 'google' | 'demo') => {
    setBusy(kind)
    setError(undefined)
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

  return (
    <div className="flex min-h-dvh flex-col bg-ground text-ink">
      <main className="mx-auto flex w-full max-w-[440px] flex-1 flex-col justify-center px-5 py-12">
        <div className="flex items-center gap-3">
          <RouteMark size={44} />
          <h1 className="font-display text-[3rem] font-extrabold leading-none tracking-[-0.01em] text-ink [font-stretch:75%]">Reroute</h1>
        </div>
        <p className="mt-6 t-body text-ink-2">Plan your work day in a new city. We'll reroute it when you run late.</p>
        <div className="mt-8">
          <RerouteHero />
        </div>
        <div className="mt-10 flex flex-col gap-3">
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
              Use the demo account
            </Button>
          )}
          {!googleEnabled && !demoAvailable && <p className="t-body text-ink-2">Sign-in isn't set up on this server yet.</p>}
          {error && (
            <p role="alert" className="flex items-start gap-2 t-small text-red-ink">
              <TriangleAlert size={20} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
              {error}
            </p>
          )}
        </div>
      </main>
      <p className="px-5 pb-6 text-center t-small text-muted">Running late? We'll reroute your day.</p>
    </div>
  )
}
