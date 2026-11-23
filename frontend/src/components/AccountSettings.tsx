import { ChevronRight, Download, FileText, KeyRound, ShieldCheck, UserPen } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router'
import { api, ApiError } from '@/api/client'
import { keys, queryClient } from '@/api/queries'
import type { User } from '@/api/types'
import { Button } from '@/components/ui/Button'
import { Field, FieldError } from '@/components/ui/Field'
import { Sheet } from '@/components/ui/Sheet'
import { Banner } from '@/components/ui/States'
import { useOnline } from '@/lib/hooks'
import { native } from '@/lib/platform'
import { changePassword, deleteAccount } from '@/lib/session'
import { showToast } from '@/lib/store'

const row = 'flex min-h-14 w-full items-center gap-3 px-4 py-3 text-left t-title text-ink [@media(hover:hover)]:hover:bg-sunken/60 disabled:opacity-50'
const icon = { size: 20, strokeWidth: 1.75, 'aria-hidden': true, className: 'text-muted' } as const

function message(err: unknown, fallback: string) {
  return err instanceof ApiError ? err.message : fallback
}

/** "Confirm your email": shown until the address is confirmed, where the server sends email. */
export function VerifyEmailBanner({ user }: { user: User }) {
  const [busy, setBusy] = useState(false)
  if (user.emailVerified || !user.features.email || user.isDemo) return null
  const resend = async () => {
    setBusy(true)
    try {
      await api.post('/v1/me/verification-email', {})
      showToast({ title: `Sent. Open the link in the email to ${user.email}.` })
    } catch (err) {
      showToast({ title: message(err, "Couldn't send it. Try again.") })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="mt-3">
      <Banner
        tone="info"
        action={
          <Button variant="secondary" size="md" loading={busy} loadingLabel="Sending…" onClick={() => void resend()}>
            Send the link again
          </Button>
        }
      >
        Confirm your email: open the link we sent to {user.email}.
      </Banner>
    </div>
  )
}

/** Your name, as Reroute shows it. */
function NameSheet({ user, open, onOpenChange }: { user: User; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [name, setName] = useState(user.name)
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (open) {
      setName(user.name)
      setError(undefined)
    }
  }, [open, user.name])
  const save = async () => {
    if (!name.trim()) return setError('Enter your name.')
    setBusy(true)
    try {
      queryClient.setQueryData(keys.me, await api.patch<User>('/v1/me', { name: name.trim() }))
      onOpenChange(false)
      showToast({ title: 'Name saved.' })
    } catch (err) {
      setError(message(err, "Couldn't save it. Try again."))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Your name"
      footer={
        <Button full loading={busy} loadingLabel="Saving…" onClick={() => void save()}>
          Save
        </Button>
      }
    >
      <Field label="Name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} error={error} maxLength={80} />
    </Sheet>
  )
}

function PasswordSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [errors, setErrors] = useState<{ current?: string; next?: string; form?: string }>({})
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (open) {
      setCurrent('')
      setNext('')
      setErrors({})
    }
  }, [open])
  const save = async () => {
    const e: typeof errors = {}
    if (!current) e.current = 'Enter your current password.'
    if (next.length < 8) e.next = 'Use at least 8 characters.'
    else if (next === current) e.next = 'Choose a password different from the current one.'
    setErrors(e)
    if (Object.keys(e).length) return
    setBusy(true)
    try {
      await changePassword(current, next)
      onOpenChange(false)
      showToast({ title: 'Password changed. You’re signed out on your other devices.' })
    } catch (err) {
      if (err instanceof ApiError && err.code === 'WRONG_PASSWORD') setErrors({ current: err.message })
      else setErrors({ form: message(err, "Couldn't change it. Try again.") })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Change your password"
      description="Every other phone and browser signed in to your account is signed out."
      footer={
        <div className="flex flex-col gap-2">
          {errors.form && <FieldError id="password-err">{errors.form}</FieldError>}
          <Button full loading={busy} loadingLabel="Changing…" onClick={() => void save()}>
            Change my password
          </Button>
        </div>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        {/* Lets a password manager tie the new password to this account. */}
        <input type="text" name="username" autoComplete="username" hidden readOnly value={queryClient.getQueryData<User>(keys.me)?.email ?? ''} />
        <Field label="Current password" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} error={errors.current} maxLength={128} />
        <Field label="New password" type="password" autoComplete="new-password" hint="At least 8 characters." value={next} onChange={(e) => setNext(e.target.value)} error={errors.next} maxLength={128} />
      </form>
    </Sheet>
  )
}

