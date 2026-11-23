import { CircleCheck, TriangleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import { ApiError } from '@/api/client'
import { LinkPage, useLinkToken } from '@/components/LinkPage'
import { Button, ButtonLink } from '@/components/ui/Button'
import { LoadingRegion } from '@/components/ui/States'
import { useSessionStatus, verifyEmail } from '@/lib/session'

/** One request per link, even when the page mounts twice: a link works once. */
const tried = new Map<string, Promise<void>>()

function confirmOnce(token: string, again: boolean) {
  if (again || !tried.has(token)) tried.set(token, verifyEmail(token))
  return tried.get(token)!
}

type State = { kind: 'checking' } | { kind: 'done' } | { kind: 'failed'; message: string; retry: boolean }

/** Confirms the address from the link in the "Confirm your email for Reroute" email, as soon as it opens. */
export default function VerifyEmail() {
  const token = useLinkToken()
  const signedIn = useSessionStatus() === 'signedIn'
  const [state, setState] = useState<State>(token ? { kind: 'checking' } : { kind: 'failed', message: 'This link is incomplete. Open it again from the email.', retry: false })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!token) return
    let live = true
    setState({ kind: 'checking' })
    confirmOnce(token, attempt > 0)
      .then(() => live && setState({ kind: 'done' }))
      .catch((err: unknown) => {
        if (!live) return
        if (err instanceof ApiError && err.status === 400) setState({ kind: 'failed', message: err.message, retry: false })
        else setState({ kind: 'failed', message: "Couldn't reach Reroute. Check your connection and try again.", retry: true })
      })
    return () => {
      live = false
    }
  }, [token, attempt])

  const onward = signedIn ? (
    <ButtonLink to="/me" full className="mt-4">
      Go to Me
    </ButtonLink>
  ) : (
    <ButtonLink to="/signin" full className="mt-4">
      Sign in
    </ButtonLink>
  )

  return (
    <LinkPage title={state.kind === 'done' ? 'Email confirmed' : 'Confirm your email'}>
      {state.kind === 'checking' && (
        <LoadingRegion label="Confirming your email…">
          <p className="t-body text-ink-2">Confirming your email…</p>
        </LoadingRegion>
      )}
      {state.kind === 'done' && (
        <>
          <p role="status" className="flex items-start gap-2 t-body text-ink-2">
            <CircleCheck size={20} strokeWidth={1.75} aria-hidden="true" className="mt-0.5 shrink-0 text-green-ink" />
            Thanks: this email address is confirmed for your Reroute account.
          </p>
          {onward}
        </>
      )}
      {state.kind === 'failed' && (
        <>
          <p role="alert" className="flex items-start gap-2 t-body text-ink-2">
            <TriangleAlert size={20} strokeWidth={1.75} aria-hidden="true" className="mt-0.5 shrink-0 text-red-ink" />
            <span>
              {state.message}
              {!state.retry && ' You can send a new link from Me.'}
            </span>
          </p>
          {state.retry ? (
            <Button full className="mt-4" onClick={() => setAttempt((a) => a + 1)}>
              Try again
            </Button>
          ) : (
            onward
          )}
        </>
      )}
    </LinkPage>
  )
}
