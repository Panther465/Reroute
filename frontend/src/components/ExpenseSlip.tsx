import { Download, Share2 } from 'lucide-react'
import type { Summary } from '@/api/types'
import { MODE_META } from '@/components/icons'
import { ModeChain } from '@/components/timeline/ModeChain'
import { Button } from '@/components/ui/Button'
import { duration, hhmm, rupees } from '@/lib/format'
import { showToast } from '@/lib/store'
import { dayLabel, localMinutes } from '@/lib/timeline'

export function ExpenseSlip({ summary, offset }: { summary: Summary; offset: string }) {
  const date = dayLabel(summary.day)
  const reroutes = summary.reroutes.map((r) => hhmm(localMinutes(r, summary.day, offset)))
  const download = () => {
    const blob = new Blob([summary.slipText], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `reroute-expenses-${summary.day}.txt`
    a.click()
    // Some browsers start the download after click() returns; revoke later.
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
    showToast({ title: 'Slip downloaded.' })
  }
  const share = async () => {
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Travel expenses', text: summary.slipText })
      } catch {
        /* cancelled */
      }
      return
    }
    try {
      await navigator.clipboard.writeText(summary.slipText)
      showToast({ title: 'Slip copied. Paste it into an email to your office.' })
    } catch {
      showToast({ title: "Couldn't copy the slip. Download it instead." })
    }
  }
  return (
    <section aria-labelledby="slip-title" className="rounded-card border border-line bg-surface p-5">
      <h2 id="slip-title" className="t-title text-ink">
        Expense slip
      </h2>
      <p className="t-small text-muted">{date}. Estimated fares, not receipts.</p>
      <table className="mt-4 w-full border-collapse text-left">
        <caption className="sr-only">Fares by leg</caption>
        <thead className="sr-only">
          <tr>
            <th scope="col">Leg and mode</th>
            <th scope="col">Fare</th>
          </tr>
        </thead>
        <tbody>
          {summary.legs.map((l, i) => (
            <tr key={i} className="align-top">
              <th scope="row" className="py-2 pr-3 font-normal">
                <span className="block t-body text-ink">
                  {l.fromName} to {l.toName}
                </span>
                <span className="mt-0.5 flex items-center gap-2 t-small text-ink-2">
                  <ModeChain segments={l.segments} size={16} />
                  {l.label === 'Cab' ? MODE_META.cab.label : l.label}
                </span>
              </th>
              <td className="py-2 text-right t-body text-ink tnum">{rupees(l.fareInr)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={2} className="pt-2">
              <div className="border-t-2 border-dashed border-line-strong" />
            </td>
          </tr>
          <tr>
            <th scope="row" className="pt-3 text-left align-top font-normal">
              <span className="block t-title text-ink">Total</span>
              <span className="block t-small text-muted">
                {duration(summary.totals.travelMin)} travelling
                {reroutes.length ? `, rerouted ${reroutes.length === 1 ? 'once' : `${reroutes.length} times`} at ${reroutes.join(', ')}` : ''}
              </span>
            </th>
            <td className="pt-3 text-right align-top t-money text-ink">{rupees(summary.totals.fareInr)}</td>
          </tr>
        </tfoot>
      </table>
      <div className="mt-5 flex flex-wrap gap-3">
        <Button variant="secondary" icon={<Download size={20} strokeWidth={1.75} aria-hidden="true" />} onClick={download}>
          Download the slip
        </Button>
        <Button variant="primary" icon={<Share2 size={20} strokeWidth={1.75} aria-hidden="true" />} onClick={share}>
          Share with my office
        </Button>
      </div>
    </section>
  )
}
