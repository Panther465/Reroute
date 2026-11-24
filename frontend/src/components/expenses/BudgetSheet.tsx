import { useEffect, useState } from 'react'
import { api, ApiError } from '@/api/client'
import { keys, queryClient } from '@/api/queries'
import type { ExpenseBudget, ExpenseBudgetIn, ExpenseCategory } from '@/api/types'
import { Button } from '@/components/ui/Button'
import { Field, FieldError } from '@/components/ui/Field'
import { Sheet } from '@/components/ui/Sheet'
import { paiseField, toPaise } from '@/lib/expenses'
import { showToast } from '@/lib/store'

/** The categories offices most often cap a day: meals, a hotel night, getting around. */
const LIMITS: { value: ExpenseCategory; label: string; hint: string }[] = [
  { value: 'food', label: 'Food a day (₹)', hint: 'Many offices allow ₹800 to ₹1,500 for meals.' },
  { value: 'stay', label: 'Stay a night (₹)', hint: 'The hotel’s nightly limit.' },
  { value: 'transport', label: 'Local travel a day (₹)', hint: 'Cabs, autos, the metro.' },
]

/**
 * The trip's budget and the office's rules, each optional: the total, a daily amount, daily limits for some
 * kinds of expense, and the amount above which the office wants a receipt.
 */
export function BudgetSheet({ tripId, budget, open, onOpenChange }: { tripId: string; budget: ExpenseBudget | null; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [total, setTotal] = useState('')
  const [daily, setDaily] = useState('')
  const [limits, setLimits] = useState<Record<string, string>>({})
  const [receiptOver, setReceiptOver] = useState('500')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<'save' | 'remove' | null>(null)

  useEffect(() => {
    if (!open) return
    setTotal(paiseField(budget?.totalPaise))
    setDaily(paiseField(budget?.dailyPaise))
    setLimits(Object.fromEntries(LIMITS.map((l) => [l.value, paiseField(budget?.categoryDailyPaise?.[l.value])])))
    setReceiptOver(paiseField(budget?.receiptOverPaise ?? 50000))
    setErrors({})
  }, [open, budget])

  const amount = (text: string, field: string, e: Record<string, string>) => {
    if (!text.trim()) return null
    const value = toPaise(text)
    if (value === null) e[field] = 'Enter an amount, like 15000.'
    return value
  }

  const save = async () => {
    const e: Record<string, string> = {}
    const body: ExpenseBudgetIn = {
      totalPaise: amount(total, 'total', e),
      dailyPaise: amount(daily, 'daily', e),
      categoryDailyPaise: Object.fromEntries(LIMITS.map((l) => [l.value, amount(limits[l.value] ?? '', l.value, e)]).filter(([, v]) => v != null)),
      receiptOverPaise: amount(receiptOver, 'receiptOver', e) ?? 50000,
    }
    setErrors(e)
    if (Object.keys(e).length) return
    setBusy('save')
    try {
      await api.put(`/v1/trips/${tripId}/expense-budget`, body)
      await queryClient.invalidateQueries({ queryKey: keys.expenses(tripId) })
      onOpenChange(false)
      showToast({ title: 'Budget saved.' })
    } catch (err) {
      setErrors({ form: err instanceof ApiError ? err.message : "Couldn't save it. Try again." })
    } finally {
      setBusy(null)
    }
  }

  const remove = async () => {
    setBusy('remove')
    try {
      await api.delete(`/v1/trips/${tripId}/expense-budget`)
      await queryClient.invalidateQueries({ queryKey: keys.expenses(tripId) })
      onOpenChange(false)
      showToast({ title: 'Budget removed.' })
    } catch (err) {
      setErrors({ form: err instanceof ApiError ? err.message : "Couldn't remove it. Try again." })
    } finally {
      setBusy(null)
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Budget and limits"
      description="Each is optional. Reroute warns you before you go over, and flags what the office may question."
      footer={
        <div className="flex flex-col gap-2">
          {errors.form && <FieldError id="budget-err">{errors.form}</FieldError>}
          <Button full loading={busy === 'save'} loadingLabel="Saving…" disabled={busy !== null} onClick={() => void save()}>
            Save the budget
          </Button>
          {budget && (
            <Button variant="tertiary" size="md" className="self-center" loading={busy === 'remove'} loadingLabel="Removing…" disabled={busy !== null} onClick={() => void remove()}>
              Remove the budget
            </Button>
          )}
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        <Field label="For the whole trip (₹)" inputMode="decimal" value={total} onChange={(e) => setTotal(e.target.value)} error={errors.total} maxLength={12} />
        <Field label="A day (₹)" inputMode="decimal" value={daily} onChange={(e) => setDaily(e.target.value)} error={errors.daily} maxLength={12} />
        <section aria-labelledby="limits-h" className="flex flex-col gap-4">
          <h3 id="limits-h" className="t-title text-ink">
            The office’s limits
          </h3>
          {LIMITS.map((l) => (
            <Field
              key={l.value}
              label={l.label}
              hint={l.hint}
              inputMode="decimal"
              value={limits[l.value] ?? ''}
              onChange={(e) => setLimits((s) => ({ ...s, [l.value]: e.target.value }))}
              error={errors[l.value]}
              maxLength={12}
            />
          ))}
          <Field label="Receipts needed above (₹)" hint="Reroute flags expenses above this without a photo." inputMode="decimal" value={receiptOver} onChange={(e) => setReceiptOver(e.target.value)} error={errors.receiptOver} maxLength={12} />
        </section>
      </div>
    </Sheet>
  )
}
