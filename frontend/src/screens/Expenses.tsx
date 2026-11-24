import { CircleAlert, Download, FileText, Info, PencilLine, Plus, ReceiptText, ScanLine, Sparkles, TriangleAlert, Wallet } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { api, ApiError } from '@/api/client'
import { keys, queryClient, useCurrentTripId, useExpenses, useTrip } from '@/api/queries'
import type { Expense, ExpenseAlert, ExpenseBook, ExpenseClaim, ExpenseDraft, Trip } from '@/api/types'
import { BudgetSheet } from '@/components/expenses/BudgetSheet'
import { ExpenseSheet, type SheetStart } from '@/components/expenses/ExpenseSheet'
import { Button, ButtonLink } from '@/components/ui/Button'
import { FieldError, inputClass } from '@/components/ui/Field'
import { Sheet } from '@/components/ui/Sheet'
import { EmptyState, ErrorState, LoadingRegion, Skeleton } from '@/components/ui/States'
import { Tag } from '@/components/ui/Tag'
import { categoryOf, paise, paymentOf, shrinkPhoto } from '@/lib/expenses'
import { useDocumentTitle, useOnline } from '@/lib/hooks'
import { askRico, ricoKeepsMoney, useRicoMoneyNudge } from '@/lib/ricoMoney'
import { native } from '@/lib/platform'
import { showToast } from '@/lib/store'
import { useSubmitKey } from '@/lib/submitKey'
import { dayLabel } from '@/lib/timeline'

const shortDay = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })

/** Save a file the server sends (a CSV): the Android app saves it itself, a browser downloads it. */
export async function saveDownload(path: string, fallbackName: string) {
  const res = await api.get<Response>(path, { raw: true })
  if (!res.ok) throw new ApiError(res.status, 'DOWNLOAD', "Couldn't download it. Try again.")
  const text = await res.text()
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? fallbackName
  if (native.saveText) {
    const where = await native.saveText(name, text)
    return showToast({ title: where ? `Saved to ${where}.` : "Couldn't save the file. Try again." })
  }
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  showToast({ title: `Downloaded ${name}.` })
}

