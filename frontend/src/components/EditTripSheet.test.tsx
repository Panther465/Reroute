import { QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError } from '@/api/client'
import { keys, queryClient } from '@/api/queries'
import type { Place, Trip } from '@/api/types'
import * as store from '@/lib/store'
import { goldenTrip, places } from '@/test/fixtures'
import { EditTripSheet } from './EditTripSheet'

// Place search needs the API: a stand-in that picks one known place.
vi.mock('@/components/PlacePicker', () => ({
  PlacePicker: ({ value, onChange }: { value: Place | null; onChange: (p: Place) => void }) => (
    <button type="button" onClick={() => onChange({ ...value!, placeId: 'jayanagar-office', name: 'Jayanagar office' })}>
      Staying at {value?.name}
    </button>
  ),
}))

function trip(): Trip {
  return { ...goldenTrip(), sample: false, startDate: '2026-10-14', endDate: '2026-10-15', stayPlace: places.hotel }
}

function sheet(t = trip(), onOpenChange = vi.fn()) {
  render(
    <QueryClientProvider client={queryClient}>
      <EditTripSheet trip={t} open onOpenChange={onOpenChange} />
    </QueryClientProvider>,
  )
  return onOpenChange
}

const save = () => act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save the trip' })))

afterEach(() => {
  vi.restoreAllMocks()
  queryClient.clear()
})

describe('changing a trip', () => {
  it('sends only what changed, and keeps the trip it gets back', async () => {
    const t = trip()
    const patch = vi.spyOn(api, 'patch').mockResolvedValue({ trip: { ...t, endDate: '2026-10-17' }, jobId: null })
    const toast = vi.spyOn(store, 'showToast')
    const onOpenChange = sheet(t)
    fireEvent.change(screen.getByLabelText('Last day'), { target: { value: '2026-10-17' } })
    await save()
    expect(patch).toHaveBeenCalledWith(`/v1/trips/${t.tripId}`, { endDate: '2026-10-17' })
    expect(queryClient.getQueryData<Trip>(keys.trip(t.tripId))?.endDate).toBe('2026-10-17')
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(toast).toHaveBeenCalledWith({ title: 'Trip updated.' })
  })

  it('sends a new place to stay with its name', async () => {
    const t = trip()
    const patch = vi.spyOn(api, 'patch').mockResolvedValue({ trip: t, jobId: null })
    sheet(t)
    fireEvent.click(screen.getByRole('button', { name: /Staying at/ }))
    await save()
    expect(patch).toHaveBeenCalledWith(`/v1/trips/${t.tripId}`, { stayPlaceId: 'jayanagar-office', stayLabel: 'Jayanagar office' })
  })

  it('checks the dates first, and shows why the server said no', async () => {
    const patch = vi.spyOn(api, 'patch').mockRejectedValue(new ApiError(409, 'TASKS_OUTSIDE_DATES', 'You have a task on days outside those dates. Move or remove them first.'))
    sheet()
    fireEvent.change(screen.getByLabelText('Last day'), { target: { value: '2026-10-01' } })
    await save()
    expect(screen.getByText('The last day must be on or after the first day.')).toBeTruthy()
    expect(patch).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('First day'), { target: { value: '2026-10-15' } })
    fireEvent.change(screen.getByLabelText('Last day'), { target: { value: '2026-10-15' } })
    await save()
    expect(screen.getByText('You have a task on days outside those dates. Move or remove them first.')).toBeTruthy()
  })

  it('closes without a call when nothing changed', async () => {
    const patch = vi.spyOn(api, 'patch')
    const onOpenChange = sheet()
    await save()
    expect(patch).not.toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
