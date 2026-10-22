import { Eye, EyeOff, TriangleAlert } from 'lucide-react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useState, type FormEvent } from 'react'
import { ApiError } from '@/api/client'
import { RooArt } from '@/components/roo/RooArt'
import { Button } from '@/components/ui/Button'
import { Segmented } from '@/components/ui/Choice'
import { Field } from '@/components/ui/Field'
import { googleEnabled, requestGoogleCode } from '@/lib/google'
import { EASE_OUT } from '@/lib/motion'
import { signInDemo, signInWithGoogle, signInWithPassword, signUp } from '@/lib/session'

type Mode = 'create' | 'signin'
type Busy = 'form' | 'google' | 'demo' | null

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

export function GoogleG() {
  return (
    <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  )
}

/**
 * Create an account, or sign in: email and password, Google, or the demo day. The card grows and shrinks
 * with its fields (a layout animation), and Roo pops up to say hello once you're in.
 */
export function AuthCard({ onSignedIn, onLoading }: { onSignedIn: (how: 'created' | 'signedIn' | 'demo') => void; onLoading?: () => void }) {
  const reduce = !!useReducedMotion()
  const [mode, setMode] = useState<Mode>('create')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [show, setShow] = useState(false)
  const [errors, setErrors] = useState<{ name?: string; email?: string; password?: string }>({})
  const [problem, setProblem] = useState<{ text: string; switchTo?: Mode } | null>(null)
  const [busy, setBusy] = useState<Busy>(null)
  // The demo account exists only where the server allows it (DEMO_LOGIN=true); a 404 hides the button.
  const [demoAvailable, setDemoAvailable] = useState(true)
  const [welcome, setWelcome] = useState<string | null>(null)

  const creating = mode === 'create'

  const check = () => {
    const next: typeof errors = {}
    if (creating && !name.trim()) next.name = 'Enter your name.'
    if (!EMAIL.test(email.trim())) next.email = 'Enter an email address, like asha@example.com.'
    if (creating ? password.length < 8 : !password) next.password = creating ? 'Use at least 8 characters.' : 'Enter your password.'
    setErrors(next)
    return Object.keys(next).length === 0
  }

  const finish = (how: 'created' | 'signedIn' | 'demo', who: string) => {
    // Roo says hello for a moment; with reduced motion, straight on.
    setWelcome(who)
    setTimeout(() => onSignedIn(how), reduce ? 0 : 900)
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setProblem(null)
    if (!check()) return
    setBusy('form')
    onLoading?.()
    try {
      if (creating) await signUp(name.trim(), email.trim(), password)
      else await signInWithPassword(email.trim(), password)
      finish(creating ? 'created' : 'signedIn', creating ? name.trim().split(/\s+/)[0] : '')
    } catch (err) {
      if (err instanceof ApiError && err.code === 'EMAIL_TAKEN') setProblem({ text: err.message, switchTo: 'signin' })
      else setProblem({ text: err instanceof ApiError ? err.message : "Couldn't reach Reroute. Check your connection and try again." })
      setBusy(null)
    }
  }

  const other = async (kind: 'google' | 'demo') => {
    setProblem(null)
    setBusy(kind)
    onLoading?.()
    try {
      if (kind === 'google') await signInWithGoogle(await requestGoogleCode())
      else await signInDemo('traveller')
      finish(kind === 'demo' ? 'demo' : 'signedIn', '')
    } catch (err) {
      if (kind === 'demo' && err instanceof ApiError && err.status === 404) setDemoAvailable(false)
      else setProblem({ text: err instanceof ApiError || err instanceof Error ? err.message : "Couldn't sign in. Try again." })
      setBusy(null)
    }
  }

  const switchTo = (m: Mode) => {
    setMode(m)
    setErrors({})
    setProblem(null)
  }

  return (
    <motion.div
      layout={!reduce}
      transition={{ layout: { duration: 0.28, ease: EASE_OUT } }}
      initial={reduce ? { opacity: 0 } : { opacity: 0, transform: 'translateY(12px)' }}
      animate={{ opacity: 1, transform: 'translateY(0px)', transition: { duration: 0.4, ease: EASE_OUT, delay: 0.1 } }}
      className="relative w-full max-w-[26rem] overflow-hidden rounded-card border border-line bg-surface p-5 shadow-[var(--shadow-toast)]"
    >
      <AnimatePresence>
        {welcome !== null && (
          <motion.div
            key="hello"
            role="status"
            className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-surface text-center"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: { duration: 0.18 } }}
          >
            <motion.span
              initial={reduce ? false : { transform: 'scale(0.9) translateY(12px)', opacity: 0 }}
              animate={{ transform: 'scale(1) translateY(0px)', opacity: 1 }}
              transition={{ type: 'spring', duration: 0.5, bounce: 0.35 }}
            >
              <RooArt mood="wave" size={88} reduce={reduce} />
            </motion.span>
            <p className="t-display-2 text-ink">{welcome ? `Hi, ${welcome}!` : 'Welcome back!'}</p>
          </motion.div>
        )}
      </AnimatePresence>

      <motion.div layout={reduce ? false : 'position'}>
        <Segmented<Mode>
          label="Create an account or sign in"
          hideLabel
          value={mode}
          onChange={switchTo}
          options={[
            { value: 'create', label: 'Create account' },
            { value: 'signin', label: 'Sign in' },
          ]}
        />
      </motion.div>

      <form onSubmit={submit} noValidate className="mt-4 flex flex-col gap-4">
        <AnimatePresence initial={false} mode="popLayout">
          {creating && (
            <motion.div
              key="name"
              layout={!reduce}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: { duration: 0.2, delay: 0.08 } }}
              exit={{ opacity: 0, transition: { duration: 0.12 } }}
            >
              <Field label="Your name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} error={errors.name} maxLength={80} />
            </motion.div>
          )}
        </AnimatePresence>
        <motion.div layout={reduce ? false : 'position'} className="flex flex-col gap-4">
          <Field label="Email" type="email" inputMode="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} error={errors.email} maxLength={320} />
          <Field
            label="Password"
            type={show ? 'text' : 'password'}
            autoComplete={creating ? 'new-password' : 'current-password'}
            hint={creating ? 'At least 8 characters.' : undefined}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            error={errors.password}
            maxLength={128}
            trailing={
              <button
                type="button"
                onClick={() => setShow((s) => !s)}
                aria-label={show ? 'Hide the password' : 'Show the password'}
                aria-pressed={show}
                className="flex size-11 items-center justify-center rounded-control text-ink-2 [@media(hover:hover)]:hover:bg-sunken"
              >
                {show ? <EyeOff size={20} strokeWidth={1.75} aria-hidden="true" /> : <Eye size={20} strokeWidth={1.75} aria-hidden="true" />}
              </button>
            }
          />
          {problem && (
            <p role="alert" className="flex items-start gap-2 t-small text-red-ink">
              <TriangleAlert size={20} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
              <span>
                {problem.text}{' '}
                {problem.switchTo && (
                  <button type="button" onClick={() => switchTo(problem.switchTo!)} className="font-bold text-ink underline underline-offset-4">
                    Sign in
                  </button>
                )}
              </span>
            </p>
          )}
          <Button type="submit" full loading={busy === 'form'} loadingLabel={creating ? 'Creating your account…' : 'Signing in…'} disabled={busy !== null && busy !== 'form'}>
            {creating ? 'Create my account' : 'Sign in'}
          </Button>
        </motion.div>
      </form>

      <motion.div layout={reduce ? false : 'position'}>
        <div className="my-4 flex items-center gap-3 t-small text-muted" aria-hidden="true">
          <span className="h-px flex-1 bg-line" />
          or
          <span className="h-px flex-1 bg-line" />
        </div>
        <div className="flex flex-col gap-3">
          <button
            type="button"
            onClick={() => void other('google')}
            disabled={!googleEnabled || busy !== null}
            aria-describedby={googleEnabled ? undefined : 'google-off'}
            className="flex min-h-12 items-center justify-center gap-[10px] rounded-full border border-[var(--google-border)] bg-[var(--google-bg)] px-3 text-[var(--google-text)] transition-[scale] duration-[var(--dur-quick)] motion-safe:active:enabled:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50"
            style={{ fontFamily: "'Roboto', 'Atkinson Hyperlegible', sans-serif", fontWeight: 500, fontSize: 14, lineHeight: '20px' }}
          >
            <GoogleG />
            {busy === 'google' ? 'Signing in…' : 'Continue with Google'}
          </button>
          {!googleEnabled && (
            <p id="google-off" className="-mt-1 text-center t-small text-muted">
              Google sign-in isn’t set up on this server yet.
            </p>
          )}
          {demoAvailable && (
            <Button variant="secondary" full loading={busy === 'demo'} loadingLabel="Signing in…" disabled={busy !== null && busy !== 'demo'} onClick={() => void other('demo')}>
              Use the demo account
            </Button>
          )}
        </div>
      </motion.div>
    </motion.div>
  )
}
