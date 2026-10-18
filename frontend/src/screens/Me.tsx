import { ChevronRight, History, Languages, LogOut, Moon, ShieldCheck, Sun, SunMoon } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { api, ApiError } from '@/api/client'
import { useCurrentTripId, useMe, useTrip } from '@/api/queries'
import { RerouteLog } from '@/components/RerouteLog'
import { Button } from '@/components/ui/Button'
import { Segmented, Switch } from '@/components/ui/Choice'
import { Sheet } from '@/components/ui/Sheet'
import { ErrorState, Skeleton } from '@/components/ui/States'
import { useOnline } from '@/lib/hooks'
import { useT } from '@/lib/i18n'
import { signOut } from '@/lib/session'
import { setState, showToast, useStore, type Lang, type Theme } from '@/lib/store'

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8" aria-label={title}>
      <h2 className="mb-3 t-title text-ink">{title}</h2>
      {children}
    </section>
  )
}

const notificationsSupported = typeof window !== 'undefined' && 'Notification' in window

export default function Me() {
  const t = useT()
  const navigate = useNavigate()
  const me = useMe()
  const current = useCurrentTripId()
  const trip = useTrip(current.tripId)
  const online = useOnline()
  const theme = useStore((s) => s.theme)
  const lang = useStore((s) => s.lang)
  const alerts = useStore((s) => s.leaveAlerts)
  const [confirm, setConfirm] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [log, setLog] = useState(false)
  const rowLink = 'flex min-h-14 items-center gap-3 px-4 py-3 t-title text-ink [@media(hover:hover)]:hover:bg-sunken/60'
  const user = me.data
  const moderator = user?.role === 'moderator' || user?.role === 'admin'

  const toggleAlerts = async (on: boolean) => {
    if (!on) return setState({ leaveAlerts: false })
    const permission = await Notification.requestPermission()
    if (permission === 'granted') {
      setState({ leaveAlerts: true })
      showToast({ title: "You'll get a notification 10 minutes before each leave-by time." })
    } else {
      setState({ leaveAlerts: false })
      showToast({ title: 'Notifications are off for Reroute in your browser settings. Leave-by alerts still show in the app.' })
    }
  }

  const deleteHistory = async () => {
    setDeleting(true)
    try {
      await api.delete('/v1/me/location-history')
      setConfirm(false)
      showToast({ title: 'Location history deleted.' })
    } catch (err) {
      showToast({ title: err instanceof ApiError ? err.message : "Couldn't delete it. Try again." })
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="mx-auto max-w-[560px] px-5 pb-10 pt-6 lg:max-w-[720px] lg:px-8 lg:pt-8">
      <h1 className="t-display-1 text-ink">{t('Me')}</h1>

      <Section title={t('Profile')}>
        {me.isPending ? (
          <Skeleton className="h-20 w-full rounded-card" />
        ) : me.isError && !user ? (
          <ErrorState message="Couldn't load your profile. Check your connection and try again." onRetry={() => me.refetch()} />
        ) : (
          user && (
            <div className="flex items-center gap-4 rounded-card border border-line bg-surface p-4">
              <span aria-hidden="true" className="flex size-12 shrink-0 items-center justify-center rounded-full bg-ink t-title text-on-ink">
                {user.name
                  .split(' ')
                  .filter((p) => /^[A-Za-z]/.test(p))
                  .slice(0, 2)
                  .map((p) => p[0])
                  .join('')}
              </span>
              <div className="min-w-0">
                <p className="t-title text-ink">{user.name}</p>
                <p className="truncate t-small text-ink-2">{user.email}</p>
                {user.isDemo && <p className="t-small text-muted">Demo account</p>}
              </div>
            </div>
          )
        )}
      </Section>

      <Section title={t('Language')}>
        <Segmented<Lang>
          label={t('Language')}
          hideLabel
          value={lang}
          onChange={(v) => setState({ lang: v })}
          options={[
            { value: 'en', label: 'English', icon: <Languages size={20} strokeWidth={1.75} aria-hidden="true" />, lang: 'en' },
            { value: 'hi', label: 'हिन्दी', lang: 'hi' },
          ]}
        />
      </Section>

      <Section title={t('Theme')}>
        <Segmented<Theme>
          label={t('Theme')}
          hideLabel
          value={theme}
          onChange={(v) => setState({ theme: v })}
          options={[
            { value: 'system', label: t('System'), icon: <SunMoon size={20} strokeWidth={1.75} aria-hidden="true" /> },
            { value: 'light', label: t('Light'), icon: <Sun size={20} strokeWidth={1.75} aria-hidden="true" /> },
            { value: 'dark', label: t('Dark'), icon: <Moon size={20} strokeWidth={1.75} aria-hidden="true" /> },
          ]}
        />
      </Section>

      {notificationsSupported && (
        <Section title={t('Notifications')}>
          <div className="rounded-card border border-line bg-surface px-4">
            <Switch label="Time to leave" description="A notification 10 minutes before each leave-by time, when Reroute isn't on screen" checked={alerts} onChange={(v) => void toggleAlerts(v)} />
          </div>
        </Section>
      )}

      <Section title="Your activity">
        <ul className="divide-y divide-line overflow-hidden rounded-card border border-line bg-surface">
          <li>
            <button type="button" onClick={() => setLog(true)} className={`${rowLink} w-full text-left`}>
              <History size={20} strokeWidth={1.75} aria-hidden="true" className="text-muted" />
              <span className="flex-1">{t('Reroute log')}</span>
              <ChevronRight size={20} strokeWidth={1.75} aria-hidden="true" className="text-muted" />
            </button>
          </li>
          {moderator && (
            <li>
              <Link to="/moderator" className={rowLink}>
                <ShieldCheck size={20} strokeWidth={1.75} aria-hidden="true" className="text-muted" />
                <span className="flex-1">Route checks</span>
                <ChevronRight size={20} strokeWidth={1.75} aria-hidden="true" className="text-muted" />
              </Link>
            </li>
          )}
        </ul>
      </Section>

      <div className="mt-10 flex flex-col items-start gap-3">
        <Button variant="destructive" onClick={() => setConfirm(true)} disabled={!online}>
          {t('Delete my location history')}
        </Button>
        <Button
          variant="secondary"
          icon={<LogOut size={20} strokeWidth={1.75} aria-hidden="true" />}
          onClick={async () => {
            await signOut()
            navigate('/signin')
          }}
        >
          {t('Sign out')}
        </Button>
      </div>

      <Sheet
        open={confirm}
        onOpenChange={setConfirm}
        title="Delete your location history?"
        description="This removes the places Reroute kept from your trips, from this phone and from Reroute. Your plans and the routes you added stay."
        footer={
          <div className="flex flex-col gap-2">
            <Button variant="destructive" full loading={deleting} loadingLabel="Deleting…" onClick={deleteHistory}>
              Delete my history
            </Button>
            <Button variant="tertiary" size="md" className="self-center" onClick={() => setConfirm(false)}>
              Keep it
            </Button>
          </div>
        }
      >
        <p className="t-small text-ink-2">This can't be undone.</p>
      </Sheet>
      <RerouteLog trip={trip.data} open={log} onOpenChange={setLog} />
    </div>
  )
}
