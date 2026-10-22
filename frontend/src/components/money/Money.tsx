// The wallet and the connected services: simulated money, invented partners. Shared by Me and the booking sheets.
import { Check, ChevronRight, Plus, Wallet as WalletIcon } from 'lucide-react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useState } from 'react'
import { ApiError } from '@/api/client'
import { useWallet } from '@/api/queries'
import type { WalletEntry } from '@/api/types'
import { Button } from '@/components/ui/Button'
import { Field, FieldError } from '@/components/ui/Field'
import { Sheet } from '@/components/ui/Sheet'
import { Tag } from '@/components/ui/Tag'
import { rupees } from '@/lib/format'
import { EASE_OUT } from '@/lib/motion'
import { connect, disconnect, partner, PARTNERS, useConnected, useConnections, type Partner, type PartnerId } from '@/lib/partners'
import { announce } from '@/lib/store'
import { topUp, useCountUp } from '@/lib/wallet'

const CHIPS = [500, 1000, 2000, 5000]

/** A tick that draws itself in: the moment something simulated succeeds. */
function DoneTick({ label }: { label: string }) {
  const reduce = !!useReducedMotion()
  return (
    <div role="status" className="flex flex-col items-center gap-3 py-6 text-center">
      <motion.span
        className="flex size-16 items-center justify-center rounded-full bg-green text-on-green"
        initial={reduce ? false : { transform: 'scale(0.9)', opacity: 0 }}
        animate={{ transform: 'scale(1)', opacity: 1 }}
        transition={{ type: 'spring', duration: 0.45, bounce: 0.35 }}
      >
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <motion.path d="M5 12.5l4.5 4.5L19 7.5" initial={reduce ? false : { pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ delay: 0.12, duration: 0.32, ease: EASE_OUT }} />
        </svg>
      </motion.span>
      <p className="t-title text-ink">{label}</p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Adding money
// ---------------------------------------------------------------------------

/** Add simulated money. `need`, when a booking is short, picks the smallest chip that covers it. */
export function AddMoneySheet({ open, onOpenChange, need }: { open: boolean; onOpenChange: (o: boolean) => void; need?: number }) {
  const wallet = useWallet(open)
  const start = need ? (CHIPS.find((c) => c >= need) ?? Math.ceil(need / 100) * 100) : 1000
  const [amount, setAmount] = useState(String(start))
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<number | null>(null)
  const [error, setError] = useState<string>()
  const n = Number(amount)
  const valid = Number.isInteger(n) && n >= 100 && n <= 50000

  const add = async () => {
    if (!valid) return setError('Add between ₹100 and ₹50,000.')
    setBusy(true)
    setError(undefined)
    try {
      const w = await topUp(n)
      setDone(w.balanceInr)
      announce(`Added ${rupees(n)}. Your balance is ${rupees(w.balanceInr)}.`)
      setTimeout(() => {
        onOpenChange(false)
        setDone(null)
      }, 1100)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add money. Try again.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => !busy && onOpenChange(o)}
      title="Add money"
      description="Simulated money for simulated bookings. No card or bank is charged."
      footer={done === null && <Button full loading={busy} loadingLabel="Adding…" disabled={!valid} onClick={() => void add()}>{valid ? `Add ${rupees(n)}` : 'Choose an amount'}</Button>}
    >
      {done !== null ? (
        <DoneTick label={`Added. Your balance is ${rupees(done)}.`} />
      ) : (
        <div className="flex flex-col gap-4">
          {wallet.data && <p className="t-body text-ink-2">Balance now: <span className="font-bold text-ink tnum">{rupees(wallet.data.balanceInr)}</span>{need ? <>. This booking needs {rupees(need)} more.</> : null}</p>}
          <div className="flex flex-wrap gap-2" role="group" aria-label="Amounts">
            {CHIPS.map((c) => (
              <button
                key={c}
                type="button"
                aria-pressed={n === c}
                onClick={() => setAmount(String(c))}
                className={`min-h-12 rounded-full border-2 px-4 t-title tnum transition-[background-color,border-color,scale] duration-[var(--dur-quick)] motion-safe:active:scale-[0.97] ${n === c ? 'border-green bg-green-tint text-ink' : 'border-line-strong text-ink [@media(hover:hover)]:hover:bg-sunken'}`}
              >
                {rupees(c)}
              </button>
            ))}
          </div>
          <Field label="Or another amount, in rupees" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, '').slice(0, 5))} />
          {error && <FieldError id="topup-err">{error}</FieldError>}
        </div>
      )}
    </Sheet>
  )
}

