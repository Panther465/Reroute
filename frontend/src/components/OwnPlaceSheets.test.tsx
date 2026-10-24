import { QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError } from '@/api/client'
import { keys, queryClient } from '@/api/queries'
import type { OwnPlace } from '@/api/types'
import * as store from '@/lib/store'
import { AddPlaceSheet, OwnPlaceSheet } from './OwnPlaceSheets'

// MapLibre needs WebGL: a stand-in map where a tap lands at one known point.
vi.mock('@/components/LazyMap', () => ({
  LazyMap: ({ points, onMapClick }: { points: { lngLat: [number, number] }[]; onMapClick?: (at: [number, number]) => void }) => (
    <button type="button" onClick={() => onMapClick?.([77.6342, 12.9719])}>
      {points.length ? `Pin at ${points[0].lngLat.join(', ')}` : 'No pin'}
    </button>
  ),
  MapUnavailable: () => null,
}))

const saved: OwnPlace = {
  placeId: 'own-1a2b3c4d5e6f',
  name: 'Aunt’s flat',
  area: 'Indiranagar',
  lng: 77.6342,
  lat: 12.9719,
  sample: false,
  category: 'stay',
  mine: true,
  citySlug: 'bengaluru',
  note: 'Gate 2, ask for Ravi',
  status: 'private',
  rejectReason: null,
  createdAt: '2026-10-25T10:00:00+05:30',
}

function wrap(children: ReactNode) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

function sheet(onSaved = vi.fn(), onOpenChange = vi.fn()) {
  return render(wrap(<AddPlaceSheet open onOpenChange={onOpenChange} city="bengaluru" cityName="Bengaluru" at={[77.6, 12.97]} initialName="Aunt’s" onSaved={onSaved} />))
}

afterEach(() => {
  vi.restoreAllMocks()
  queryClient.clear()
})

describe('adding a place of your own', () => {
  it('asks for a name and a kind before saving anything', async () => {
    const post = vi.spyOn(api, 'post')
    sheet()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: ' ' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save the place' }))
    })
    expect(screen.getByText('Give the place a name, like Aunt’s flat.')).toBeTruthy()
    expect(screen.getByText('Choose what kind of place it is.')).toBeTruthy()
    expect(post).not.toHaveBeenCalled()
  })

  it('saves the name, kind, note and sharing at the pin, then the pin shows on the map', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({ ...saved, status: 'pending' })
    const toast = vi.spyOn(store, 'showToast')
    queryClient.setQueryData(keys.ownPlaces('bengaluru'), [])
    const onSaved = vi.fn()
    const onOpenChange = vi.fn()
    sheet(onSaved, onOpenChange)
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Aunt’s')
    expect(screen.getByRole('button', { name: 'Pin at 77.6, 12.97' })).toBeTruthy()
    // A tap on the map moves the pin.
    fireEvent.click(screen.getByRole('button', { name: 'Pin at 77.6, 12.97' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '  Aunt’s flat ' } })
    fireEvent.click(screen.getByLabelText('Stay'))
    fireEvent.change(screen.getByLabelText(/^Note/), { target: { value: 'Gate 2, ask for Ravi' } })
    fireEvent.click(screen.getByRole('switch', { name: /Share with everyone/ }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save the place' }))
    })
    expect(post).toHaveBeenCalledWith(
      '/v1/me/places',
      { name: 'Aunt’s flat', category: 'stay', note: 'Gate 2, ask for Ravi', lng: 77.6342, lat: 12.9719, citySlug: 'bengaluru', share: true },
      { idempotencyKey: expect.stringMatching(/^place-/) },
    )
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ placeId: saved.placeId }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(toast).toHaveBeenCalledWith({ title: 'Saved Aunt’s flat. Everyone can find it once a moderator approves it.' })
    // The map's list of your places has it at once.
    expect(queryClient.getQueryData<OwnPlace[]>(keys.ownPlaces('bengaluru'))?.map((p) => p.placeId)).toEqual([saved.placeId])
  })

  it('says why the server refused, and stays open to fix it', async () => {
    vi.spyOn(api, 'post').mockRejectedValue(new ApiError(422, 'VALIDATION_ERROR', "That point is outside Bengaluru. Add places in the city you're planning in."))
    const onOpenChange = vi.fn()
    sheet(vi.fn(), onOpenChange)
    fireEvent.click(screen.getByLabelText('Food'))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save the place' }))
    })
    expect(screen.getByRole('alert').textContent).toContain("That point is outside Bengaluru. Add places in the city you're planning in.")
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })
})

describe('one of your places, from its pin', () => {
  it('says who sees it and keeps the note to you', () => {
    render(wrap(<OwnPlaceSheet place={{ ...saved, status: 'rejected', rejectReason: 'It looks like a private home.' }} onOpenChange={vi.fn()} />))
    expect(screen.getByRole('heading', { name: 'Aunt’s flat' })).toBeTruthy()
    expect(screen.getByText('Not shared')).toBeTruthy()
    expect(screen.getByText('Not shared: It looks like a private home.')).toBeTruthy()
    expect(screen.getByText('Gate 2, ask for Ravi')).toBeTruthy()
  })

  it('deletes it after asking, and takes its pin off the map', async () => {
    const del = vi.spyOn(api, 'delete').mockResolvedValue(undefined)
    queryClient.setQueryData(keys.ownPlaces('bengaluru'), [saved])
    const onOpenChange = vi.fn()
    render(wrap(<OwnPlaceSheet place={saved} onOpenChange={onOpenChange} />))
    fireEvent.click(screen.getByRole('button', { name: 'Delete this place' }))
    expect(del).not.toHaveBeenCalled()
    expect(screen.getByText("A trip that already goes there keeps it. This can't be undone.")).toBeTruthy()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete Aunt’s flat' }))
    })
    expect(del).toHaveBeenCalledWith(`/v1/me/places/${saved.placeId}`)
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(queryClient.getQueryData<OwnPlace[]>(keys.ownPlaces('bengaluru'))).toEqual([])
  })
})
