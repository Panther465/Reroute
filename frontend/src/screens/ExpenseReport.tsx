import { ArrowLeft, Download, Printer } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { api } from '@/api/client'
import { useCurrentTripId, useExpenses, useMe, useTrip } from '@/api/queries'
import type { Expense } from '@/api/types'
import { RouteMark } from '@/components/icons'
import { Button } from '@/components/ui/Button'
import { ErrorState, LoadingRegion, Skeleton } from '@/components/ui/States'
import { categoryOf, paise, paymentOf } from '@/lib/expenses'
import { useDocumentTitle } from '@/lib/hooks'
import { isNative } from '@/lib/platform'
import { showToast } from '@/lib/store'
import { saveDownload } from './Expenses'

const shortDay = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })

/** A receipt's photo for the report, fetched with the traveller's sign-in. */
function ReceiptPhoto({ tripId, e }: { tripId: string; e: Expense }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let made: string | null = null
    let live = true
    api
      .get<Response>(`/v1/trips/${tripId}/expenses/${e.expenseId}/receipt`, { raw: true })
      .then((res) => (res.ok ? res.blob() : null))
      .then((blob) => {
        if (blob && live) setUrl((made = URL.createObjectURL(blob)))
      })
      .catch(() => undefined)
    return () => {
      live = false
      if (made) URL.revokeObjectURL(made)
    }
  }, [tripId, e.expenseId])
  return (
    <figure className="break-inside-avoid rounded-card border border-line p-3">
      {url ? <img src={url} alt={`Receipt: ${e.title}`} className="max-h-96 w-auto max-w-full object-contain" /> : <div className="h-32 animate-pulse rounded-control bg-sunken print:hidden" />}
      <figcaption className="mt-2 t-small text-ink-2">
        {shortDay(e.day)}, {e.title}, {paise(e.amountPaise)}
      </figcaption>
    </figure>
  )
}

/**
 * The expense report for the office: every expense of the trip (or of one claim) in a table, the totals, the GST,
 * and the receipts' photos. "Print or save as PDF" prints it without the app around it.
 */
