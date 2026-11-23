import { useEffect, useState } from 'react'
import { api, ApiError } from '@/api/client'
import { keys, queryClient, waitForJob } from '@/api/queries'
import type { Body, Place, Trip, TripEdit, TripPatch } from '@/api/types'
import { PlacePicker } from '@/components/PlacePicker'
import { Button } from '@/components/ui/Button'
import { Field, FieldError } from '@/components/ui/Field'
import { Sheet } from '@/components/ui/Sheet'
import { showToast } from '@/lib/store'

/** Change a trip's dates or where you stay (PATCH /v1/trips/:id). Its city stays: another city is a new trip. */
export function EditTripSheet({ trip, open, onOpenChange }: { trip: Trip; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [start, setStart] = useState(trip.startDate)
  const [end, setEnd] = useState(trip.endDate)
  const [stay, setStay] = useState<Place | null>(trip.stayPlace)
  const [errors, setErrors] = useState<{ start?: string; end?: string; stay?: string; form?: string }>({})
  const [busy, setBusy] = useState(false)

  // Each opening starts from the trip as it is now.
  useEffect(() => {
    if (!open) return
    setStart(trip.startDate)
    setEnd(trip.endDate)
    setStay(trip.stayPlace)
    setErrors({})
  }, [open, trip.startDate, trip.endDate, trip.stayPlace])

  const save = async () => {
    const e: typeof errors = {}
    if (!start) e.start = 'Choose the first day.'
    if (!end) e.end = 'Choose the last day.'
    else if (start && end < start) e.end = 'The last day must be on or after the first day.'
    if (!stay) e.stay = 'Choose where you are staying.'
    setErrors(e)
    if (Object.keys(e).length) return
    const body: Body<TripPatch> = {}
    if (start !== trip.startDate) body.startDate = start
    if (end !== trip.endDate) body.endDate = end
    if (stay!.placeId !== trip.stayPlace.placeId) Object.assign(body, { stayPlaceId: stay!.placeId, stayLabel: stay!.name })
    if (!Object.keys(body).length) return onOpenChange(false)
    setBusy(true)
    try {
      const res = await api.patch<TripEdit>(`/v1/trips/${trip.tripId}`, body)
      queryClient.setQueryData(keys.trip(trip.tripId), res.trip)
      void queryClient.invalidateQueries({ queryKey: keys.trips })
      onOpenChange(false)
      if (!res.jobId) return showToast({ title: 'Trip updated.' })
      // A new place to stay moves where the day starts and ends: the plan follows.
      showToast({ title: 'Trip updated. Re-planning your day from the new place…' })
      const done = await waitForJob(res.jobId).catch(() => null)
      await queryClient.invalidateQueries({ queryKey: keys.trip(trip.tripId) })
      showToast({ title: done && !done.error && done.status !== 'failed' ? 'Your day is planned from the new place.' : "Couldn't re-plan the day. Open Plan to try again." })
    } catch (err) {
      setErrors({ form: err instanceof ApiError ? err.message : "Couldn't save the trip. Try again." })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Change the trip"
      description={`Its dates, or where you stay in ${trip.cityName}. For another city, start a new trip.`}
      footer={
        <div className="flex flex-col gap-2">
          {errors.form && <FieldError id="edit-trip-err">{errors.form}</FieldError>}
          <Button full loading={busy} loadingLabel="Saving…" onClick={() => void save()}>
            Save the trip
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="First day" type="date" value={start} onChange={(e) => setStart(e.target.value)} error={errors.start} />
          <Field label="Last day" type="date" value={end} min={start} onChange={(e) => setEnd(e.target.value)} error={errors.end} hint="A trip lasts up to 14 days." />
        </div>
        <PlacePicker
          label="Where are you staying?"
          city={trip.citySlug}
          cityName={trip.cityName}
          near={[trip.stayPlace.lng, trip.stayPlace.lat]}
          value={stay}
          onChange={setStay}
          error={errors.stay}
          hint={`Your hotel or where you sleep in ${trip.cityName}.`}
        />
      </div>
    </Sheet>
  )
}
