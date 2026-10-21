import { ChevronRight, History, Languages, LogOut, Luggage, Moon, ShieldCheck, Sun, SunMoon, Volume2 } from 'lucide-react'
import { useId, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { api, ApiError } from '@/api/client'
import { useCurrentTripId, useMe, useTrip } from '@/api/queries'
import { RerouteLog } from '@/components/RerouteLog'
import { TripSwitcher } from '@/components/TripSwitcher'
import { Button } from '@/components/ui/Button'
import { inputClass } from '@/components/ui/Field'
import { Segmented, Switch } from '@/components/ui/Choice'
import { Sheet } from '@/components/ui/Sheet'
import { ErrorState, Skeleton } from '@/components/ui/States'
import { useDocumentTitle, useOnline } from '@/lib/hooks'
import { T, useTl } from '@/lib/i18n'
import { chime, raise, speak, VOICES } from '@/lib/alerts'
import { geolocationSupported, startTracking, stopTracking, useLocation } from '@/lib/location'
import { signOut } from '@/lib/session'
import { setState, showToast, useStore, type AlertPrefs, type ChimeStyle, type Lang, type Theme, type VoiceRate } from '@/lib/store'

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const heading = useTl()(title)
  const id = useId()
  return (
    <section className="mt-8" aria-labelledby={id}>
      <h2 id={id} lang={heading.lang} className="mb-3 t-title text-ink">
        {heading.text}
      </h2>
      {children}
    </section>
  )
}

const notificationsSupported = typeof window !== 'undefined' && 'Notification' in window
const vibrationSupported = typeof navigator !== 'undefined' && 'vibrate' in navigator

