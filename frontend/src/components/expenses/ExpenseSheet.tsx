import { Camera, Check, ImageOff, Trash2 } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { api, ApiError } from '@/api/client'
import { keys, queryClient } from '@/api/queries'
import type { Body, Expense, ExpenseCategory, ExpenseDraft, ExpenseIn, ExpensePatch, Payment, Trip } from '@/api/types'
import { Button } from '@/components/ui/Button'
import { ChipGroup, Switch } from '@/components/ui/Choice'
import { Field, FieldError } from '@/components/ui/Field'
import { Sheet } from '@/components/ui/Sheet'
import { CATEGORIES, PAYMENTS, paise, paiseField, shrinkPhoto, toPaise } from '@/lib/expenses'
import { showToast } from '@/lib/store'
import { useSubmitKey } from '@/lib/submitKey'

export type SheetStart = { expense: Expense } | { draft: ExpenseDraft | null; photo?: Blob | null }

const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/

/** The receipt kept with an expense, fetched with the traveller's sign-in (an <img> can't send it). */
function ReceiptImage({ tripId, expenseId, photo }: { tripId: string; expenseId?: string; photo: Blob | null }) {
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let live = true
    let made: string | null = null
    setFailed(false)
    const show = (blob: Blob) => {
      made = URL.createObjectURL(blob)
      if (live) setUrl(made)
    }
    if (photo) show(photo)
    else if (expenseId)
      api
        .get<Response>(`/v1/trips/${tripId}/expenses/${expenseId}/receipt`, { raw: true })
        .then((res) => (res.ok ? res.blob() : Promise.reject(new Error(String(res.status)))))
        .then(show)
        .catch(() => live && setFailed(true))
    return () => {
      live = false
      if (made) URL.revokeObjectURL(made)
    }
  }, [tripId, expenseId, photo])
  if (failed)
    return (
      <p className="flex items-center gap-2 t-small text-muted">
        <ImageOff size={20} strokeWidth={1.75} aria-hidden="true" />
        Couldn’t load the receipt.
      </p>
    )
  return url ? <img src={url} alt="The receipt" className="max-h-72 w-auto max-w-full rounded-control border border-line object-contain" /> : null
}

/**
 * Add an expense, or look at and change one: what, how much, when, how it was paid, whether the office pays it
 * back, the GST for the office's records, and the receipt's photo. One from the plan can be confirmed as paid.
 */