function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-card border border-line bg-surface p-4 ${className}`}>{children}</div>
}

/** Spent so far, against the budget when there is one, and where the trip is heading. */
function Overview({ book, onBudget }: { book: ExpenseBook; onBudget: () => void }) {
  const t = book.totals
  const b = book.budget
  const share = b?.totalPaise ? Math.min(100, Math.round((100 * t.spentPaise) / b.totalPaise)) : null
  const over = b?.totalPaise ? t.spentPaise > b.totalPaise : false
  const heading = b?.totalPaise ? !over && t.forecastPaise > b.totalPaise : false
  return (
    <Card>
      <p className="t-small text-ink-2">Spent so far</p>
      <p className="font-display text-[length:calc(2.25rem*var(--grow-display))] font-extrabold leading-tight text-ink tnum [font-stretch:87.5%]">{paise(t.spentPaise)}</p>
      {b?.totalPaise ? (
        <div className="mt-2">
          <div
            role="progressbar"
            aria-label="Budget used"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={share ?? 0}
            aria-valuetext={`${paise(t.spentPaise)} of ${paise(b.totalPaise)}`}
            className="h-3 overflow-hidden rounded-full bg-sunken"
          >
            <div className={`h-full rounded-full ${over ? 'bg-red' : heading ? 'bg-yellow' : 'bg-green'}`} style={{ width: `${share}%` }} />
          </div>
          <p className="mt-2 t-small text-ink-2 tnum">
            {over ? `${paise(t.spentPaise - b.totalPaise)} over the ${paise(b.totalPaise)} budget` : `${paise(b.totalPaise - t.spentPaise)} left of ${paise(b.totalPaise)}`}
          </p>
        </div>
      ) : (
        <Button variant="tertiary" size="md" className="-ml-2 mt-1" onClick={onBudget}>
          {b ? 'Add a total budget' : 'Set a budget'}
        </Button>
      )}
      <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-line pt-4 tnum">
        <div>
          <dt className="t-small text-ink-2">The trip will likely cost</dt>
          <dd className="t-title text-ink">{paise(t.forecastPaise)}</dd>
        </div>
        <div>
          <dt className="t-small text-ink-2">Still planned</dt>
          <dd className="t-title text-ink">{paise(t.upcomingPaise)}</dd>
        </div>
        <div>
          <dt className="t-small text-ink-2">Ready to claim</dt>
          <dd className="t-title text-ink">{paise(t.toClaimPaise)}</dd>
        </div>
        <div>
          <dt className="t-small text-ink-2">The office owes you</dt>
          <dd className="t-title text-ink">{paise(t.owedToYouPaise)}</dd>
        </div>
      </dl>
    </Card>
  )
}

function Alerts({ alerts, onShow }: { alerts: ExpenseAlert[]; onShow: (ids: string[]) => void }) {
  if (!alerts.length) return null
  const look = { danger: ['bg-red-tint text-red-ink', CircleAlert], warn: ['bg-yellow text-on-yellow', TriangleAlert], info: ['bg-sunken text-ink', Info] } as const
  return (
    <section aria-labelledby="alerts-h" className="mt-6">
      <h2 id="alerts-h" className="sr-only">
        Needs your attention
      </h2>
      <ul className="flex flex-col gap-2">
        {alerts.map((a, i) => {
          const [cls, Icon] = look[a.level]
          return (
            <li key={i} className={`flex flex-wrap items-start gap-x-3 gap-y-1 rounded-card px-4 py-3 ${cls}`}>
              <Icon size={20} strokeWidth={1.75} aria-hidden="true" className="mt-0.5 shrink-0" />
              <p className="min-w-0 flex-1 t-small font-bold">{a.text}</p>
              {!!a.expenseIds?.length && (
                <button type="button" onClick={() => onShow(a.expenseIds ?? [])} className="min-h-12 -my-3 rounded-control px-2 t-small font-bold underline underline-offset-4">
                  Show
                </button>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/** Type it, scan it, or fill it in. */
function AddBar({ trip, scanning, onStart }: { trip: Trip; scanning: boolean; onStart: (s: SheetStart) => void }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState<'parse' | 'scan' | null>(null)
  const [error, setError] = useState<string>()
  const file = useRef<HTMLInputElement>(null)
  const { key, renew } = useSubmitKey('parse')
  const online = useOnline()

  const parse = async (e: FormEvent) => {
    e.preventDefault()
    if (!text.trim()) return onStart({ draft: null })
    setBusy('parse')
    setError(undefined)
    try {
      const draft = await api.post<ExpenseDraft>(`/v1/trips/${trip.tripId}/expenses/parse`, { text: text.trim() }, { idempotencyKey: key })
      renew()
      setText('')
      onStart({ draft })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't read that. Fill it in instead.")
    } finally {
      setBusy(null)
    }
  }

  const scan = async (picked: File | undefined) => {
    if (!picked) return
    setBusy('scan')
    setError(undefined)
    let photo: Blob | null = null
    try {
      photo = await shrinkPhoto(picked)
      const draft = await api.upload<ExpenseDraft>('POST', `/v1/trips/${trip.tripId}/expenses/scan`, photo)
      onStart({ draft, photo })
    } catch (err) {
      // Not readable: the photo still goes with the expense, typed in by hand.
      if (photo) {
        showToast({ title: err instanceof ApiError ? `${err.message} Fill it in, the photo is attached.` : "Couldn't read it. Fill it in, the photo is attached." })
        onStart({ draft: null, photo })
      } else setError(err instanceof Error ? err.message : "Couldn't open that photo.")
    } finally {
      setBusy(null)
      if (file.current) file.current.value = ''
    }
  }

  return (
    <section aria-labelledby="add-h" className="mt-6">
      <h2 id="add-h" className="t-title text-ink">
        Add an expense
      </h2>
      <form onSubmit={parse} className="mt-2 flex gap-2">
        <label htmlFor="expense-line" className="sr-only">
          Type an expense, like Lunch 350 cash
        </label>
        <input
          id="expense-line"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Lunch 350 cash at Truffles"
          maxLength={300}
          autoComplete="off"
          enterKeyHint="go"
          className={`${inputClass} min-w-0 flex-1`}
          aria-describedby={error ? 'add-err' : 'add-hint'}
        />
        <Button type="submit" size="md" loading={busy === 'parse'} loadingLabel="Reading…" disabled={!online || busy !== null} icon={<Sparkles size={20} strokeWidth={1.75} aria-hidden="true" />}>
          Add
        </Button>
      </form>
      {error ? (
        <FieldError id="add-err">{error}</FieldError>
      ) : (
        <p id="add-hint" className="mt-1 t-small text-muted">
          Say what, how much and how you paid. Reroute fills in the rest, and remembers how you file each shop.
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {scanning && (
          <>
            <input ref={file} type="file" accept="image/*" capture="environment" className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(e) => void scan(e.target.files?.[0])} />
            <Button variant="secondary" size="md" loading={busy === 'scan'} loadingLabel="Reading the receipt…" disabled={!online || busy !== null} icon={<ScanLine size={20} strokeWidth={1.75} aria-hidden="true" />} onClick={() => file.current?.click()}>
              Scan a receipt
            </Button>
          </>
        )}
        <Button variant="secondary" size="md" disabled={!online || busy !== null} icon={<PencilLine size={20} strokeWidth={1.75} aria-hidden="true" />} onClick={() => onStart({ draft: null })}>
          Fill it in
        </Button>
      </div>
    </section>
  )
}

function Breakdown({ book }: { book: ExpenseBook }) {
  const rows = book.totals.byCategory
  const total = rows.reduce((s, r) => s + r.paise, 0)
  if (!total) return null
  return (
    <section aria-labelledby="by-h" className="mt-8">
      <h2 id="by-h" className="t-title text-ink">
        Where it goes
      </h2>
      <ul className="mt-3 flex flex-col gap-3">
        {rows.map((r) => {
          const c = categoryOf(r.key as Expense['category'])
          const pct = Math.round((100 * r.paise) / total)
          return (
            <li key={r.key}>
              <div className="flex items-baseline justify-between gap-3 t-small">
                <span className="flex items-center gap-2 font-bold text-ink">
                  <c.Icon size={16} strokeWidth={1.75} aria-hidden="true" className="text-muted" />
                  {c.label}
                </span>
                <span className="text-ink-2 tnum">
                  {paise(r.paise)} · {pct}%
                </span>
              </div>
              <div aria-hidden="true" className="mt-1 h-2 overflow-hidden rounded-full bg-sunken">
                <div className="h-full rounded-full bg-green" style={{ width: `${Math.max(2, pct)}%` }} />
              </div>
            </li>
          )
        })}
      </ul>
      {book.insights.length > 0 && (
        <ul className="mt-4 flex flex-col gap-2" aria-label="What Reroute noticed">
          {book.insights.map((line) => (
            <li key={line} className="flex items-start gap-2 t-small text-ink-2">
              <Sparkles size={16} strokeWidth={1.75} aria-hidden="true" className="mt-0.5 shrink-0 text-green" />
              {line}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

const FLAG_TAGS = {
  estimate: { tone: 'sunken', text: 'Estimate' },
  needs_receipt: { tone: 'yellow', text: 'Needs a receipt' },
  over_limit: { tone: 'red', text: 'Over the limit' },
  possible_duplicate: { tone: 'yellow', text: 'Possible duplicate' },
} as const

function Row({ e, highlighted, onOpen }: { e: Expense; highlighted: boolean; onOpen: () => void }) {
  const c = categoryOf(e.category)
  const p = paymentOf(e.payment)
  const from = e.source === 'booking' ? 'Booking' : e.source === 'plan' ? 'From the plan' : null
  return (
    <li data-expense={e.expenseId}>
      <button
        type="button"
        onClick={onOpen}
        className={`flex w-full items-start gap-3 px-4 py-3 text-left [@media(hover:hover)]:hover:bg-sunken/60 ${highlighted ? 'bg-blue-tint' : ''}`}
      >
        <span aria-hidden="true" className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-full bg-sunken text-ink-2">
          <c.Icon size={20} strokeWidth={1.75} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block t-body font-bold text-ink [overflow-wrap:anywhere]">{e.title}</span>
          <span className="block t-small text-ink-2">
            {c.label} · {p.label}
            {from ? ` · ${from}` : ''}
            {e.hasReceipt ? ' · Receipt' : ''}
            {!e.reimbursable ? ' · Not claimed' : ''}
          </span>
          {(e.flags.length > 0 || e.claimStatus) && (
            <span className="mt-1 flex flex-wrap gap-1">
              {e.flags.map((f) => (
                <Tag key={f} tone={FLAG_TAGS[f].tone}>
                  {FLAG_TAGS[f].text}
                  {f === 'over_limit' && e.overByPaise ? ` by ${paise(e.overByPaise)}` : ''}
                </Tag>
              ))}
              {e.claimStatus && <Tag tone={e.claimStatus === 'reimbursed' ? 'green' : 'blue'}>{e.claimStatus === 'reimbursed' ? 'Paid back' : 'Claimed'}</Tag>}
            </span>
          )}
        </span>
        <span className={`shrink-0 t-body font-bold tnum ${e.estimate ? 'text-ink-2' : 'text-ink'}`}>{e.estimate ? `~${paise(e.amountPaise)}` : paise(e.amountPaise)}</span>
      </button>
    </li>
  )
}

function List({ book, highlight, onOpen }: { book: ExpenseBook; highlight: Set<string>; onOpen: (e: Expense) => void }) {
  const days = useMemo(() => {
    const by = new Map<string, Expense[]>()
    for (const e of book.items) by.set(e.day, [...(by.get(e.day) ?? []), e])
    return [...by.entries()]
  }, [book.items])
  if (!days.length)
    return (
      <div className="mt-8">
        <EmptyState title="No expenses yet" body="Add what you spend as you go. Bookings and the plan’s fares come in by themselves." />
      </div>
    )
  return (
    <section aria-labelledby="list-h" className="mt-8">
      <h2 id="list-h" className="t-title text-ink">
        Day by day
      </h2>
      <div className="mt-3 flex flex-col gap-4">
        {days.map(([day, items]) => (
          <section key={day} aria-label={dayLabel(day)}>
            <h3 className="flex items-baseline justify-between px-1 t-small font-bold text-ink-2">
              <span>
                {dayLabel(day)}
                {day > book.totals.today ? ', planned' : day === book.totals.today ? ', today' : ''}
              </span>
              <span className="tnum">{paise(items.reduce((s, e) => s + e.amountPaise, 0))}</span>
            </h3>
            <ul className="mt-2 divide-y divide-line overflow-hidden rounded-card border border-line bg-surface">
              {items.map((e) => (
                <Row key={e.expenseId} e={e} highlighted={highlight.has(e.expenseId)} onOpen={() => onOpen(e)} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </section>
  )
}

/** Send what's ready to the office as one claim, after a look at what it holds. */
function ClaimSheet({ book, open, onOpenChange }: { book: ExpenseBook; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const { key, after, renew } = useSubmitKey('claim')
  const today = book.totals.today
  const ready = book.items.filter((e) => e.reimbursable && !e.estimate && !e.claimId && e.day <= today)
  const missing = ready.filter((e) => e.flags.includes('needs_receipt')).length
  const unconfirmed = book.items.filter((e) => e.estimate && e.day <= today).length
  const total = ready.reduce((s, e) => s + e.amountPaise, 0)
  const send = async () => {
    setBusy(true)
    setError(undefined)
    try {
      const claim = await api.post<ExpenseClaim>(`/v1/trips/${book.tripId}/expense-claims`, {}, { idempotencyKey: key })
      renew()
      await queryClient.invalidateQueries({ queryKey: keys.expenses(book.tripId) })
      onOpenChange(false)
      showToast({ title: `Claim ${claim.reference} for ${paise(claim.totalPaise)} is ready to send to your office.` })
    } catch (err) {
      after(err)
      setError(err instanceof ApiError ? err.message : "Couldn't make the claim. Try again.")
    } finally {
      setBusy(false)
    }
  }
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={`Claim ${paise(total)} back`}
      description={`${ready.length} ${ready.length === 1 ? 'expense' : 'expenses'} up to today, reimbursable and confirmed. They can’t change while claimed; withdraw the claim to change one.`}
      footer={
        <div className="flex flex-col gap-2">
          {error && <FieldError id="claim-err">{error}</FieldError>}
          <Button full loading={busy} loadingLabel="Making the claim…" disabled={!ready.length} onClick={() => void send()}>
            Make the claim
          </Button>
        </div>
      }
    >
      <ul className="flex flex-col gap-2">
        {missing > 0 && (
          <li className="flex items-start gap-2 rounded-card bg-yellow px-4 py-3 t-small font-bold text-on-yellow">
            <TriangleAlert size={20} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
            {missing} {missing === 1 ? 'has' : 'have'} no receipt photo. The office may ask for {missing === 1 ? 'it' : 'them'}.
          </li>
        )}
        {unconfirmed > 0 && (
          <li className="flex items-start gap-2 rounded-card bg-sunken px-4 py-3 t-small text-ink">
            <Info size={20} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
            {unconfirmed} {unconfirmed === 1 ? 'ride is' : 'rides are'} still the plan’s estimate and {unconfirmed === 1 ? 'isn’t' : 'aren’t'} included. Confirm {unconfirmed === 1 ? 'it' : 'them'} first to claim {unconfirmed === 1 ? 'it' : 'them'}.
          </li>
        )}
        {ready.map((e) => (
          <li key={e.expenseId} className="flex items-baseline justify-between gap-3 t-small text-ink-2">
            <span className="min-w-0 [overflow-wrap:anywhere]">
              {shortDay(e.day)}, {e.title}
            </span>
            <span className="shrink-0 tnum">{paise(e.amountPaise)}</span>
          </li>
        ))}
      </ul>
    </Sheet>
  )
}

function Claims({ book, onClaim }: { book: ExpenseBook; onClaim: () => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const act = async (claim: ExpenseClaim, what: 'reimbursed' | 'withdraw') => {
    setBusy(`${what}:${claim.claimId}`)
    try {
      await api.post(`/v1/trips/${book.tripId}/expense-claims/${claim.claimId}/${what}`, {})
      await queryClient.invalidateQueries({ queryKey: keys.expenses(book.tripId) })
      showToast({ title: what === 'reimbursed' ? `Claim ${claim.reference} marked paid back.` : `Claim ${claim.reference} withdrawn: its expenses can change again.` })
    } catch (err) {
      showToast({ title: err instanceof ApiError ? err.message : "Couldn't do that. Try again." })
    } finally {
      setBusy(null)
    }
  }
  return (
    <section aria-labelledby="claims-h" className="mt-8">
      <h2 id="claims-h" className="t-title text-ink">
        Claims
      </h2>
      <p className="mt-1 t-small text-ink-2">Send your office what it owes you, with a report and the receipts.</p>
      {book.totals.toClaimPaise > 0 && (
        <Button className="mt-3" icon={<Wallet size={20} strokeWidth={1.75} aria-hidden="true" />} onClick={onClaim}>
          {`Claim ${paise(book.totals.toClaimPaise)} back`}
        </Button>
      )}
      {book.claims.length > 0 && (
        <ul className="mt-3 flex flex-col gap-3">
          {book.claims.map((c) => (
            <li key={c.claimId}>
              <Card>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="t-title text-ink tnum">{c.reference}</p>
                    <p className="t-small text-ink-2">
                      {c.count} {c.count === 1 ? 'expense' : 'expenses'}, {paise(c.totalPaise)}
                    </p>
                  </div>
                  <Tag tone={c.status === 'reimbursed' ? 'green' : 'blue'}>{c.status === 'reimbursed' ? 'Paid back' : 'Sent'}</Tag>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <ButtonLink to={`/expenses/report?claim=${c.claimId}`} variant="secondary" size="md" icon={<FileText size={20} strokeWidth={1.75} aria-hidden="true" />}>
                    Report
                  </ButtonLink>
                  <Button
                    variant="secondary"
                    size="md"
                    icon={<Download size={20} strokeWidth={1.75} aria-hidden="true" />}
                    onClick={() => void saveDownload(`/v1/trips/${book.tripId}/expenses/export.csv?claimId=${c.claimId}`, `reroute-expenses-${c.reference}.csv`).catch(() => showToast({ title: "Couldn't download it. Try again." }))}
                  >
                    CSV
                  </Button>
                  {c.status === 'submitted' && (
                    <>
                      <Button variant="tertiary" size="md" loading={busy === `reimbursed:${c.claimId}`} loadingLabel="Saving…" disabled={busy !== null} onClick={() => void act(c, 'reimbursed')}>
                        Mark paid back
                      </Button>
                      <Button variant="tertiary" size="md" loading={busy === `withdraw:${c.claimId}`} loadingLabel="Withdrawing…" disabled={busy !== null} onClick={() => void act(c, 'withdraw')}>
                        Withdraw
                      </Button>
                    </>
                  )}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export default function Expenses() {
  const current = useCurrentTripId()
  const trip = useTrip(current.tripId)
  const q = useExpenses(current.tripId)
  const online = useOnline()
  const [start, setStart] = useState<SheetStart | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [budgetOpen, setBudgetOpen] = useState(false)
  const [claimOpen, setClaimOpen] = useState(false)
  const [highlight, setHighlight] = useState<Set<string>>(new Set())
  useDocumentTitle('Expenses')
  // Rico speaks up when the trip goes over its budget or one of the office's limits.
  useRicoMoneyNudge(q.data)
  // Sent here to open something: an expense (its receipt, from Rico's card), or a form filled in from what was said.
  const location = useLocation()
  const navigate = useNavigate()
  useEffect(() => {
    const st = location.state as { openExpense?: string; draft?: ExpenseDraft } | null
    if (!st || !q.data) return
    const found = st.openExpense ? q.data.items.find((x) => x.expenseId === st.openExpense) : undefined
    if (found) open({ expense: found })
    else if (st.draft) open({ draft: st.draft })
    navigate(location.pathname, { replace: true, state: null })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state, q.data])

  const open = (s: SheetStart) => {
    setStart(s)
    setSheetOpen(true)
  }
  const show = (ids: string[]) => {
    setHighlight(new Set(ids))
    document.querySelector(`[data-expense="${ids[0]}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    window.setTimeout(() => setHighlight(new Set()), 4000)
  }

  const header = (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 tabIndex={-1} className="t-display-1 text-ink">
          Expenses
        </h1>
        {trip.data && (
          <p className="mt-1 t-body text-ink-2">
            {trip.data.cityName}, {trip.data.startDate === trip.data.endDate ? shortDay(trip.data.startDate) : `${shortDay(trip.data.startDate)} to ${shortDay(trip.data.endDate)}`}
          </p>
        )}
      </div>
    </div>
  )

  if (!current.tripId && !current.isPending)
    return (
      <div className="mx-auto max-w-[560px] px-5 pb-10 pt-6">
        {header}
        <div className="mt-6">
          <EmptyState title="No trip yet" body="Start a trip, and its expenses gather here: what you spend, your bookings and the fares of each day’s plan." action={<ButtonLink to="/plan">Start a trip</ButtonLink>} />
        </div>
      </div>
    )

  if (q.isPending || trip.isPending)
    return (
      <div className="mx-auto max-w-[560px] px-5 pb-10 pt-6">
        {header}
        <LoadingRegion label="Loading your expenses">
          <Skeleton className="mt-6 h-48 w-full rounded-card" />
          <Skeleton className="mt-6 h-24 w-full rounded-card" />
          <Skeleton className="mt-6 h-64 w-full rounded-card" />
        </LoadingRegion>
      </div>
    )

  if ((q.isError && !q.data) || !trip.data || !q.data)
    return (
      <div className="mx-auto max-w-[560px] px-5 pb-10 pt-6">
        {header}
        <div className="mt-6">
          <ErrorState message={online ? "Couldn't load your expenses. Check your connection and try again." : 'You’re offline. Your expenses show once you have signal.'} onRetry={() => q.refetch()} />
        </div>
      </div>
    )

  const book = q.data
  return (
    <div className="mx-auto max-w-[560px] px-5 pb-10 pt-6 lg:max-w-[1200px] lg:px-8 lg:pt-8">
      {header}
      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] lg:items-start lg:gap-12">
        <div>
          <div className="mt-6">
            <Overview book={book} onBudget={() => setBudgetOpen(true)} />
          </div>
          {ricoKeepsMoney && (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="secondary" size="md" icon={<Sparkles size={20} strokeWidth={1.75} aria-hidden="true" />} onClick={() => askRico('How much have I spent so far?')}>
                Ask Rico about my spending
              </Button>
              {book.budget?.totalPaise ? (
                <Button variant="tertiary" size="md" onClick={() => askRico('Am I on budget?')}>
                  Am I on budget?
                </Button>
              ) : null}
            </div>
          )}
          <Alerts alerts={book.alerts} onShow={show} />
          <AddBar trip={trip.data} scanning={book.scanning} onStart={open} />
          <Breakdown book={book} />
          <Claims book={book} onClaim={() => setClaimOpen(true)} />
          <section aria-labelledby="tools-h" className="mt-8">
            <h2 id="tools-h" className="sr-only">
              Budget and reports
            </h2>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="md" onClick={() => setBudgetOpen(true)}>
                {book.budget ? 'Change the budget' : 'Set a budget'}
              </Button>
              <ButtonLink to="/expenses/report" variant="secondary" size="md" icon={<ReceiptText size={20} strokeWidth={1.75} aria-hidden="true" />}>
                Full report
              </ButtonLink>
              <Button
                variant="secondary"
                size="md"
                icon={<Download size={20} strokeWidth={1.75} aria-hidden="true" />}
                onClick={() => void saveDownload(`/v1/trips/${book.tripId}/expenses/export.csv`, 'reroute-expenses.csv').catch(() => showToast({ title: "Couldn't download it. Try again." }))}
              >
                Download CSV
              </Button>
            </div>
          </section>
        </div>
        <div className="lg:mt-6">
          <List book={book} highlight={highlight} onOpen={(e) => open({ expense: e })} />
          <Button variant="tertiary" size="md" className="-ml-2 mt-4" icon={<Plus size={20} strokeWidth={1.75} aria-hidden="true" />} disabled={!online} onClick={() => open({ draft: null })}>
            Add another
          </Button>
        </div>
      </div>
      <ExpenseSheet trip={trip.data} start={start} open={sheetOpen} onOpenChange={setSheetOpen} />
      <BudgetSheet tripId={book.tripId} budget={book.budget} open={budgetOpen} onOpenChange={setBudgetOpen} />
      <ClaimSheet book={book} open={claimOpen} onOpenChange={setClaimOpen} />
    </div>
  )
}