function DeleteSheet({ user, open, onOpenChange }: { user: User; open: boolean; onOpenChange: (o: boolean) => void }) {
  const navigate = useNavigate()
  const [proof, setProof] = useState('')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (open) {
      setProof('')
      setError(undefined)
    }
  }, [open])
  const remove = async () => {
    if (!proof.trim()) return setError(user.hasPassword ? 'Enter your password.' : 'Type your email address.')
    setBusy(true)
    try {
      await deleteAccount(user.hasPassword ? { password: proof } : { email: proof.trim() })
      // Sign in has no toasts (they live in the signed-in app): it says so itself.
      navigate('/signin', { replace: true, state: { notice: 'Your account and everything kept with it are deleted.' } })
    } catch (err) {
      setError(message(err, "Couldn't delete it. Try again."))
      setBusy(false)
    }
  }
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Delete your account?"
      description="This deletes your account and everything kept with it, at once: trips, tasks, plans, check-ins, bookings, the wallet, your places and your recorded Raasta rides."
      footer={
        <div className="flex flex-col gap-2">
          <Button variant="destructive" full loading={busy} loadingLabel="Deleting…" onClick={() => void remove()}>
            Delete my account
          </Button>
          <Button variant="tertiary" size="md" className="self-center" onClick={() => onOpenChange(false)}>
            Keep it
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="t-small text-ink-2">
          Places you shared that everyone can find, and Raasta routes you added, stay without your name. This can’t be undone: download your data first if you want a copy.
        </p>
        {user.hasPassword ? (
          <Field label="Your password" type="password" autoComplete="current-password" value={proof} onChange={(e) => setProof(e.target.value)} error={error} maxLength={128} />
        ) : (
          <Field label={`Type ${user.email} to confirm`} type="email" autoComplete="off" value={proof} onChange={(e) => setProof(e.target.value)} error={error} maxLength={320} />
        )}
      </div>
    </Sheet>
  )
}

async function downloadData() {
  const res = await api.get<Response>('/v1/me/export', { raw: true })
  const text = await res.text()
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'reroute-data.json'
  // A web view can't download: the Android app saves the file itself.
  if (native.saveText) {
    const where = await native.saveText(name, text)
    return showToast({ title: where ? `Your data is saved to ${where}.` : "Couldn't save the file. Try again." })
  }
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  showToast({ title: 'Your data is downloaded.' })
}

function Row({ children, onClick, disabled, to }: { children: ReactNode; onClick?: () => void; disabled?: boolean; to?: string }) {
  return (
    <li>
      {to ? (
        <Link to={to} className={row}>
          {children}
        </Link>
      ) : (
        <button type="button" onClick={onClick} disabled={disabled} className={row}>
          {children}
        </button>
      )}
    </li>
  )
}

/** Me → Account: the name, the password, a copy of the data, the policies, and deleting the account. */
export function AccountSettings({ user }: { user: User }) {
  const online = useOnline()
  const [sheet, setSheet] = useState<'name' | 'password' | 'delete' | null>(null)
  const [downloading, setDownloading] = useState(false)
  const close = (o: boolean) => !o && setSheet(null)
  const download = async () => {
    setDownloading(true)
    try {
      await downloadData()
    } catch (err) {
      showToast({ title: message(err, "Couldn't download your data. Try again.") })
    } finally {
      setDownloading(false)
    }
  }
  return (
    <>
      <ul className="divide-y divide-line overflow-hidden rounded-card border border-line bg-surface">
        {!user.isDemo && (
          <Row onClick={() => setSheet('name')} disabled={!online}>
            <UserPen {...icon} />
            <span className="flex-1">Change your name</span>
            <ChevronRight {...icon} />
          </Row>
        )}
        {user.hasPassword && !user.isDemo && (
          <Row onClick={() => setSheet('password')} disabled={!online}>
            <KeyRound {...icon} />
            <span className="flex-1">Change your password</span>
            <ChevronRight {...icon} />
          </Row>
        )}
        <Row onClick={() => void download()} disabled={!online || downloading}>
          <Download {...icon} />
          <span className="flex-1">{downloading ? 'Preparing your data…' : 'Download your data'}</span>
        </Row>
        <Row to="/privacy">
          <ShieldCheck {...icon} />
          <span className="flex-1">Privacy policy</span>
          <ChevronRight {...icon} />
        </Row>
        <Row to="/terms">
          <FileText {...icon} />
          <span className="flex-1">Terms of use</span>
          <ChevronRight {...icon} />
        </Row>
      </ul>
      <NameSheet user={user} open={sheet === 'name'} onOpenChange={close} />
      <PasswordSheet open={sheet === 'password'} onOpenChange={close} />
      <DeleteSheet user={user} open={sheet === 'delete'} onOpenChange={close} />
      {!user.isDemo && (
        <Button variant="destructive" className="mt-4" onClick={() => setSheet('delete')} disabled={!online}>
          Delete my account
        </Button>
      )}
    </>
  )
}