// ---------------------------------------------------------------------------
// Connecting a partner
// ---------------------------------------------------------------------------

function PartnerMark({ p, size = 40 }: { p: Partner; size?: number }) {
  return (
    <span aria-hidden="true" className="flex shrink-0 items-center justify-center rounded-full bg-sunken text-ink" style={{ width: size, height: size }}>
      <p.Icon size={size * 0.5} strokeWidth={1.75} />
    </span>
  )
}

/** A pretend sign-in to a pretend partner: what connecting allows, then "Connected". */
export function ConnectSheet({ id, open, onOpenChange }: { id: PartnerId | null; open: boolean; onOpenChange: (o: boolean) => void }) {
  const p = id ? partner(id) : undefined
  const [state, setStateLocal] = useState<'ask' | 'busy' | 'done'>('ask')
  if (!p) return null
  const go = () => {
    setStateLocal('busy')
    setTimeout(() => {
      connect(p.id)
      setStateLocal('done')
      announce(`${p.name} connected.`)
      setTimeout(() => {
        onOpenChange(false)
        setStateLocal('ask')
      }, 1000)
    }, 1100)
  }
  return (
    <Sheet
      open={open}
      onOpenChange={(o) => state !== 'busy' && onOpenChange(o)}
      title={`Connect ${p.name}`}
      description="A simulated partner: nothing real is linked, and you can disconnect it in Me."
      footer={state === 'ask' && <Button full onClick={go}>Connect {p.name}</Button>}
    >
      {state === 'done' ? (
        <DoneTick label={`${p.name} is connected`} />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <PartnerMark p={p} size={48} />
            <div>
              <p className="t-title text-ink">{p.name}</p>
              <p className="t-small text-ink-2">{p.what}</p>
            </div>
            <Tag tone="grey-outline" className="ml-auto">Simulated</Tag>
          </div>
          <p className="t-body text-ink-2">Reroute will be able to {p.lets}, paid from your wallet. Your name and the trip details go with each booking.</p>
          {state === 'busy' && (
            <p role="status" className="flex items-center gap-2 t-body text-ink">
              <span aria-hidden="true" className="size-5 rounded-full border-2 border-green border-t-transparent motion-safe:animate-spin" />
              Connecting to {p.name}…
            </p>
          )}
        </div>
      )}
    </Sheet>
  )
}

