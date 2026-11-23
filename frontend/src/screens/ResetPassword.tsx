import { CircleCheck, Eye, EyeOff, TriangleAlert } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { ApiError } from '@/api/client'
import { LinkPage, useLinkToken } from '@/components/LinkPage'
import { Button, ButtonLink } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'
import { resetPassword } from '@/lib/session'

/** Choose a new password, from the link in the "Reset your Reroute password" email. */
export default function ResetPassword() {
  const token = useLinkToken()
  const [password, setPassword] = useState('')
  const [show, setShow] = useState(false)
  const [error, setError] = useState<string>()
  const [problem, setProblem] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setProblem(undefined)
    if (password.length < 8) return setError('Use at least 8 characters.')
    setError(undefined)
    setBusy(true)
    try {
      await resetPassword(token!, password)
      setDone(true)
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : "Couldn't reach Reroute. Check your connection and try again.")
    } finally {
      setBusy(false)
    }
  }

  if (!token)
    return (
      <LinkPage title="Reset your password">
        <p className="flex items-start gap-2 t-body text-ink-2">
          <TriangleAlert size={20} strokeWidth={1.75} aria-hidden="true" className="mt-0.5 shrink-0 text-red-ink" />
          This link is incomplete. Open it again from the email, or ask for a new one from Sign in.
        </p>
        <ButtonLink to="/signin" variant="secondary" full className="mt-4">
          Go to sign in
        </ButtonLink>
      </LinkPage>
    )

  if (done)
    return (
      <LinkPage title="Password changed">
        <p role="status" className="flex items-start gap-2 t-body text-ink-2">
          <CircleCheck size={20} strokeWidth={1.75} aria-hidden="true" className="mt-0.5 shrink-0 text-green-ink" />
          Your new password is set. For your safety, you’re signed out everywhere: sign in with it now.
        </p>
        <ButtonLink to="/signin" full className="mt-4">
          Sign in
        </ButtonLink>
      </LinkPage>
    )

  return (
    <LinkPage title="Choose a new password">
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <Field
          label="New password"
          type={show ? 'text' : 'password'}
          autoComplete="new-password"
          hint="At least 8 characters."
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={error}
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
            {problem}
          </p>
        )}
        <Button type="submit" full loading={busy} loadingLabel="Saving…">
          Set my new password
        </Button>
      </form>
    </LinkPage>
  )
}
