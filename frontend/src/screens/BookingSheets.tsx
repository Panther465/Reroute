import { ArrowRight, Bike, Car, CarTaxiFront, Check, Minus, Plane, Plus, Star, TrainFront } from 'lucide-react'
import { AutoRickshaw } from '@/components/icons'
import { useEffect, useId, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, ApiError } from '@/api/client'
import { useAirports, useMe } from '@/api/queries'
import type { Booking, CabOption, FlightOption, Task, TrainOption, Trip } from '@/api/types'
import { PartnerGate, PayFromWallet, useConnected, useShort } from '@/components/money/Money'
import { Button } from '@/components/ui/Button'
import { Field, FieldError } from '@/components/ui/Field'
import { Sheet } from '@/components/ui/Sheet'
import { Banner } from '@/components/ui/States'
import { Tag } from '@/components/ui/Tag'
import { book, cancelBooking, DEMO_NOTE, pause } from '@/lib/bookings'
import { useConnections } from '@/lib/partners'
import { useSubmitKey } from '@/lib/submitKey'
import { dayLabel } from '@/lib/timeline'
import { duration, rupees } from '@/lib/format'
import { announce, showToast } from '@/lib/store'

const demoBanner = <Banner tone="info">{DEMO_NOTE}</Banner>

/** A booking in progress: what's happening, step by step, with a spinner. */
function Processing({ steps, step }: { steps: string[]; step: number }) {
  return (
    <div role="status" className="flex flex-col gap-3 py-4">
      {steps.map((s, i) => (
        <p key={s} className={`flex items-center gap-3 t-body ${i <= step ? 'text-ink' : 'text-muted'}`}>
          <span aria-hidden="true" className={`flex size-6 items-center justify-center rounded-full ${i < step ? 'bg-green text-on-green' : i === step ? 'border-2 border-green border-t-transparent motion-safe:animate-spin' : 'border-2 border-line'}`}>
            {i < step && <Check size={14} strokeWidth={2.5} />}
          </span>
          {s}
        </p>
      ))}
    </div>
  )
}

type Person = { name: string; age: string }

