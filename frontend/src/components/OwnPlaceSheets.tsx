import { Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ApiError } from '@/api/client'
import type { OwnPlace, PlaceCategory } from '@/api/types'
import { LazyMap } from '@/components/LazyMap'
import type { MapPoint } from '@/components/MapCard'
import { Button } from '@/components/ui/Button'
import { ChipGroup, Switch } from '@/components/ui/Choice'
import { Field, FieldError, inputClass } from '@/components/ui/Field'
import { Sheet } from '@/components/ui/Sheet'
import { Tag } from '@/components/ui/Tag'
import type { LngLat } from '@/lib/geo'
import { CATEGORIES, NAME_MAX, NOTE_MAX, STATUS, categoryOf, deleteOwnPlace, saveOwnPlace } from '@/lib/ownPlaces'
import { showToast } from '@/lib/store'
import { useSubmitKey } from '@/lib/submitKey'

/**
 * Add a place that isn't on the map: its name, what kind of place it is, a note for yourself, and whether to
 * share it with everyone (a moderator checks it first). The pin starts where the traveller pressed and moves
 * with a tap on the map; from place search there's no pin until they tap where the place is.
 */
export function AddPlaceSheet({
  open,
  onOpenChange,
  city,
  cityName,
  at,
  near,
  initialName = '',
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The city being planned: the place must be inside it. */
  city: string
  cityName: string
  /** Where the pin starts, if anywhere. */
  at: LngLat | null
  /** Where the map opens without a pin: the stay, or the city's centre. */
  near?: LngLat | null
  initialName?: string
  onSaved?: (place: OwnPlace) => void
}) {
  const [name, setName] = useState(initialName)
  const [category, setCategory] = useState<PlaceCategory | null>(null)
  const [note, setNote] = useState('')
  const [share, setShare] = useState(false)
  const [point, setPoint] = useState<LngLat | null>(at)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const { key, renew, after } = useSubmitKey('place')
  const formRef = useRef<HTMLDivElement>(null)

  // The first thing to fix takes focus, so it's scrolled into view and heard.
  useEffect(() => {
    const form = formRef.current
    if (errors.name) form?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
    else if (errors.category) form?.querySelector<HTMLElement>('input[name="place-category"]')?.focus()
  }, [errors])

  // A fresh form each time the sheet opens, with the pin where it was asked for.
  useEffect(() => {
    if (!open) return
    setName(initialName)
    setCategory(null)
    setNote('')
    setShare(false)
    setPoint(at)
    setErrors({})
    // Only opening resets; `at` and `initialName` are read for their values at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const pin = useMemo<MapPoint[]>(() => (point ? [{ id: 'new-place', lngLat: point, kind: 'saved', label: 'Where the new place is', icon: categoryOf(category).Icon }] : []), [point, category])

  const save = async () => {
    const e: Record<string, string> = {}
    if (name.trim().length < 2) e.name = 'Give the place a name, like Aunt’s flat.'
    if (!category) e.category = 'Choose what kind of place it is.'
    if (!point) e.form = 'Tap the map where the place is.'
    setErrors(e)
    if (Object.keys(e).length || !category || !point) return
    setBusy(true)
    try {
      const round = (x: number) => Math.round(x * 1e6) / 1e6
      const place = await saveOwnPlace({ name: name.trim(), category, note: note.trim() || null, lng: round(point[0]), lat: round(point[1]), citySlug: city, share }, key)
      renew()
      showToast({ title: share ? `Saved ${place.name}. Everyone can find it once a moderator approves it.` : `Saved ${place.name} to your places.` })
      onSaved?.(place)
      onOpenChange(false)
    } catch (err) {
      after(err)
      setErrors({ form: err instanceof ApiError ? err.message : "Couldn't save the place. Try again." })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet
      open={open}
      // Closing mid-save would hide whether the place was kept.
      onOpenChange={(o) => !busy && onOpenChange(o)}
      title="Add a place"
      description={`Somewhere in ${cityName} that isn't on the map. Only you see it unless you share it.`}
      footer={
        <div className="flex flex-col gap-2">
          {errors.form && (
            <div role="alert">
              <FieldError id="add-place-err">{errors.form}</FieldError>
            </div>
          )}
          <Button full onClick={save} loading={busy} loadingLabel="Saving…">
            Save the place
          </Button>
        </div>
      }
    >
      <div ref={formRef} className="flex flex-col gap-6">
        <div>
          <LazyMap lines={[]} points={pin} label="Map for the new place. Tap where it is." className="h-48" onMapClick={setPoint} center={at ?? near ?? undefined} />
          <p className="mt-2 t-small text-muted">{point ? 'Tap the map to move the pin.' : 'Tap the map where the place is.'}</p>
        </div>
        <Field label="Name" value={name} onChange={(e) => setName(e.target.value)} error={errors.name} maxLength={NAME_MAX} autoComplete="off" />
        <div>
          <p aria-hidden="true" className="mb-2 t-title text-ink">
            What kind of place
          </p>
          <ChipGroup legend="What kind of place" name="place-category" value={category} onChange={setCategory} options={CATEGORIES.map((c) => ({ value: c.value, label: c.label }))} />
          {errors.category && <FieldError id="add-place-category-err">{errors.category}</FieldError>}
        </div>
        <div>
          <label htmlFor="add-place-note" className="mb-1 block t-title text-ink">
            Note <span className="t-small font-normal text-muted">Optional</span>
          </label>
          <p id="add-place-note-hint" className="mb-2 t-small text-ink-2">
            For you alone, even if you share the place: the gate, a landmark, who to ask for.
          </p>
          <textarea
            id="add-place-note"
            aria-describedby="add-place-note-hint"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            maxLength={NOTE_MAX}
            className={`${inputClass} resize-none py-3`}
          />
        </div>
        <Switch checked={share} onChange={setShare} label="Share with everyone" description="A moderator checks it first. Until then, only you see it." />
      </div>
    </Sheet>
  )
}

/** One of the traveller's own places, opened from its pin: what it is, who sees it, and deleting it. */
export function OwnPlaceSheet({ place, onOpenChange }: { place: OwnPlace | null; onOpenChange: (open: boolean) => void }) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const placeId = place?.placeId
  useEffect(() => {
    setConfirming(false)
    setError(undefined)
  }, [placeId])
  if (!place) return null
  const kind = categoryOf(place.category)
  const status = STATUS[place.status]
  const remove = async () => {
    setBusy(true)
    setError(undefined)
    try {
      await deleteOwnPlace(place)
      showToast({ title: `Deleted ${place.name}.` })
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't delete the place. Try again.")
    } finally {
      setBusy(false)
    }
  }
  return (
    <Sheet
      open
      onOpenChange={(o) => !busy && onOpenChange(o)}
      title={place.name}
      description={`${kind.label}, ${place.area}. Your place.`}
      footer={
        <div className="flex flex-col gap-2">
          {error && (
            <div role="alert">
              <FieldError id="own-place-err">{error}</FieldError>
            </div>
          )}
          {confirming ? (
            <>
              <p className="t-small text-ink-2">A trip that already goes there keeps it. This can't be undone.</p>
              <Button variant="destructive" full loading={busy} loadingLabel="Deleting…" onClick={() => void remove()}>
                Delete {place.name}
              </Button>
              <Button variant="tertiary" size="md" className="self-center" onClick={() => setConfirming(false)}>
                Keep it
              </Button>
            </>
          ) : (
            <Button variant="destructive" full icon={<Trash2 size={20} strokeWidth={1.75} aria-hidden="true" />} onClick={() => setConfirming(true)}>
              Delete this place
            </Button>
          )}
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-2">
          <Tag tone={status.tone}>{status.label}</Tag>
        </div>
        {place.status === 'rejected' && place.rejectReason && <p className="t-small text-red-ink">Not shared: {place.rejectReason}</p>}
        {place.status === 'pending' && <p className="t-small text-ink-2">A moderator checks it before everyone can find it. Until then, only you see it.</p>}
        {place.note && (
          <div>
            <p className="t-small text-muted">Your note (only you see it)</p>
            <p className="mt-1 whitespace-pre-line t-body text-ink">{place.note}</p>
          </div>
        )}
      </div>
    </Sheet>
  )
}