export function ExpenseSheet({ trip, start, open, onOpenChange }: { trip: Trip; start: SheetStart | null; open: boolean; onOpenChange: (o: boolean) => void }) {
  const existing = start && 'expense' in start ? start.expense : null
  const draft = start && 'draft' in start ? start.draft : null
  const [day, setDay] = useState('')
  const [category, setCategory] = useState<ExpenseCategory | null>(null)
  const [title, setTitle] = useState('')
  const [merchant, setMerchant] = useState('')
  const [amount, setAmount] = useState('')
  const [tax, setTax] = useState('')
  const [gstin, setGstin] = useState('')
  const [payment, setPayment] = useState<Payment>('cash')
  const [reimbursable, setReimbursable] = useState(true)
  const [note, setNote] = useState('')
  const [photo, setPhoto] = useState<Blob | null>(null)
  const [dropReceipt, setDropReceipt] = useState(false)
  const [more, setMore] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<'save' | 'confirm' | 'delete' | null>(null)
  const { key, after, renew } = useSubmitKey('expense')
  const fileId = useId()
  const fileRef = useRef<HTMLInputElement>(null)
  const locked = !!existing?.claimId

  // Each opening starts from the expense, or from what was typed or read off a receipt.
  useEffect(() => {
    if (!open) return
    const e = existing
    const d = draft
    const today = trip.day
    setDay(e?.day ?? d?.day ?? today)
    setCategory(e?.category ?? d?.category ?? null)
    setTitle(e?.title ?? d?.title ?? '')
    setMerchant(e?.merchant ?? d?.merchant ?? '')
    setAmount(paiseField(e?.amountPaise ?? d?.amountPaise))
    setTax(paiseField(e?.taxPaise ?? d?.taxPaise))
    setGstin(e?.gstin ?? d?.gstin ?? '')
    setPayment(e?.payment ?? d?.payment ?? 'cash')
    setReimbursable(e ? e.reimbursable : true)
    setNote(e?.note ?? '')
    setPhoto(start && 'photo' in start ? (start.photo ?? null) : null)
    setDropReceipt(false)
    setMore(!!(e?.taxPaise || e?.gstin || e?.note || d?.taxPaise || d?.gstin))
    setErrors({})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, start])

  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.expenses(trip.tripId) })

  const check = () => {
    const e: Record<string, string> = {}
    const total = toPaise(amount)
    if (total === null) e.amount = 'Enter the amount, like 350 or 612.50.'
    if (!title.trim()) e.title = 'Say what it was, like Lunch or Cab to the airport.'
    if (!category) e.category = 'Choose what kind of expense it is.'
    if (!day) e.day = 'Choose the day.'
    const gst = tax.trim() ? toPaise(tax) : null
    if (tax.trim() && gst === null) e.tax = 'Enter the GST as an amount, like 54.'
    else if (gst !== null && total !== null && gst > total) e.tax = 'The GST can’t be more than the amount.'
    if (gstin.trim() && !GSTIN.test(gstin.trim().toUpperCase())) e.gstin = 'A GSTIN has 15 characters, like 29ABCDE1234F1Z5.'
    setErrors(e)
    return Object.keys(e).length === 0 ? { total: total!, gst } : null
  }

  const sendPhoto = async (expenseId: string) => {
    const url = `/v1/trips/${trip.tripId}/expenses/${expenseId}/receipt`
    if (photo) await api.upload('PUT', url, photo)
    else if (dropReceipt) await api.delete(url)
  }

  const save = async () => {
    const ok = check()
    if (!ok) return
    setBusy('save')
    const fields = {
      day,
      category: category!,
      title: title.trim(),
      merchant: merchant.trim() || null,
      note: note.trim() || null,
      amountPaise: ok.total,
      taxPaise: ok.gst,
      gstin: gstin.trim().toUpperCase() || null,
      payment,
      reimbursable: payment === 'company' ? false : reimbursable,
    }
    try {
      let saved: Expense
      if (existing) {
        const body: Body<ExpensePatch> = fields
        saved = await api.patch<Expense>(`/v1/trips/${trip.tripId}/expenses/${existing.expenseId}`, body)
      } else {
        const body: Body<ExpenseIn> = { ...fields, fromReceipt: draft?.source === 'receipt' }
        saved = await api.post<Expense>(`/v1/trips/${trip.tripId}/expenses`, body, { idempotencyKey: key })
        renew()
      }
      try {
        await sendPhoto(saved.expenseId)
      } catch (err) {
        showToast({ title: `Saved, but the receipt didn’t go: ${err instanceof ApiError ? err.message : 'try adding it again.'}` })
      }
      await refresh()
      onOpenChange(false)
      showToast({ title: existing ? 'Expense saved.' : `Added ${paise(saved.amountPaise)} for ${saved.title}.` })
    } catch (err) {
      after(err)
      setErrors({ form: err instanceof ApiError ? err.message : "Couldn't save it. Try again." })
    } finally {
      setBusy(null)
    }
  }

  const confirm = async () => {
    if (!existing) return
    setBusy('confirm')
    try {
      await api.patch(`/v1/trips/${trip.tripId}/expenses/${existing.expenseId}`, { confirm: true })
      await refresh()
      onOpenChange(false)
      showToast({ title: `Confirmed ${paise(existing.amountPaise)} as paid.` })
    } catch (err) {
      setErrors({ form: err instanceof ApiError ? err.message : "Couldn't confirm it. Try again." })
    } finally {
      setBusy(null)
    }
  }

  const remove = async () => {
    if (!existing) return
    setBusy('delete')
    try {
      await api.delete(`/v1/trips/${trip.tripId}/expenses/${existing.expenseId}`)
      await refresh()
      onOpenChange(false)
      showToast({ title: existing.source === 'manual' || existing.source === 'receipt' ? 'Expense deleted.' : 'Taken off your expenses.' })
    } catch (err) {
      setErrors({ form: err instanceof ApiError ? err.message : "Couldn't remove it. Try again." })
    } finally {
      setBusy(null)
    }
  }

  const pick = async (file: File | undefined) => {
    if (!file) return
    try {
      setPhoto(await shrinkPhoto(file))
      setDropReceipt(false)
    } catch (err) {
      showToast({ title: err instanceof Error ? err.message : "Couldn't open that photo." })
    }
  }

  const auto = existing && (existing.source === 'booking' || existing.source === 'plan')
  const hasReceipt = !dropReceipt && (photo !== null || !!existing?.hasReceipt)

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={existing ? (existing.estimate ? 'Confirm what you paid' : 'Expense') : draft?.source === 'receipt' ? 'Check the receipt' : 'Add an expense'}
      description={
        locked
          ? 'This expense is in a claim. Withdraw the claim to change it.'
          : existing?.estimate
            ? 'This is the plan’s estimate for the ride. Confirm it, or change the amount to what you paid.'
            : existing?.source === 'booking'
              ? 'From your booking, paid from the wallet.'
              : draft?.source === 'receipt'
                ? 'Read from your receipt. Check each field before saving.'
                : undefined
      }
      footer={
        locked ? undefined : (
          <div className="flex flex-col gap-2">
            {errors.form && <FieldError id="expense-err">{errors.form}</FieldError>}
            {existing?.estimate && (
              <Button full variant="secondary" icon={<Check size={20} strokeWidth={1.75} aria-hidden="true" />} loading={busy === 'confirm'} loadingLabel="Confirming…" disabled={busy !== null} onClick={() => void confirm()}>
                {`Confirm ${paise(existing.amountPaise)} as paid`}
              </Button>
            )}
            <Button full loading={busy === 'save'} loadingLabel="Saving…" disabled={busy !== null && busy !== 'save'} onClick={() => void save()}>
              {existing ? 'Save' : 'Add the expense'}
            </Button>
            {existing && (
              <Button variant="tertiary" size="md" className="self-center" icon={<Trash2 size={20} strokeWidth={1.75} aria-hidden="true" />} loading={busy === 'delete'} loadingLabel="Removing…" disabled={busy !== null} onClick={() => void remove()}>
                {auto ? 'Take off my expenses' : 'Delete the expense'}
              </Button>
            )}
          </div>
        )
      }
    >
      <fieldset disabled={locked} className="flex min-w-0 flex-col gap-5">
        <legend className="sr-only">The expense</legend>
        <Field label="Amount (₹)" inputMode="decimal" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value)} error={errors.amount} maxLength={14} />
        <Field label="What was it?" value={title} onChange={(e) => setTitle(e.target.value)} error={errors.title} maxLength={120} hint="Lunch, Cab to the airport, Printing…" />
        <div>
          <p className="mb-2 t-title text-ink">Kind</p>
          <ChipGroup<ExpenseCategory> legend="Kind of expense" name="expense-category" value={category} onChange={setCategory} options={CATEGORIES.map((c) => ({ value: c.value, label: c.label }))} />
          {errors.category && <p className="mt-2 t-small text-red-ink">{errors.category}</p>}
        </div>
        <Field label="Day" type="date" value={day} min={trip.startDate} max={trip.endDate} onChange={(e) => setDay(e.target.value)} error={errors.day} />
        <div>
          <p className="mb-2 t-title text-ink">Paid with</p>
          <ChipGroup<Payment> legend="Paid with" name="expense-payment" value={payment} onChange={setPayment} options={PAYMENTS.filter((p) => p.value !== 'wallet' || payment === 'wallet').map((p) => ({ value: p.value, label: p.label }))} />
        </div>
        {payment !== 'company' && (
          <div className="rounded-card border border-line px-4">
            <Switch label="Claim it back from the office" description="Off for something personal." checked={reimbursable} onChange={setReimbursable} />
          </div>
        )}
        <Field label="Shop or company" hint="Optional. Reroute remembers how you file each one." value={merchant} onChange={(e) => setMerchant(e.target.value)} maxLength={80} />

        <div>
          <p className="mb-2 t-title text-ink">Receipt</p>
          {hasReceipt && <ReceiptImage tripId={trip.tripId} expenseId={photo ? undefined : existing?.expenseId} photo={photo} />}
          <div className="mt-2 flex flex-wrap gap-2">
            <input ref={fileRef} id={fileId} type="file" accept="image/*" capture="environment" className="sr-only" onChange={(e) => void pick(e.target.files?.[0])} tabIndex={-1} />
            <Button variant="secondary" size="md" icon={<Camera size={20} strokeWidth={1.75} aria-hidden="true" />} onClick={() => fileRef.current?.click()}>
              {hasReceipt ? 'Replace the photo' : 'Add a receipt photo'}
            </Button>
            {hasReceipt && (
              <Button
                variant="tertiary"
                size="md"
                onClick={() => {
                  setPhoto(null)
                  setDropReceipt(!!existing?.hasReceipt)
                }}
              >
                Remove the photo
              </Button>
            )}
          </div>
        </div>

        {more ? (
          <>
            <Field label="GST included (₹)" hint="Optional, for the office’s tax credit." inputMode="decimal" value={tax} onChange={(e) => setTax(e.target.value)} error={errors.tax} maxLength={14} />
            <Field label="Seller’s GSTIN" hint="Optional. 15 characters, on the bill." autoCapitalize="characters" value={gstin} onChange={(e) => setGstin(e.target.value)} error={errors.gstin} maxLength={15} />
            <Field label="Note" hint="Optional: who it was with, why." value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
          </>
        ) : (
          <Button variant="tertiary" size="md" className="-ml-2 self-start" onClick={() => setMore(true)}>
            Add GST, GSTIN or a note
          </Button>
        )}
      </fieldset>
    </Sheet>
  )
}