/** Who's travelling: up to six, a name and an age each. */
function PassengerFields({ people, setPeople }: { people: Person[]; setPeople: (f: (ps: Person[]) => Person[]) => void }) {
  return (
    <div className="flex flex-col gap-4">
      {people.map((p, i) => (
        <div key={i} className="grid grid-cols-[1fr_6rem] gap-3">
          <Field label={`Passenger ${i + 1}`} value={p.name} onChange={(e) => setPeople((ps) => ps.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} autoComplete="name" />
          <Field label="Age" inputMode="numeric" value={p.age} onChange={(e) => setPeople((ps) => ps.map((x, j) => (j === i ? { ...x, age: e.target.value.replace(/\D/g, '').slice(0, 3) } : x)))} />
        </div>
      ))}
      <div className="flex gap-3">
        <Button variant="secondary" size="md" icon={<Plus size={18} aria-hidden="true" />} disabled={people.length >= 6} onClick={() => setPeople((ps) => [...ps, { name: '', age: '' }])}>
          Add a passenger
        </Button>
        {people.length > 1 && (
          <Button variant="tertiary" size="md" icon={<Minus size={18} aria-hidden="true" />} onClick={() => setPeople((ps) => ps.slice(0, -1))}>
            Remove the last
          </Button>
        )}
      </div>
    </div>
  )
}

const peopleReady = (people: Person[]) => people.every((p) => p.name.trim() && Number(p.age) >= 1 && Number(p.age) <= 120)

/** The traveller's own name, filled in once it loads. */
function useFirstPassenger(people: Person[], setPeople: (ps: Person[]) => void) {
  const me = useMe()
  useEffect(() => {
    if (me.data && !people[0].name) setPeople([{ name: me.data.name.replace(/\s*\(sample\)$/, ''), age: '' }])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me.data])
}

// ---------------------------------------------------------------------------
// Train ticket
// ---------------------------------------------------------------------------

type TrainStep = 'search' | 'pick' | 'passengers' | 'pay' | 'processing'

export function TrainBookingSheet({ trip, task, open, onOpenChange, onBooked }: { trip: Trip; task: Task; open: boolean; onOpenChange: (o: boolean) => void; onBooked: (b: Booking) => void }) {
  const connected = useConnected('railgo')
  const [step, setStep] = useState<TrainStep>('search')
  const [to, setTo] = useState('')
  const [query, setQuery] = useState('')
  const [train, setTrain] = useState<TrainOption | null>(null)
  const [cls, setCls] = useState<string | null>(null)
  const [people, setPeople] = useState<Person[]>([{ name: '', age: '' }])
  const [error, setError] = useState<string>()
  const [progress, setProgress] = useState(0)
  const { key, after } = useSubmitKey('bkg')
  const listId = useId()
  useFirstPassenger(people, setPeople)

  const trains = useQuery({
    queryKey: ['train-options', trip.tripId, task.taskId, query],
    queryFn: () => api.get<TrainOption[]>(`/v1/trips/${trip.tripId}/train-options`, { query: { taskId: task.taskId, to: query } }),
    enabled: query.length >= 2,
  })
  const chosen = train?.classes.find((c) => c.code === cls) ?? null
  const total = chosen ? chosen.fareInr * people.length : 0
  const short = useShort(total)

  const search = () => {
    if (to.trim().length < 2) return setError('Enter where you’re going, like Chennai.')
    setError(undefined)
    setQuery(to.trim())
    setStep('pick')
  }
  const pay = async () => {
    if (!train || !chosen) return
    setStep('processing')
    setError(undefined)
    try {
      setProgress(0)
      await pause(900)
      setProgress(1)
      const booking = await book(
        trip.tripId,
        { kind: 'train', taskId: task.taskId, destination: query, trainNo: train.trainNo, travelClass: chosen.code as 'SL', passengers: people.map((p) => ({ name: p.name.trim(), age: Number(p.age) })) },
        key,
      )
      await pause(800)
      setProgress(2)
      await pause(600)
      announce(`Ticket booked. PNR ${booking.reference}. ${String(booking.details.bookingStatus)}.`)
      onBooked(booking)
    } catch (err) {
      after(err)
      setError(err instanceof ApiError ? err.message : "Couldn't book the ticket. Try again.")
      setStep('pay')
    }
  }
  const peopleOk = peopleReady(people)

  const back = step === 'pick' ? 'search' : step === 'passengers' ? 'pick' : step === 'pay' ? 'passengers' : null
  const footer = !connected ? null : step === 'search' ? (
      <Button full onClick={search}>
        Find trains
      </Button>
    ) : step === 'pick' ? (
      <Button full disabled={!chosen} onClick={() => setStep('passengers')}>
        {chosen ? `Continue with ${chosen.label}` : 'Choose a train and class'}
      </Button>
    ) : step === 'passengers' ? (
      <Button full disabled={!peopleOk} onClick={() => setStep('pay')}>
        Review and pay
      </Button>
    ) : step === 'pay' ? (
      <Button full disabled={short} onClick={() => void pay()}>
        Pay {rupees(total)} from your wallet
      </Button>
    ) : null

  return (
    <Sheet open={open} onOpenChange={(o) => step !== 'processing' && onOpenChange(o)} title={<span className="inline-flex items-center gap-2"><TrainFront size={22} strokeWidth={1.75} aria-hidden="true" />Book your train ticket</span>} titleLang="en" description={`${task.title}, ${dayLabel(task.day)}, from ${task.place.name}.`} footer={footer && <div className="flex gap-3">{back && <Button variant="secondary" size="md" className="shrink-0" onClick={() => setStep(back)}>Back</Button>}<div className="flex-1">{footer}</div></div>}>
      <div className="flex flex-col gap-4">
        {demoBanner}
        {!connected && <PartnerGate id="railgo" />}
        {connected && step === 'search' && <Field label="Where to?" hint="The city or station, like Chennai or Mysuru" value={to} onChange={(e) => setTo(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && search()} autoComplete="off" />}
        {step === 'pick' && (
          <>
            {trains.isPending && <p className="t-body text-ink-2">Finding trains…</p>}
            {trains.isError && <FieldError id="trains-err">Couldn't find trains. Check your connection and try again.</FieldError>}
            {trains.data && (
              <fieldset>
                <legend className="mb-2 t-title text-ink">Trains to {query}, sample timetable</legend>
                <ul id={listId} className="flex flex-col gap-3">
                  {trains.data.map((t) => (
                    <li key={t.trainNo} className={`rounded-card border-2 p-4 ${train?.trainNo === t.trainNo ? 'border-green' : 'border-line'}`}>
                      <p className="flex flex-wrap items-baseline justify-between gap-x-3">
                        <span className="t-title text-ink">{t.name}</span>
                        <span className="t-small text-muted tnum">#{t.trainNo}</span>
                      </p>
                      <p className="mt-1 t-body text-ink tnum">
                        {t.departs} → {t.arrives}
                        {t.arrivesNextDay ? <span className="t-small text-ink-2"> (+{t.arrivesNextDay} day)</span> : null}
                        <span className="t-small text-ink-2">, {duration(t.durationMin)}</span>
                      </p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {t.classes.map((c) => {
                          const id = `${t.trainNo}-${c.code}`
                          const picked = train?.trainNo === t.trainNo && cls === c.code
                          return (
                            <label key={id} htmlFor={id} className={`flex min-h-12 cursor-pointer flex-col rounded-control border-2 px-3 py-1.5 ${picked ? 'border-green bg-green-tint' : 'border-line'}`}>
                              <input
                                id={id}
                                type="radio"
                                name="train-class"
                                className="sr-only"
                                checked={picked}
                                onChange={() => {
                                  setTrain(t)
                                  setCls(c.code)
                                }}
                              />
                              <span className="t-small font-bold text-ink">
                                {c.code} · {rupees(c.fareInr)}
                              </span>
                              <span className={`t-small ${c.status === 'available' ? 'text-green-ink' : c.status === 'rac' ? 'text-ink-2' : 'text-red-ink'}`}>{c.availability}</span>
                            </label>
                          )
                        })}
                      </div>
                    </li>
                  ))}
                </ul>
              </fieldset>
            )}
          </>
        )}
        {step === 'passengers' && <PassengerFields people={people} setPeople={setPeople} />}
        {step === 'pay' && train && chosen && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-card border border-line bg-surface p-4 t-body">
            <dt className="text-ink-2">Train</dt>
            <dd className="text-ink">{train.name} #{train.trainNo}</dd>
            <dt className="text-ink-2">When</dt>
            <dd className="text-ink tnum">{dayLabel(task.day)}, {train.departs} → {train.arrives}</dd>
            <dt className="text-ink-2">Class</dt>
            <dd className="text-ink">{chosen.label} ({chosen.availability})</dd>
            <dt className="text-ink-2">Passengers</dt>
            <dd className="text-ink">{people.map((p) => `${p.name.trim()} (${p.age})`).join(', ')}</dd>
            <dt className="t-title text-ink">Total</dt>
            <dd className="t-title text-ink tnum">{rupees(total)}</dd>
          </dl>
        )}
        {step === 'pay' && <PayFromWallet total={total} />}
        {step === 'processing' && <Processing steps={['Contacting RailGo (demo)', 'Reserving berths', 'Issuing your ticket']} step={progress} />}
        {error && <FieldError id="book-err">{error}</FieldError>}
      </div>
    </Sheet>
  )
}

// ---------------------------------------------------------------------------
// Cab ride
// ---------------------------------------------------------------------------

export function CabBookingSheet({ trip, toId, toName, open, onOpenChange, onBooked }: { trip: Trip; toId: string; toName: string; open: boolean; onOpenChange: (o: boolean) => void; onBooked: (b: Booking) => void }) {
  const [choice, setChoice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string>()
  const { key, after } = useSubmitKey('bkg')
  const options = useQuery({
    queryKey: ['cab-options', trip.tripId, toId],
    queryFn: () => api.get<CabOption[]>(`/v1/trips/${trip.tripId}/cab-options`, { query: { toId } }),
    enabled: open,
  })
  const connections = useConnections()
  const offered = options.data?.filter((o) => connections[o.provider]) ?? []
  const missing = [...new Set((options.data ?? []).filter((o) => !connections[o.provider]).map((o) => o.providerLabel))]
  const picked = offered.find((o) => o.optionId === choice) ?? null
  const short = useShort(picked?.fareInr ?? 0)

  const go = async () => {
    if (!picked) return
    setBusy(true)
    setError(undefined)
    try {
      setProgress(0)
      await pause(1200)
      setProgress(1)
      const booking = await book(trip.tripId, { kind: 'cab', toId, optionId: picked.optionId, passengers: [] }, key)
      await pause(900)
      setProgress(2)
      await pause(500)
      announce(`${picked.providerLabel} ${picked.vehicleLabel} booked. ${String(booking.details.driverName)} arrives in ${String(booking.details.etaMin)} minutes. OTP ${String(booking.details.otp)}.`)
      onBooked(booking)
    } catch (err) {
      after(err)
      // The ride may have gone ("isn't on offer any more"): show what's on offer now.
      if (err instanceof ApiError && err.status >= 400 && err.status < 500) void options.refetch()
      setError(err instanceof ApiError ? err.message : "Couldn't book the ride. Try again.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => !busy && onOpenChange(o)}
      title={<span className="inline-flex items-center gap-2"><Car size={22} strokeWidth={1.75} aria-hidden="true" />Book a ride</span>}
      titleLang="en"
      description={`To ${toName}.`}
      footer={!busy && offered.length > 0 && <Button full disabled={!picked || short} onClick={() => void go()}>{picked ? `Book ${picked.providerLabel} ${picked.vehicleLabel} · ${rupees(picked.fareInr)} (demo)` : 'Choose a ride'}</Button>}
    >
      <div className="flex flex-col gap-4">
        {demoBanner}
        {busy ? (
          <Processing steps={[`Asking ${picked?.providerLabel ?? 'the provider'} (demo)`, 'Finding your driver', 'Driver on the way']} step={progress} />
        ) : (
          <>
            {options.isPending && <p className="t-body text-ink-2">Finding rides…</p>}
            {options.isError && <FieldError id="cab-err">{options.error instanceof ApiError ? options.error.message : "Couldn't find rides. Try again."}</FieldError>}
            {options.data && offered.length === 0 && <PartnerGate id="ridenow" />}
            {options.data && offered.length > 0 && (
              <fieldset>
                <legend className="mb-2 t-title text-ink">Rides, cheapest first</legend>
                <div className="flex flex-col divide-y divide-line overflow-hidden rounded-card border border-line">
                  {offered.map((o) => (
                    <label key={o.optionId} className={`flex min-h-14 cursor-pointer items-center gap-3 px-4 py-3 ${choice === o.optionId ? 'bg-green-tint' : 'bg-surface'}`}>
                      <input type="radio" name="cab" className="size-5 accent-[var(--green)]" checked={choice === o.optionId} onChange={() => setChoice(o.optionId)} />
                      <span className="min-w-0 flex-1">
                        <span className="block t-title text-ink">
                          {o.providerLabel} {o.vehicleLabel}
                        </span>
                        <span className="block t-small text-ink-2">
                          {o.seats} {o.seats === 1 ? 'seat' : 'seats'}, pickup in {o.etaMin} min
                        </span>
                      </span>
                      <span className="t-title text-ink tnum">{rupees(o.fareInr)}</span>
                    </label>
                  ))}
                </div>
                {missing.length > 0 && <p className="mt-2 t-small text-muted">Connect {missing.join(' or ')} in Me for more rides.</p>}
              </fieldset>
            )}
            {picked && <PayFromWallet total={picked.fareInr} />}
          </>
        )}
        {error && <FieldError id="ride-err">{error}</FieldError>}
      </div>
    </Sheet>
  )
}

// ---------------------------------------------------------------------------
// Flight
// ---------------------------------------------------------------------------

type FlightStep = 'search' | 'pick' | 'passengers' | 'pay' | 'processing'
const selectClass = 'min-h-12 w-full rounded-control border-2 border-line-strong bg-surface px-3 t-body text-ink focus-visible:border-green focus-visible:outline-none'

export function FlightBookingSheet({ trip, open, onOpenChange, onBooked, initialTo }: { trip: Trip; open: boolean; onOpenChange: (o: boolean) => void; onBooked: (b: Booking) => void; initialTo?: string }) {
  const connected = useConnected('skyhop')
  const airports = useAirports(open)
  const [step, setStep] = useState<FlightStep>('search')
  const [from, setFrom] = useState('BLR')
  const [to, setTo] = useState(initialTo ?? 'DEL')
  const [date, setDate] = useState(trip.endDate)
  const [query, setQuery] = useState<{ from: string; to: string; date: string } | null>(null)
  const [flight, setFlight] = useState<FlightOption | null>(null)
  const [cabin, setCabin] = useState<'economy' | 'business' | null>(null)
  const [people, setPeople] = useState<Person[]>([{ name: '', age: '' }])
  const [error, setError] = useState<string>()
  const [progress, setProgress] = useState(0)
  const { key, after } = useSubmitKey('bkg')
  useFirstPassenger(people, setPeople)

  const flights = useQuery({
    queryKey: ['flight-options', trip.tripId, query?.from, query?.to, query?.date],
    queryFn: () => api.get<FlightOption[]>(`/v1/trips/${trip.tripId}/flight-options`, { query: { from: query!.from, to: query!.to, date: query!.date } }),
    enabled: !!query,
  })
  const fare = flight?.fares.find((f) => f.cabin === cabin) ?? null
  const total = fare ? fare.fareInr * people.length : 0
  const short = useShort(total)
  const city = (code: string) => airports.data?.find((a) => a.code === code)?.city ?? code

  const search = () => {
    if (from === to) return setError('Choose two different airports.')
    if (!date) return setError('Choose the day you fly.')
    setError(undefined)
    setQuery({ from, to, date })
    setFlight(null)
    setCabin(null)
    setStep('pick')
  }
  const pay = async () => {
    if (!flight || !fare || !query) return
    setStep('processing')
    setError(undefined)
    try {
      setProgress(0)
      await pause(900)
      setProgress(1)
      const booking = await book(
        trip.tripId,
        { kind: 'flight', origin: query.from, flightTo: query.to, flightDate: query.date, flightNo: flight.flightNo, cabin: fare.cabin, passengers: people.map((p) => ({ name: p.name.trim(), age: Number(p.age) })) },
        key,
      )
      await pause(800)
      setProgress(2)
      await pause(600)
      announce(`Flight booked. PNR ${booking.reference}.`)
      onBooked(booking)
    } catch (err) {
      after(err)
      setError(err instanceof ApiError ? err.message : "Couldn't book the flight. Try again.")
      setStep('pay')
    }
  }

  const back = step === 'pick' ? 'search' : step === 'passengers' ? 'pick' : step === 'pay' ? 'passengers' : null
  const footer = !connected ? null : step === 'search' ? (
      <Button full onClick={search}>
        Find flights
      </Button>
    ) : step === 'pick' ? (
      <Button full disabled={!fare} onClick={() => setStep('passengers')}>
        {fare && flight ? `Continue with ${flight.flightNo}, ${fare.label}` : 'Choose a flight and cabin'}
      </Button>
    ) : step === 'passengers' ? (
      <Button full disabled={!peopleReady(people)} onClick={() => setStep('pay')}>
        Review and pay
      </Button>
    ) : step === 'pay' ? (
      <Button full disabled={short} onClick={() => void pay()}>
        Pay {rupees(total)} from your wallet
      </Button>
    ) : null

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => step !== 'processing' && onOpenChange(o)}
      title={<span className="inline-flex items-center gap-2"><Plane size={22} strokeWidth={1.75} aria-hidden="true" />Book a flight</span>}
      titleLang="en"
      description="SkyHop flights between Indian cities (simulated)."
      footer={footer && <div className="flex gap-3">{back && <Button variant="secondary" size="md" className="shrink-0" onClick={() => setStep(back)}>Back</Button>}<div className="flex-1">{footer}</div></div>}
    >
      <div className="flex flex-col gap-4">
        {demoBanner}
        {!connected && <PartnerGate id="skyhop" />}
        {connected && step === 'search' && (
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-2">
              <span className="t-title text-ink">From</span>
              <select className={selectClass} value={from} onChange={(e) => setFrom(e.target.value)}>
                {(airports.data ?? [{ code: 'BLR', city: 'Bengaluru', name: '' }]).map((a) => (
                  <option key={a.code} value={a.code}>
                    {a.city} ({a.code})
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-2">
              <span className="t-title text-ink">To</span>
              <select className={selectClass} value={to} onChange={(e) => setTo(e.target.value)}>
                {(airports.data ?? [{ code: 'DEL', city: 'Delhi', name: '' }]).map((a) => (
                  <option key={a.code} value={a.code}>
                    {a.city} ({a.code})
                  </option>
                ))}
              </select>
            </label>
            <Field label="Day" type="date" value={date} onChange={(e) => setDate(e.target.value)} className="sm:col-span-2" />
          </div>
        )}
        {step === 'pick' && query && (
          <>
            {flights.isPending && <p className="t-body text-ink-2">Finding flights…</p>}
            {flights.isError && <FieldError id="flights-err">{flights.error instanceof ApiError ? flights.error.message : "Couldn't find flights. Try again."}</FieldError>}
            {flights.data && (
              <fieldset>
                <legend className="mb-2 t-title text-ink">
                  {city(query.from)} to {city(query.to)}, {dayLabel(query.date)}
                </legend>
                <ul className="flex flex-col gap-3">
                  {flights.data.map((f) => (
                    <li key={f.flightNo} className={`rounded-card border-2 p-4 ${flight?.flightNo === f.flightNo ? 'border-green' : 'border-line'}`}>
                      <p className="flex flex-wrap items-baseline justify-between gap-x-3">
                        <span className="t-title text-ink tnum">
                          {f.departs} <ArrowRight size={16} strokeWidth={2} aria-label="to" className="inline align-[-2px]" /> {f.arrives}
                          {f.arrivesNextDay ? <span className="t-small text-ink-2"> (+1 day)</span> : null}
                        </span>
                        <span className="t-small text-muted tnum">{f.flightNo}</span>
                      </p>
                      <p className="mt-1 t-small text-ink-2">
                        {duration(f.durationMin)}, {f.stops ? '1 stop' : 'non-stop'}
                      </p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {f.fares.map((c) => {
                          const id = `${f.flightNo}-${c.cabin}`
                          const picked = flight?.flightNo === f.flightNo && cabin === c.cabin
                          return (
                            <label key={id} htmlFor={id} className={`flex min-h-12 cursor-pointer flex-col rounded-control border-2 px-3 py-1.5 ${picked ? 'border-green bg-green-tint' : 'border-line'}`}>
                              <input
                                id={id}
                                type="radio"
                                name="flight-cabin"
                                className="sr-only"
                                checked={picked}
                                onChange={() => {
                                  setFlight(f)
                                  setCabin(c.cabin)
                                }}
                              />
                              <span className="t-small font-bold text-ink">
                                {c.label} · {rupees(c.fareInr)}
                              </span>
                              <span className={`t-small ${c.seatsLeft <= 5 ? 'text-red-ink' : 'text-green-ink'}`}>{c.seatsLeft} seats left</span>
                            </label>
                          )
                        })}
                      </div>
                    </li>
                  ))}
                </ul>
              </fieldset>
            )}
          </>
        )}
        {step === 'passengers' && <PassengerFields people={people} setPeople={setPeople} />}
        {step === 'pay' && flight && fare && query && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-card border border-line bg-surface p-4 t-body">
            <dt className="text-ink-2">Flight</dt>
            <dd className="text-ink">SkyHop {flight.flightNo}</dd>
            <dt className="text-ink-2">When</dt>
            <dd className="text-ink tnum">
              {dayLabel(query.date)}, {flight.departs} → {flight.arrives}
            </dd>
            <dt className="text-ink-2">Cabin</dt>
            <dd className="text-ink">{fare.label}</dd>
            <dt className="text-ink-2">Passengers</dt>
            <dd className="text-ink">{people.map((p) => `${p.name.trim()} (${p.age})`).join(', ')}</dd>
            <dt className="t-title text-ink">Total</dt>
            <dd className="t-title text-ink tnum">{rupees(total)}</dd>
          </dl>
        )}
        {step === 'pay' && <PayFromWallet total={total} />}
        {step === 'processing' && <Processing steps={['Contacting SkyHop (demo)', 'Holding your seats', 'Issuing your e-ticket']} step={progress} />}
        {error && <FieldError id="flight-err">{error}</FieldError>}
      </div>
    </Sheet>
  )
}

// ---------------------------------------------------------------------------
// A booking: the ticket or the ride, with Cancel
// ---------------------------------------------------------------------------

export function BookingSheet({ trip, booking, onOpenChange }: { trip: Trip; booking: Booking | null; onOpenChange: (o: boolean) => void }) {
  const [cancelling, setCancelling] = useState(false)
  if (!booking) return null
  const d = booking.details as Record<string, unknown>
  const cancelled = booking.status === 'cancelled'
  const cancel = async () => {
    setCancelling(true)
    try {
      const done = await cancelBooking(trip.tripId, booking.bookingId)
      showToast({ title: `Cancelled. ${rupees(Number(done.details.refundInr ?? 0))} is back in your wallet (simulated).` })
      onOpenChange(false)
    } catch (err) {
      showToast({ title: err instanceof ApiError ? err.message : "Couldn't cancel. Try again." })
    } finally {
      setCancelling(false)
    }
  }
  return (
    <Sheet
      open
      onOpenChange={onOpenChange}
      title={booking.kind === 'train' ? 'Your train ticket' : booking.kind === 'flight' ? 'Your flight' : 'Your ride'}
      footer={
        !cancelled && (
          <Button variant="destructive" full loading={cancelling} loadingLabel="Cancelling…" onClick={() => void cancel()}>
            {booking.kind === 'train' ? 'Cancel the ticket' : booking.kind === 'flight' ? 'Cancel the flight' : 'Cancel the ride'}
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-4">
        {demoBanner}
        {cancelled && <Banner tone="blocked">Cancelled. {rupees(Number(d.refundInr ?? 0))} went back to your wallet.</Banner>}
        {booking.kind === 'flight' ? (
          <div className="overflow-hidden rounded-card border border-line bg-surface">
            <div className="flex items-center justify-between gap-3 bg-ink px-4 py-3 text-on-ink">
              <span className="inline-flex items-center gap-2 t-title">
                <Plane size={18} strokeWidth={1.75} aria-hidden="true" />
                SkyHop {String(d.flightNo)}
              </span>
              <span className="t-small">{dayLabel(String(d.date))}</span>
            </div>
            <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 p-4">
              <div>
                <p className="font-display text-[2rem] font-extrabold leading-none text-ink [font-stretch:87.5%]">{String(d.origin)}</p>
                <p className="t-small text-ink-2">{String(d.originCity)}</p>
                <p className="t-time text-ink tnum">{String(d.departs)}</p>
              </div>
              <Plane size={22} strokeWidth={1.75} aria-hidden="true" className="text-muted" />
              <div className="text-right">
                <p className="font-display text-[2rem] font-extrabold leading-none text-ink [font-stretch:87.5%]">{String(d.destination)}</p>
                <p className="t-small text-ink-2">{String(d.destinationCity)}</p>
                <p className="t-time text-ink tnum">
                  {String(d.arrives)}
                  {Number(d.arrivesNextDay) ? <span className="t-small"> +1</span> : null}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 border-t border-dashed border-line-strong px-4 py-3">
              <Tag tone="ink">PNR {booking.reference}</Tag>
              <Tag tone="grey-outline">{String(d.cabinLabel)}</Tag>
              <span className="ml-auto t-title text-ink tnum">{rupees(booking.fareInr)}</span>
            </div>
            <ul className="divide-y divide-line border-t border-line">
              {(d.passengers as { name: string; age: number; seat: string }[]).map((p, i) => (
                <li key={i} className="flex items-center justify-between gap-3 px-4 py-2.5 t-body">
                  <span className="text-ink">
                    {p.name} <span className="t-small text-muted">({p.age})</span>
                  </span>
                  <span className="t-small font-bold text-ink tnum">Seat {p.seat}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : booking.kind === 'train' ? (
          <div className="overflow-hidden rounded-card border border-line bg-surface">
            <div className="flex items-center justify-between gap-3 bg-ink px-4 py-3 text-on-ink">
              <span className="t-title">{String(d.trainName)}</span>
              <span className="t-small tnum">#{String(d.trainNo)}</span>
            </div>
            <div className="grid grid-cols-2 gap-3 p-4">
              <div>
                <p className="t-small text-muted">From</p>
                <p className="t-title text-ink">{String(d.origin)}</p>
                <p className="t-time text-ink tnum">{String(d.departs)}</p>
              </div>
              <div className="text-right">
                <p className="t-small text-muted">To</p>
                <p className="t-title text-ink">{String(d.destination)}</p>
                <p className="t-time text-ink tnum">
                  {String(d.arrives)}
                  {Number(d.arrivesNextDay) ? <span className="t-small"> +1</span> : null}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 border-t border-dashed border-line-strong px-4 py-3">
              <Tag tone="ink">PNR {booking.reference}</Tag>
              <Tag tone={d.bookingStatus === 'Confirmed' ? 'green' : 'grey-outline'}>{String(d.bookingStatus)}</Tag>
              <Tag tone="grey-outline">{String(d.classLabel)}</Tag>
              <span className="ml-auto t-title text-ink tnum">{rupees(booking.fareInr)}</span>
            </div>
            <ul className="divide-y divide-line border-t border-line">
              {(d.passengers as { name: string; age: number; status: string; coach?: string; berth?: number; berthType?: string }[]).map((p, i) => (
                <li key={i} className="flex items-center justify-between gap-3 px-4 py-2.5 t-body">
                  <span className="text-ink">
                    {p.name} <span className="t-small text-muted">({p.age})</span>
                  </span>
                  <span className="t-small font-bold text-ink tnum">{p.coach ? `${p.coach}, berth ${p.berth} ${p.berthType}` : p.status}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="rounded-card border border-line bg-surface p-4">
            <div className="flex items-center gap-3">
              <span aria-hidden="true" className="flex size-12 shrink-0 items-center justify-center rounded-full bg-sunken text-ink">
                {d.vehicle === 'auto' ? <AutoRickshaw size={24} /> : d.vehicle === 'bike' ? <Bike size={24} strokeWidth={1.75} /> : <CarTaxiFront size={24} strokeWidth={1.75} />}
              </span>
              <div className="min-w-0 flex-1">
                <p className="t-title text-ink">{String(d.driverName)}</p>
                <p className="flex items-center gap-1 t-small text-ink-2">
                  <Star size={14} aria-hidden="true" className="fill-current text-ink-2" /> {String(d.rating)}, {String(d.providerLabel)} {String(d.vehicleLabel)}
                </p>
              </div>
              <span className="t-title text-ink tnum">{rupees(booking.fareInr)}</span>
            </div>
            <dl className="mt-4 grid grid-cols-2 gap-3">
              <div className="rounded-control bg-sunken p-3">
                <dt className="t-small text-muted">{String(d.vehicleModel)}</dt>
                <dd className="t-title text-ink tnum">{String(d.plate)}</dd>
              </div>
              <div className="rounded-control bg-sunken p-3">
                <dt className="t-small text-muted">OTP for the driver</dt>
                <dd className="t-time-lg text-ink tnum">{String(d.otp)}</dd>
              </div>
            </dl>
            {!cancelled && <p className="mt-3 t-small text-ink-2">Arrives in about {String(d.etaMin)} min at the pickup.</p>}
          </div>
        )}
      </div>
    </Sheet>
  )
}