export default function ExpenseReport() {
  const [params] = useSearchParams()
  const claimId = params.get('claim')
  const current = useCurrentTripId()
  const trip = useTrip(current.tripId)
  const q = useExpenses(current.tripId)
  const me = useMe()
  useDocumentTitle('Expense report')

  if (!current.tripId && !current.isPending)
    return (
      <main className="mx-auto max-w-[860px] px-5 py-8">
        <h1 className="t-display-1 text-ink">Expense report</h1>
        <p className="mt-4 t-body text-ink-2">There’s no trip to report on yet.</p>
        <Link to="/plan" className="mt-4 inline-flex min-h-12 items-center t-title text-ink underline underline-offset-4">
          Start a trip
        </Link>
      </main>
    )
  if (q.isPending || trip.isPending)
    return (
      <main className="mx-auto max-w-[860px] px-5 py-8">
        <LoadingRegion label="Loading the report">
          <Skeleton className="h-10 w-64" />
          <Skeleton className="mt-6 h-96 w-full rounded-card" />
        </LoadingRegion>
      </main>
    )
  if (!q.data || !trip.data)
    return (
      <main className="mx-auto max-w-[860px] px-5 py-8">
        <h1 className="t-display-1 text-ink">Expense report</h1>
        <div className="mt-6">
          <ErrorState message="Couldn't load the report. Sign in, then try again." onRetry={() => q.refetch()} />
        </div>
      </main>
    )

  const book = q.data
  const claim = claimId ? book.claims.find((c) => c.claimId === claimId) : undefined
  const items = book.items.filter((e) => (claimId ? e.claimId === claimId : true)).sort((a, b) => a.day.localeCompare(b.day))
  const total = items.reduce((s, e) => s + e.amountPaise, 0)
  const gst = items.reduce((s, e) => s + (e.taxPaise ?? 0), 0)
  const claimable = items.filter((e) => e.reimbursable && !e.estimate).reduce((s, e) => s + e.amountPaise, 0)
  const byCategory = new Map<string, number>()
  for (const e of items) byCategory.set(e.category, (byCategory.get(e.category) ?? 0) + e.amountPaise)
  const withReceipts = items.filter((e) => e.hasReceipt)
  const csvPath = `/v1/trips/${book.tripId}/expenses/export.csv${claimId ? `?claimId=${claimId}` : ''}`

  return (
    <div className="min-h-dvh bg-ground text-ink print:bg-white">
      <div className="mx-auto flex max-w-[860px] flex-wrap items-center justify-between gap-2 px-5 py-3 print:hidden">
        <Link to="/expenses" className="-ml-2 inline-flex min-h-12 items-center gap-2 rounded-control px-2 t-title text-ink">
          <ArrowLeft size={20} strokeWidth={1.75} aria-hidden="true" />
          Expenses
        </Link>
        <span className="flex flex-wrap gap-2">
          <Button variant="secondary" size="md" icon={<Download size={20} strokeWidth={1.75} aria-hidden="true" />} onClick={() => void saveDownload(csvPath, 'reroute-expenses.csv').catch(() => showToast({ title: "Couldn't download it. Try again." }))}>
            CSV
          </Button>
          {/* The Android app's web view can't print: its CSV goes to the office instead. */}
          {!isNative() && (
            <Button size="md" icon={<Printer size={20} strokeWidth={1.75} aria-hidden="true" />} onClick={() => window.print()}>
              Print or save as PDF
            </Button>
          )}
        </span>
      </div>

      <main id="main" className="mx-auto max-w-[860px] px-5 pb-12">
        <header className="flex items-start justify-between gap-4 border-b border-line pb-4">
          <div>
            <h1 tabIndex={-1} className="t-display-1 text-ink">
              Expense report
            </h1>
            <p className="mt-1 t-body text-ink-2">
              {trip.data.cityName}, {shortDay(trip.data.startDate)}
              {trip.data.endDate !== trip.data.startDate ? ` to ${shortDay(trip.data.endDate)}` : ''}
            </p>
            <p className="t-small text-ink-2">
              {me.data?.name ? `${me.data.name}, ` : ''}
              {claim ? `claim ${claim.reference}, ${claim.status === 'reimbursed' ? 'paid back' : 'sent'} ${shortDay(claim.submittedAt.slice(0, 10))}` : `made ${shortDay(book.totals.today)}`}
            </p>
          </div>
          <RouteMark size={36} />
        </header>

        {items.length === 0 ? (
          <p className="mt-6 t-body text-ink-2">No expenses to report.</p>
        ) : (
          <>
            <div className="mt-6 overflow-x-auto" tabIndex={0} role="region" aria-label="Expenses">
              <table className="w-full min-w-[560px] border-collapse text-left t-small tnum">
                <caption className="sr-only">Every expense, by day</caption>
                <thead>
                  <tr className="border-b-2 border-line-strong text-ink">
                    <th scope="col" className="py-2 pr-3">Date</th>
                    <th scope="col" className="py-2 pr-3">Description</th>
                    <th scope="col" className="py-2 pr-3">Kind</th>
                    <th scope="col" className="py-2 pr-3">Paid with</th>
                    <th scope="col" className="py-2 pr-3 text-right">GST</th>
                    <th scope="col" className="py-2 text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((e) => (
                    <tr key={e.expenseId} className="border-b border-line align-top text-ink-2">
                      <td className="whitespace-nowrap py-2 pr-3">{shortDay(e.day)}</td>
                      <td className="py-2 pr-3 text-ink">
                        {e.title}
                        {e.merchant && e.merchant !== e.title ? <span className="block text-ink-2">{e.merchant}</span> : null}
                        <span className="block text-muted">
                          {[e.hasReceipt ? 'Receipt attached' : null, e.estimate ? 'Estimate' : null, e.reimbursable ? null : 'Not claimed', e.gstin ? `GSTIN ${e.gstin}` : null].filter(Boolean).join(' · ')}
                        </span>
                      </td>
                      <td className="py-2 pr-3">{categoryOf(e.category).label}</td>
                      <td className="py-2 pr-3">{paymentOf(e.payment).label}</td>
                      <td className="py-2 pr-3 text-right">{e.taxPaise != null ? paise(e.taxPaise) : ''}</td>
                      <td className="py-2 text-right text-ink">{paise(e.amountPaise)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="font-bold text-ink">
                    <th scope="row" colSpan={4} className="py-2 pr-3">
                      Total
                    </th>
                    <td className="py-2 pr-3 text-right">{gst ? paise(gst) : ''}</td>
                    <td className="py-2 text-right">{paise(total)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>

            <section aria-labelledby="sums-h" className="mt-8 grid gap-6 sm:grid-cols-2">
              <div>
                <h2 id="sums-h" className="t-title text-ink">
                  By kind
                </h2>
                <dl className="mt-2 flex flex-col gap-1 t-small tnum">
                  {[...byCategory.entries()]
                    .sort((a, b) => b[1] - a[1])
                    .map(([c, v]) => (
                      <div key={c} className="flex justify-between gap-3">
                        <dt className="text-ink-2">{categoryOf(c as Expense['category']).label}</dt>
                        <dd className="text-ink">{paise(v)}</dd>
                      </div>
                    ))}
                </dl>
              </div>
              <div>
                <h2 className="t-title text-ink">To be paid back</h2>
                <p className="mt-2 font-display text-[length:calc(1.75rem*var(--grow-display))] font-extrabold text-ink tnum">{paise(claimable)}</p>
                <p className="t-small text-ink-2">Reimbursable and confirmed. The plan’s estimates aren’t included until confirmed.</p>
              </div>
            </section>

            {withReceipts.length > 0 && (
              <section aria-labelledby="receipts-h" className="mt-10 break-before-page">
                <h2 id="receipts-h" className="t-title text-ink">
                  Receipts
                </h2>
                <div className="mt-3 grid gap-4 sm:grid-cols-2">
                  {withReceipts.map((e) => (
                    <ReceiptPhoto key={e.expenseId} tripId={book.tripId} e={e} />
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </main>
    </div>
  )
}
