import * as Tabs from '@radix-ui/react-tabs'
import { ArrowDown, ArrowUp, Flag, MapPin, Plus, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useBlocker, useNavigate } from 'react-router'
import { api, ApiError, newKey } from '@/api/client'
import { useCurrentTripId, useStands, useTrip } from '@/api/queries'
import type { Body, Contribution, ContributionIn, VehicleType } from '@/api/types'
import { BackButton, useBack } from '@/components/BackButton'
import { LazyMap } from '@/components/LazyMap'
import { AutoRickshaw, ERickshaw } from '@/components/icons'
import { Button } from '@/components/ui/Button'
import { Segmented } from '@/components/ui/Choice'
import { Field, FieldError } from '@/components/ui/Field'
import { Sheet } from '@/components/ui/Sheet'
import { Banner } from '@/components/ui/States'
import { routeLine, type LngLat } from '@/lib/geo'
import { useSubmitKey } from '@/lib/submitKey'
import { useDocumentTitle, useOnline } from '@/lib/hooks'
import { T } from '@/lib/i18n'
import { showToast } from '@/lib/store'
import { PushedScreen } from './LegDetail'


interface PickedStand {
  key: string
  standId?: string
  name: string
  location: { lat: number; lng: number }
}

type Details = Pick<ContributionIn, 'vehicleType' | 'fareInr' | 'frequencyMin' | 'firstTrip' | 'lastTrip'>

function metres(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const dx = (b.lng - a.lng) * 111_320 * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180))
  const dy = (b.lat - a.lat) * 110_540
  return Math.hypot(dx, dy)
}

function RouteFields({ onSubmit, standCount, busy, error }: { onSubmit: (d: Details) => void; standCount: number; busy: boolean; error?: string }) {
  // A failed send shows next to the button and takes focus, so it isn't missed at the bottom of a long form.
  const errorRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (error) errorRef.current?.focus()
  }, [error])
  const [vehicle, setVehicle] = useState<VehicleType>('shared_auto')
  const [fare, setFare] = useState('')
  const [freq, setFreq] = useState('10')
  const [first, setFirst] = useState('07:00')
  const [last, setLast] = useState('21:00')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const submit = () => {
    const e: Record<string, string> = {}
    if (standCount < 2) e.stands = 'Add at least two stands, in the order the vehicle stops.'
    const f = Number(fare)
    if (!fare || !Number.isInteger(f) || f <= 0 || f > 2000) e.fare = 'Enter the fare a person pays, in whole rupees, up to ₹2,000.'
    const q = Number(freq)
    if (!freq || !Number.isInteger(q) || q < 1 || q > 180) e.freq = 'Enter the minutes between vehicles, from 1 to 180.'
    if (!first || !last) e.last = 'Enter roughly when the first and last ones leave.'
    else if (last <= first) e.last = 'The last one must leave after the first one.'
    setErrors(e)
    if (Object.keys(e).length) return
    onSubmit({ vehicleType: vehicle, fareInr: f, frequencyMin: q, firstTrip: first, lastTrip: last })
  }
  return (
    <div className="mt-6 flex flex-col gap-5">
      {errors.stands && <FieldError id="stands-err">{errors.stands}</FieldError>}
      <Segmented<VehicleType>
        label="Vehicle"
        value={vehicle}
        onChange={setVehicle}
        options={[
          { value: 'shared_auto', label: 'Shared auto', icon: <AutoRickshaw size={20} /> },
          { value: 'e_rickshaw', label: 'E-rickshaw', icon: <ERickshaw size={20} /> },
          { value: 'tempo', label: 'Tempo', icon: <AutoRickshaw size={20} /> },
        ]}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Fare, in rupees" inputMode="numeric" type="number" value={fare} onChange={(e) => setFare(e.target.value)} error={errors.fare} />
        <Field label="How often, in minutes" inputMode="numeric" type="number" value={freq} onChange={(e) => setFreq(e.target.value)} error={errors.freq} />
        <Field label="First one" type="time" value={first} onChange={(e) => setFirst(e.target.value)} />
        <Field label="Last one" type="time" value={last} onChange={(e) => setLast(e.target.value)} error={errors.last} />
      </div>
      <p className="rounded-control bg-sunken px-4 py-3 t-small text-ink">We trim the first and last 200 m of every ride.</p>
      <div>
        <Button full onClick={submit} loading={busy} loadingLabel="Sending…">
          <T k="Submit for checking" />
        </Button>
        {error && (
          <div ref={errorRef} tabIndex={-1} role="alert" className="outline-none">
            <FieldError id="add-route-err">{error}</FieldError>
          </div>
        )}
      </div>
    </div>
  )
}