export default function Me() {
  const tl = useTl()
  const navigate = useNavigate()
  const me = useMe()
  const current = useCurrentTripId()
  const trip = useTrip(current.tripId)
  const online = useOnline()
  const theme = useStore((s) => s.theme)
  const lang = useStore((s) => s.lang)
  const alerts = useStore((s) => s.leaveAlerts)
  const alertPrefs = useStore((s) => s.alerts)
  const setAlerts = (patch: Partial<AlertPrefs>) => setState((s) => ({ alerts: { ...s.alerts, ...patch } }))
  const voiceSelectId = useId()
  const volumeId = useId()
  const location = useLocation()
  const [confirm, setConfirm] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [log, setLog] = useState(false)
  const [trips, setTrips] = useState(false)
  const rowLink = 'flex min-h-14 items-center gap-3 px-4 py-3 t-title text-ink [@media(hover:hover)]:hover:bg-sunken/60'
  const user = me.data
  const moderator = user?.role === 'moderator' || user?.role === 'admin'
  useDocumentTitle('Me')

  const toggleAlerts = async (on: boolean) => {
    if (!on) return setState({ leaveAlerts: false })
    let permission: NotificationPermission = 'denied'
    try {
      permission = await Notification.requestPermission()
    } catch {
      /* some browsers only allow asking from an installed app */
    }
    if (permission === 'granted') {
      setState({ leaveAlerts: true })
      showToast({ title: 'Leave-by alerts are on. They show while Reroute is open or in the background on this phone.' })
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
      <h1 tabIndex={-1} className="t-display-1 text-ink">
        <T k="Me" />
      </h1>

      <Section title="Profile">
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

      <Section title="Language">
        <Segmented<Lang>
          label={tl('Language').text}
          labelLang={tl('Language').lang}
          hideLabel
          value={lang}
          onChange={(v) => setState({ lang: v })}
          options={[
            { value: 'en', label: 'English', icon: <Languages size={20} strokeWidth={1.75} aria-hidden="true" />, lang: 'en' },
            { value: 'hi', label: 'हिन्दी', lang: 'hi' },
          ]}
        />
      </Section>

      <Section title="Theme">
        <Segmented<Theme>
          label={tl('Theme').text}
          labelLang={tl('Theme').lang}
          hideLabel
          value={theme}
          onChange={(v) => setState({ theme: v })}
          options={[
            { value: 'system', label: <T k="System" />, icon: <SunMoon size={20} strokeWidth={1.75} aria-hidden="true" /> },
            { value: 'light', label: <T k="Light" />, icon: <Sun size={20} strokeWidth={1.75} aria-hidden="true" /> },
            { value: 'dark', label: <T k="Dark" />, icon: <Moon size={20} strokeWidth={1.75} aria-hidden="true" /> },
          ]}
        />
      </Section>

      <Section title="Alerts">
        <p className="mb-3 t-small text-ink-2">Before you leave, when a task is about to end, when you're nearly there and when you arrive. Every alert also shows on screen.</p>
        <div className="divide-y divide-line rounded-card border border-line bg-surface px-4">
          <Switch label="Sound" description="A chime at each alert." checked={alertPrefs.sound} onChange={(v) => setAlerts({ sound: v })} />
          {alertPrefs.sound && (
            <div className="py-4">
              <Segmented<ChimeStyle>
                label="Chime"
                value={alertPrefs.chime}
                onChange={(c) => {
                  setAlerts({ chime: c })
                  void chime('nudge', c, alertPrefs.volume)
                }}
                options={[
                  { value: 'bell', label: 'Bell' },
                  { value: 'soft', label: 'Soft' },
                  { value: 'marimba', label: 'Wood' },
                  { value: 'digital', label: 'Beep' },
                ]}
              />
            </div>
          )}
          <Switch label="Roo’s voice" description="Roo reads each alert aloud in a natural voice. Without a connection, your phone’s own voice reads it." checked={alertPrefs.voice} onChange={(v) => setAlerts({ voice: v })} />
          {alertPrefs.voice && (
            <div className="flex flex-col gap-4 py-4">
              <div>
                <label htmlFor={voiceSelectId} className="mb-2 block t-title text-ink">
                  Voice
                </label>
                <select id={voiceSelectId} value={alertPrefs.voiceId} onChange={(e) => setAlerts({ voiceId: e.target.value })} className={inputClass}>
                  {VOICES.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label}
                    </option>
                  ))}
                </select>
              </div>
              <Segmented<VoiceRate>
                label="Speed"
                value={alertPrefs.voiceRate}
                onChange={(r) => setAlerts({ voiceRate: r })}
                options={[
                  { value: 'slow', label: 'Slow' },
                  { value: 'normal', label: 'Normal' },
                  { value: 'fast', label: 'Fast' },
                ]}
              />
              <Button variant="secondary" size="md" className="self-start" icon={<Volume2 size={20} strokeWidth={1.75} aria-hidden="true" />} onClick={() => void speak('Hi, I’m Roo. Time to leave for the bank in Koramangala.', alertPrefs)}>
                Hear Roo
              </Button>
            </div>
          )}
          {(alertPrefs.sound || alertPrefs.voice) && (
            <div className="py-4">
              <label htmlFor={volumeId} className="flex items-baseline justify-between t-title text-ink">
                Volume
                <span className="t-small text-ink-2 tnum">{Math.round(alertPrefs.volume * 100)}%</span>
              </label>
              <input
                id={volumeId}
                type="range"
                min={10}
                max={100}
                step={10}
                value={Math.round(alertPrefs.volume * 100)}
                onChange={(e) => setAlerts({ volume: Number(e.target.value) / 100 })}
                // A sample at the new level once the slider is let go.
                onPointerUp={() => alertPrefs.sound && void chime('nudge')}
                onKeyUp={() => alertPrefs.sound && void chime('nudge')}
                className="mt-2 h-11 w-full cursor-pointer accent-[var(--green)]"
              />
            </div>
          )}
          {vibrationSupported && <Switch label="Vibration" description="A short buzz." checked={alertPrefs.vibrate} onChange={(v) => setAlerts({ vibrate: v })} />}
          {notificationsSupported && (
            <Switch
              label={tl('Phone notifications').text}
              lang={tl('Phone notifications').lang}
              description="When Reroute is in the background. They show while it's open on this phone, not after it's closed."
              checked={alerts}
              onChange={(v) => void toggleAlerts(v)}
            />
          )}
        </div>
        <Button
          variant="secondary"
          size="md"
          className="mt-3"
          onClick={() => raise({ key: 'test', title: 'This is how Reroute tells you it’s time.', speech: 'Hi, it’s Roo. This is how I’ll tell you it’s time to go.' }, { force: true })}
        >
          Try an alert
        </Button>
      </Section>

      {geolocationSupported && (
        <Section title="Location">
          <div className="rounded-card border border-line bg-surface px-4">
            <Switch
              label="Show me on the map"
              description="Follows you while Reroute is open, to show where you are on the route and say when you're nearly there. Your location stays on this phone."
              checked={location.tracking && !location.simulated}
              onChange={async (v) => {
                if (!v) return stopTracking()
                if (!(await startTracking())) showToast({ title: location.error === 'denied' ? 'Location is off for Reroute in your browser settings.' : "Couldn't find your location. Try again outside or near a window." })
              }}
            />
          </div>
        </Section>
      )}

      <Section title="Your activity">
        <ul className="divide-y divide-line overflow-hidden rounded-card border border-line bg-surface">
          <li>
            <button type="button" onClick={() => setTrips(true)} className={`${rowLink} w-full text-left`}>
              <Luggage size={20} strokeWidth={1.75} aria-hidden="true" className="text-muted" />
              <span className="flex-1">Your trips</span>
              <ChevronRight size={20} strokeWidth={1.75} aria-hidden="true" className="text-muted" />
            </button>
          </li>
          <li>
            <button type="button" onClick={() => setLog(true)} className={`${rowLink} w-full text-left`}>
              <History size={20} strokeWidth={1.75} aria-hidden="true" className="text-muted" />
              <span className="flex-1">
                <T k="Reroute log" />
              </span>
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
          <T k="Delete my location history" />
        </Button>
        <Button
          variant="secondary"
          icon={<LogOut size={20} strokeWidth={1.75} aria-hidden="true" />}
          onClick={async () => {
            await signOut()
            navigate('/signin')
          }}
        >
          <T k="Sign out" />
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
      <TripSwitcher open={trips} onOpenChange={setTrips} />
    </div>
  )
}