/** In a booking sheet: this partner isn't connected yet, so connect it first. */
export function PartnerGate({ id }: { id: PartnerId }) {
  const p = partner(id)!
  const [open, setOpen] = useState(false)
  return (
    <div className="flex flex-col items-start gap-3 rounded-card border border-line bg-surface p-4">
      <div className="flex items-center gap-3">
        <PartnerMark p={p} />
        <div>
          <p className="t-title text-ink">Connect {p.name} to book</p>
          <p className="t-small text-ink-2">Reroute books {p.what.toLowerCase()} through {p.name} (simulated).</p>
        </div>
      </div>
      <Button variant="primary" size="md" onClick={() => setOpen(true)}>
        Connect {p.name}
      </Button>
      <ConnectSheet id={id} open={open} onOpenChange={setOpen} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Paying from the wallet, in a booking sheet
// ---------------------------------------------------------------------------

/** What this booking does to the balance; when it's short, how much to add, with the button that adds it. */
export function PayFromWallet({ total }: { total: number }) {
  const wallet = useWallet()
  const [adding, setAdding] = useState(false)
  if (!wallet.data) return null
  const balance = wallet.data.balanceInr
  const short = total - balance
  return (
    <div className={`flex flex-col gap-2 rounded-card border p-4 ${short > 0 ? 'border-red bg-red-tint' : 'border-line bg-surface'}`}>
      <p className="flex items-center gap-2 t-body text-ink">
        <WalletIcon size={20} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-ink-2" />
        {short > 0 ? (
          <span>
            Your wallet has {rupees(balance)}: <span className="font-bold">add {rupees(short)}</span> to book this.
          </span>
        ) : (
          <span>
            Paid from your wallet: {rupees(balance)} now, <span className="font-bold tnum">{rupees(balance - total)}</span> after.
          </span>
        )}
      </p>
      {short > 0 && (
        <Button variant="secondary" size="md" className="self-start" icon={<Plus size={18} aria-hidden="true" />} onClick={() => setAdding(true)}>
          Add money
        </Button>
      )}
      <AddMoneySheet open={adding} onOpenChange={setAdding} need={short > 0 ? short : undefined} />
    </div>
  )
}

/** True when the wallet can't pay `total` (unknown counts as able: the server has the last word). */
export function useShort(total: number) {
  const wallet = useWallet()
  return !!wallet.data && wallet.data.balanceInr < total
}

// ---------------------------------------------------------------------------
// Me: the wallet and the connected services
// ---------------------------------------------------------------------------

const KIND: Record<WalletEntry['kind'], string> = { welcome: 'Welcome', topup: 'Added', booking: 'Booking', refund: 'Refund' }

export function WalletPanel() {
  const wallet = useWallet()
  const reduce = !!useReducedMotion()
  const [adding, setAdding] = useState(false)
  const balance = useCountUp(wallet.data?.balanceInr ?? 0)
  return (
    <div className="rounded-card border border-line bg-surface">
      <div className="flex flex-wrap items-end justify-between gap-3 p-4">
        <div>
          <p className="t-small text-muted">Balance (simulated money)</p>
          <p className="font-display text-[2.25rem] font-extrabold leading-none text-ink tnum [font-stretch:87.5%]" aria-live="polite">
            {wallet.data ? rupees(balance) : '…'}
          </p>
        </div>
        <Button size="md" icon={<Plus size={18} aria-hidden="true" />} onClick={() => setAdding(true)}>
          Add money
        </Button>
      </div>
      {!!wallet.data?.entries.length && (
        <ul className="divide-y divide-line border-t border-line">
          <AnimatePresence initial={false}>
            {wallet.data.entries.slice(0, 5).map((e) => (
              <motion.li
                key={e.entryId}
                layout={!reduce}
                initial={reduce ? false : { opacity: 0, transform: 'translateY(-6px)' }}
                animate={{ opacity: 1, transform: 'translateY(0px)' }}
                transition={{ duration: 0.24, ease: EASE_OUT }}
                className="flex items-center justify-between gap-3 px-4 py-3"
              >
                <span className="min-w-0">
                  <span className="block truncate t-body text-ink">{e.label}</span>
                  <span className="block t-small text-muted">{KIND[e.kind]}</span>
                </span>
                <span className={`t-title tnum ${e.amountInr > 0 ? 'text-green-ink' : 'text-ink'}`}>
                  {e.amountInr > 0 ? '+' : '−'}
                  {rupees(Math.abs(e.amountInr))}
                </span>
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}
      <AddMoneySheet open={adding} onOpenChange={setAdding} />
    </div>
  )
}

export function ConnectedServices() {
  const connections = useConnections()
  const [connecting, setConnecting] = useState<PartnerId | null>(null)
  return (
    <>
      <ul className="divide-y divide-line overflow-hidden rounded-card border border-line bg-surface">
        {PARTNERS.map((p) => {
          const on = !!connections[p.id]
          return (
            <li key={p.id} className="flex items-center gap-3 px-4 py-3">
              <PartnerMark p={p} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 t-title text-ink">
                  {p.name}
                  <Tag tone="grey-outline">Simulated</Tag>
                </span>
                <span className="block t-small text-ink-2">
                  {p.what}
                  {on && (
                    <span className="text-green-ink">
                      {' '}
                      · <Check size={14} strokeWidth={2.5} aria-hidden="true" className="inline align-[-2px]" /> Connected
                    </span>
                  )}
                </span>
              </span>
              {on ? (
                <Button variant="tertiary" size="md" onClick={() => disconnect(p.id)}>
                  Disconnect
                  <span className="sr-only"> {p.name}</span>
                </Button>
              ) : (
                <Button variant="secondary" size="md" icon={<ChevronRight size={18} aria-hidden="true" />} onClick={() => setConnecting(p.id)}>
                  Connect
                  <span className="sr-only"> {p.name}</span>
                </Button>
              )}
            </li>
          )
        })}
      </ul>
      <ConnectSheet id={connecting} open={connecting !== null} onOpenChange={(o) => !o && setConnecting(null)} />
    </>
  )
}

/** Is this partner connected? For booking sheets that gate on it. */
export { useConnected }
