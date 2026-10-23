import { ArrowUpRight, Car, Check, CircleCheck, CircleX, Clock, ListChecks, Luggage, MessageSquareText, Minus, Pencil, Plus, Route, SkipForward, SunMoon, Trash2, Undo2, Volume2, Wallet, X, type LucideIcon } from 'lucide-react'
import type { RooProposal, RooRun, RooStep } from '@/api/types'
import { Spinner } from '@/components/ui/Spinner'
import { rupees } from '@/lib/format'

export type PlanState = 'ask' | 'busy' | 'done' | 'partial' | 'failed' | 'no' | 'undoing' | 'undone' | 'expired'

/** Roo's card of changes, as the conversation keeps it. */
export interface PlanCardData {
  proposal: RooProposal
  state: PlanState
  run?: RooRun
  /** Why it can't run any more (it expired, or the day changed). */
  note?: string
}

const ICONS: Record<string, LucideIcon> = {
  add: Plus,
  edit: Pencil,
  skip: SkipForward,
  remove: Trash2,
  late: Clock,
  done: CircleCheck,
  plan: Route,
  option: ListChecks,
  undo: Undo2,
  cab: Car,
  cancel: CircleX,
  wallet: Wallet,
  trip: Luggage,
  theme: SunMoon,
  voice: Volume2,
  message: MessageSquareText,
  open: ArrowUpRight,
}

const button = 'min-h-11 rounded-full px-4 t-small font-bold transition-[background-color,scale] duration-[var(--dur-quick)] motion-safe:active:scale-[0.97]'

function Money({ step }: { step: RooStep }) {
  if (step.costInr) return <span className="shrink-0 t-small font-bold tabular-nums text-ink">{rupees(step.costInr)}</span>
  const back = step.refundInr || step.topUpInr
  if (back) return <span className="shrink-0 t-small font-bold tabular-nums text-green-ink">+{rupees(back)}</span>
  return null
}

function Outcome({ status }: { status: string }) {
  const ok = status === 'done' || status === 'phone'
  const Icon = ok ? Check : status === 'failed' ? X : Minus
  return (
    <span className={`shrink-0 pt-1 ${ok ? 'text-green-ink' : status === 'failed' ? 'text-red-ink' : 'text-muted'}`}>
      <Icon size={18} strokeWidth={2.25} aria-hidden="true" />
      <span className="sr-only">{ok ? 'Done' : status === 'failed' ? 'Didn’t work' : 'Not done'}</span>
    </span>
  )
}

/**
 * Everything Roo would do, on one card: nothing happens until "Do all". Then each step shows how it went,
 * and Undo takes back what can be taken back.
 */
export function PlanCard({ plan, onRun, onDecline, onUndo }: { plan: PlanCardData; onRun: () => void; onDecline: () => void; onUndo: () => void }) {
  const { proposal, state, run } = plan
  const count = proposal.steps.length
  const things = count === 1 ? '1 thing' : `${count} things`
  const ran = state === 'done' || state === 'partial' || state === 'failed' || state === 'undone' || state === 'undoing'
  const outcome = (step: RooStep) => run?.steps.find((r) => r.stepId === step.stepId)
  return (
    <div role="group" aria-label={`Rico’s card: ${things}`} className="mt-2 w-full min-w-[16rem] rounded-card border border-line bg-surface p-3">
      <p className="t-title text-ink">{ran ? `Rico’s card: ${things}` : `Rico will do ${things}`}</p>
      <ol className="mt-2 flex flex-col gap-2.5">
        {proposal.steps.map((step) => {
          const Icon = ICONS[step.icon] ?? Check
          const result = ran ? outcome(step) : undefined
          return (
            <li key={step.stepId} className="flex items-start gap-2.5">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-green-tint text-green-ink" aria-hidden="true">
                <Icon size={16} strokeWidth={2} />
              </span>
              <span className="min-w-0 flex-1 pt-0.5">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="t-small font-bold text-ink">{step.label}</span>
                  <Money step={step} />
                </span>
                {step.detail && <span className="block t-small text-ink-2">{step.detail}</span>}
                {step.auto && !ran && <span className="block t-small text-muted">Rico added this</span>}
                {result?.status === 'failed' && <span className="block t-small text-red-ink">{result.message}</span>}
                {result?.status === 'skipped' && <span className="block t-small text-muted">Not done</span>}
              </span>
              {result && <Outcome status={result.status} />}
            </li>
          )
        })}
      </ol>
      {proposal.totalCostInr > 0 && !ran && <p className="mt-3 border-t border-line pt-2 t-small text-ink-2">{rupees(proposal.totalCostInr)} from your wallet (simulated money)</p>}
      {proposal.final.length > 0 && state === 'ask' && <p className="mt-1 t-small text-muted">{proposal.final.join(' ')}</p>}

      {state === 'ask' && (
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" onClick={onRun} className={`${button} bg-green text-on-green [@media(hover:hover)]:hover:bg-green-ink`}>
            {count === 1 ? 'Do it' : `Do all ${count}`}
          </button>
          <button type="button" onClick={onDecline} className={`${button} border border-line-strong text-ink [@media(hover:hover)]:hover:bg-sunken`}>
            Not now
          </button>
        </div>
      )}
      {(state === 'busy' || state === 'undoing') && (
        <p role="status" className="mt-3 flex items-center gap-2 t-small text-ink-2">
          <Spinner size={16} /> {state === 'busy' ? 'Doing it…' : 'Undoing…'}
        </p>
      )}
      {(state === 'done' || state === 'partial' || state === 'failed') && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <p className={`flex items-center gap-2 t-small font-bold ${state === 'done' ? 'text-green-ink' : 'text-red-ink'}`}>
            {state === 'done' ? <Check size={16} strokeWidth={2.25} aria-hidden="true" /> : null}
            {state === 'done' ? 'Done' : state === 'partial' ? 'Partly done' : 'Not done'}
          </p>
          {run?.canUndo && (
            <button type="button" onClick={onUndo} className={`${button} border border-line-strong text-ink [@media(hover:hover)]:hover:bg-sunken`}>
              Undo
            </button>
          )}
        </div>
      )}
      {state === 'undone' && <p className="mt-3 t-small text-ink-2">Undone</p>}
      {state === 'no' && <p className="mt-3 t-small text-muted">Left as it is</p>}
      {state === 'expired' && <p className="mt-3 t-small text-ink-2">{plan.note ?? 'This card has expired. Ask Rico again.'}</p>}
    </div>
  )
}