function TapStands({ near, onSubmit, busy, error }: { near: string | null; onSubmit: (stands: PickedStand[], d: Details) => void; busy: boolean; error?: string }) {
  const [picked, setPicked] = useState<PickedStand[]>([])
  const [pending, setPending] = useState<{ lng: number; lat: number } | null>(null)
  const [newName, setNewName] = useState('')
  const stands = useStands(near, 5000)
  const known = stands.data?.items ?? []

  const toggle = (s: PickedStand) => setPicked((list) => (list.some((x) => x.key === s.key) ? list.filter((x) => x.key !== s.key) : [...list, s]))
  const move = (i: number, d: -1 | 1) =>
    setPicked((list) => {
      const n = [...list]
      ;[n[i], n[i + d]] = [n[i + d], n[i]]
      return n
    })

  const points = useMemo(
    () =>
      known.map((s) => {
        const n = picked.findIndex((p) => p.standId === s.standId)
        return {
          id: s.standId,
          lngLat: [s.location.lng, s.location.lat] as LngLat,
          kind: 'stand' as const,
          number: n >= 0 ? n + 1 : undefined,
          label: n >= 0 ? `${s.name}, stand ${n + 1}. Remove` : `Add ${s.name}`,
          onClick: () => toggle({ key: s.standId, standId: s.standId, name: s.name, location: s.location }),
        }
      }),
    [known, picked],
  )
  // A route being drawn is straight between the stands chosen: marked approximate.
  const lines = useMemo(() => routeLine('draft', picked.map((p) => [p.location.lng, p.location.lat] as LngLat), 'shared_auto', true), [picked])
  const rest = known.filter((s) => !picked.some((p) => p.standId === s.standId))

  return (
    <div>
      <p className="mt-4 t-body text-ink-2">Tap the stands in the order the vehicle stops. Tap an empty spot on the map to add a stand that isn't there yet.</p>
      <div className="mt-4">
        <LazyMap lines={lines} points={points} label="Map of stands. Tap a stand to add it." className="h-72" onMapClick={([lng, lat]) => setPending({ lng, lat })} />
      </div>
      {pending && (
        <div className="mt-4 rounded-card border border-line bg-surface p-4">
          <Field label="Name this stand" hint="What riders call it, like Forum Mall gate" value={newName} onChange={(e) => setNewName(e.target.value)} autoFocus />
          <div className="mt-3 flex gap-3">
            <Button
              size="md"
              disabled={newName.trim().length < 2}
              onClick={() => {
                toggle({ key: newKey('stand'), name: newName.trim(), location: pending })
                setPending(null)
                setNewName('')
              }}
            >
              Add the stand
            </Button>
            <Button variant="tertiary" size="md" onClick={() => setPending(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      <h2 className="mt-6 t-title text-ink">Your stands, in order</h2>
      {picked.length === 0 ? (
        <p className="mt-2 t-small text-ink-2">No stands yet.</p>
      ) : (
        <ol className="mt-3 divide-y divide-line overflow-hidden rounded-card border border-line bg-surface">
          {picked.map((s, i) => (
            <li key={s.key} className="flex items-center gap-2 py-1 pl-4 pr-1">
              <span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center rounded-full bg-green t-caption text-on-green">
                {i + 1}
              </span>
              <span className="min-w-0 flex-1 t-body text-ink">
                {s.name}
                {!s.standId && <span className="block t-small text-muted">New stand</span>}
              </span>
              <button type="button" aria-label={`Move ${s.name} up`} disabled={i === 0} onClick={() => move(i, -1)} className="flex size-12 items-center justify-center rounded-control disabled:opacity-30">
                <ArrowUp size={20} strokeWidth={1.75} aria-hidden="true" />
              </button>
              <button type="button" aria-label={`Move ${s.name} down`} disabled={i === picked.length - 1} onClick={() => move(i, 1)} className="flex size-12 items-center justify-center rounded-control disabled:opacity-30">
                <ArrowDown size={20} strokeWidth={1.75} aria-hidden="true" />
              </button>
              <button type="button" aria-label={`Remove ${s.name}`} onClick={() => toggle(s)} className="flex size-12 items-center justify-center rounded-control">
                <X size={20} strokeWidth={1.75} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ol>
      )}
      {rest.length > 0 && (
        <details className="mt-4">
          <summary className="flex min-h-12 items-center gap-2 t-title text-ink">
            <Plus size={20} strokeWidth={1.75} aria-hidden="true" />
            Pick a stand from the list
          </summary>
          <ul className="mt-2 divide-y divide-line overflow-hidden rounded-card border border-line bg-surface">
            {rest.map((s) => (
              <li key={s.standId}>
                <button type="button" onClick={() => toggle({ key: s.standId, standId: s.standId, name: s.name, location: s.location })} className="flex min-h-12 w-full items-center gap-3 px-4 py-2 text-left [@media(hover:hover)]:hover:bg-sunken">
                  <MapPin size={20} strokeWidth={1.75} aria-hidden="true" className="text-muted" />
                  <span className="t-body text-ink">{s.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
      <RouteFields standCount={picked.length} busy={busy} error={error} onSubmit={(d) => onSubmit(picked, d)} />
    </div>
  )
}

function mmss(s: number) {
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

interface GpsPoint {
  lat: number
  lng: number
  t: string
}

/** Record a ride with the phone's GPS. Location is used only while recording, and only with permission. */
function RecordRide({ onSubmit, busy, error, onDirty }: { onSubmit: (points: GpsPoint[], marks: PickedStand[], d: Details) => void; busy: boolean; error?: string; onDirty: (dirty: boolean) => void }) {
  const [phase, setPhase] = useState<'idle' | 'recording' | 'done'>('idle')
  const [secs, setSecs] = useState(0)
  const [points, setPoints] = useState<GpsPoint[]>([])
  const [marks, setMarks] = useState<PickedStand[]>([])
  const [geoError, setGeoError] = useState<string>()
  const lock = useRef<{ release: () => Promise<void> } | null>(null)
  const watch = useRef<number | null>(null)

  useEffect(() => {
    if (phase !== 'recording') return
    const id = setInterval(() => setSecs((s) => s + 1), 1000)
    return () => clearInterval(id)
  }, [phase])
  useEffect(
    () => () => {
      void lock.current?.release()
      if (watch.current !== null) navigator.geolocation?.clearWatch(watch.current)
    },
    [],
  )

  // Recording, or a finished ride that hasn't been sent: leaving would lose it.
  const dirty = phase === 'recording' || (phase === 'done' && points.length >= 2)
  useEffect(() => onDirty(dirty), [dirty, onDirty])

  const km = useMemo(() => points.reduce((n, p, i) => (i ? n + metres(points[i - 1], p) : 0), 0) / 1000, [points])

  const start = async () => {
    setGeoError(undefined)
    if (!('geolocation' in navigator)) return setGeoError("This phone can't share its location, so a ride can't be recorded. Tap the stands instead.")
    setPhase('recording')
    setSecs(0)
    setPoints([])
    setMarks([])
    watch.current = navigator.geolocation.watchPosition(
      (pos) => setPoints((p) => [...p, { lat: pos.coords.latitude, lng: pos.coords.longitude, t: new Date(pos.timestamp).toISOString() }]),
      (err) => {
        setGeoError(err.code === err.PERMISSION_DENIED ? 'Location is off for Reroute, so the ride can’t be recorded. Allow location, or tap the stands instead.' : 'We lost the GPS signal. Recording continues when it comes back.')
        if (err.code === err.PERMISSION_DENIED) setPhase('idle')
      },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 20_000 },
    )
    try {
      const wl = (navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } }).wakeLock
      lock.current = (await wl?.request('screen')) ?? null
    } catch {
      /* not supported; the note asks the rider to keep the screen on */
    }
  }

  const mark = () => {
    const last = points[points.length - 1]
    if (!last) return setGeoError('Waiting for the GPS signal before marking a stand.')
    // Two marks at the same spot are one stand.
    if (marks.some((m) => metres(m.location, last) < 30)) return showToast({ title: 'That stand is already marked.' })
    setMarks((m) => [...m, { key: newKey('mark'), name: `Stand ${m.length + 1}`, location: { lat: last.lat, lng: last.lng } }])
  }

  const finish = () => {
    setPhase('done')
    if (watch.current !== null) navigator.geolocation.clearWatch(watch.current)
    watch.current = null
    void lock.current?.release()
  }

  return (
    <div className="mt-4">
      <div className="rounded-card border border-line bg-surface p-6 text-center">
        <p className="t-caption text-ink-2">{phase === 'recording' ? 'Recording' : phase === 'done' ? 'Ride finished' : 'Ready'}</p>
        <p className="mt-2 font-display text-[4rem] font-bold leading-none tracking-[-0.01em] text-ink tnum [font-stretch:75%]" role="timer" aria-live="off">
          {mmss(secs)}
        </p>
        <p className="mt-2 t-body text-ink-2 tnum">About {km.toFixed(1)} km</p>
        <div className="mt-6 flex flex-col gap-3">
          {phase === 'idle' && (
            <Button full onClick={start}>
              Start recording
            </Button>
          )}
          {phase === 'recording' && (
            <div className="grid grid-cols-2 gap-3">
              <Button variant="secondary" icon={<Flag size={20} strokeWidth={1.75} aria-hidden="true" />} onClick={mark}>
                Mark a stand
              </Button>
              <Button onClick={finish}>Finish ride</Button>
            </div>
          )}
        </div>
      </div>
      {geoError && (
        <div className="mt-3">
          <Banner tone="info">{geoError}</Banner>
        </div>
      )}
      <p className="mt-3 t-small text-ink-2">Keep the screen on while you ride. Your location is used only while recording, and the first and last 200 m are trimmed.</p>
      {marks.length > 0 && (
        <ol className="mt-4 divide-y divide-line overflow-hidden rounded-card border border-line bg-surface">
          {marks.map((m, i) => (
            <li key={m.key} className="flex items-center gap-3 px-4 py-3">
              <span aria-hidden="true" className="flex size-7 items-center justify-center rounded-full bg-green t-caption text-on-green">
                {i + 1}
              </span>
              <span className="flex-1 t-body text-ink">{m.name}</span>
            </li>
          ))}
        </ol>
      )}
      {phase === 'done' && (points.length < 2 ? <p className="mt-4 t-body text-ink-2">We didn't get enough GPS points for this ride. Try again outdoors, or tap the stands instead.</p> : <RouteFields standCount={Math.max(2, marks.length)} busy={busy} error={error} onSubmit={(d) => onSubmit(points, marks, d)} />)}
    </div>
  )
}

export default function AddRoute() {
  const navigate = useNavigate()
  const back = useBack('/raasta')
  const online = useOnline()
  const current = useCurrentTripId()
  const trip = useTrip(current.tripId).data
  const near = trip ? `${trip.stayPlace.lng},${trip.stayPlace.lat}` : '77.5946,12.9716'
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const { key, after } = useSubmitKey('con')
  const [tab, setTab] = useState('tap')
  const [rideDirty, setRideDirty] = useState(false)
  const sent = useRef(false)
  useDocumentTitle('Add a route')

  // Ask before leaving with a ride being recorded or one that hasn't been sent.
  const blocker = useBlocker(({ currentLocation, nextLocation }) => rideDirty && !sent.current && currentLocation.pathname !== nextLocation.pathname)
  useEffect(() => {
    if (!rideDirty) return
    const warn = (e: BeforeUnloadEvent) => {
      if (sent.current) return
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [rideDirty])

  const send = async (body: Body<ContributionIn>) => {
    setBusy(true)
    setError(undefined)
    try {
      await api.post<Contribution>('/v1/raasta/contributions', body, { idempotencyKey: key })
      sent.current = true
      showToast({ title: "Sent for checking. We'll show it once it's verified." })
      navigate('/raasta')
    } catch (err) {
      after(err)
      setError(err instanceof ApiError ? err.message : "Couldn't send the route. Try again.")
    } finally {
      setBusy(false)
    }
  }

  const city = trip?.citySlug ?? 'bengaluru'
  const asStand = (s: PickedStand) => (s.standId ? { standId: s.standId } : { name: s.name, location: s.location })

  return (
    <PushedScreen>
      <header className="flex items-start gap-2">
        <BackButton onClick={back} />
        <h1 tabIndex={-1} className="pt-2 t-display-1 text-ink">
          <T k="Add a route" />
        </h1>
      </header>
      {!online && (
        <div className="mt-4">
          <Banner tone="offline">You're offline. You can add a route once you're back.</Banner>
        </div>
      )}
      {/* Both panels stay mounted, so switching tabs never stops a recording. */}
      <Tabs.Root value={tab} onValueChange={setTab} className="mt-4">
        <Tabs.List aria-label="How to add the route" className="flex gap-1 rounded-control bg-sunken p-1">
          {[
            ['tap', 'Tap stands'],
            ['record', 'Record a ride'],
          ].map(([v, l]) => (
            <Tabs.Trigger key={v} value={v} className="min-h-12 flex-1 rounded-[11px] border-2 border-transparent t-title text-ink-2 data-[state=active]:border-green data-[state=active]:bg-surface data-[state=active]:text-ink">
              {l}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        <Tabs.Content value="tap" forceMount hidden={tab !== 'tap'} className="outline-none">
          <TapStands near={near} busy={busy} error={tab === 'tap' ? error : undefined} onSubmit={(stands, d) => void send({ citySlug: city, kind: 'stands_tapped', ...d, stands: stands.map(asStand), points: null })} />
        </Tabs.Content>
        <Tabs.Content value="record" forceMount hidden={tab !== 'record'} className="outline-none">
          <RecordRide busy={busy} error={tab === 'record' ? error : undefined} onDirty={setRideDirty} onSubmit={(points, marks, d) => void send({ citySlug: city, kind: 'gps_ride', ...d, points, stands: marks.length >= 2 ? marks.map(asStand) : null })} />
        </Tabs.Content>
      </Tabs.Root>
      <Sheet
        open={blocker.state === 'blocked'}
        onOpenChange={(o) => !o && blocker.state === 'blocked' && blocker.reset()}
        title="Leave this ride?"
        description="Your ride isn't sent. If you leave now, it's lost."
        footer={
          <div className="flex flex-col gap-2">
            <Button variant="destructive" full onClick={() => blocker.state === 'blocked' && blocker.proceed()}>
              Leave without sending
            </Button>
            <Button variant="tertiary" size="md" className="self-center" onClick={() => blocker.state === 'blocked' && blocker.reset()}>
              Stay
            </Button>
          </div>
        }
      >
        <p className="t-small text-ink-2">Recording stops when you leave this screen.</p>
      </Sheet>
    </PushedScreen>
  )
}
