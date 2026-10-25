import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/api/client'
import type { Place } from '@/api/types'
import { places } from '@/test/fixtures'
import { PlacePicker } from './PlacePicker'

vi.mock('@/components/LazyMap', () => ({ LazyMap: () => <div>Map</div>, MapUnavailable: () => null }))

const flat: Place = { placeId: 'own-1a2b3c4d5e6f', name: 'Aunt’s flat', area: 'Koramangala', lng: 77.6201, lat: 12.9349, sample: false, category: 'stay', mine: true }
const chai: Place = { placeId: 'own-6f5e4d3c2b1a', name: 'Bank Street chai', area: 'Koramangala', lng: 77.62, lat: 12.935, sample: false, category: 'food', mine: false }

function picker(onChange = vi.fn()) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <PlacePicker label="Place" city="bengaluru" cityName="Bengaluru" near={[77.5713, 12.9767]} value={null} onChange={onChange} />
    </QueryClientProvider>,
  )
  return onChange
}

afterEach(() => vi.restoreAllMocks())

describe('place search with your own places', () => {
  it('lists your places first, marked as yours, then the rest', async () => {
    const get = vi.spyOn(api, 'get').mockResolvedValue([flat, places.kor, chai])
    const onChange = picker()
    fireEvent.change(screen.getByLabelText('Place'), { target: { value: 'Ko' } })
    const list = await screen.findByRole('list', { name: 'Places found' })
    // The search waits for typing to pause: under load the list can show before it's asked.
    await waitFor(() => expect(get).toHaveBeenCalledWith('/v1/places', { query: { q: 'Ko', city: 'bengaluru' } }))
    const rows = await within(list).findAllByRole('button')
    expect(rows.map((b) => b.textContent)).toEqual(['Aunt’s flatKoramangala, your place', 'Bank, 80 Feet RoadKoramangala, sample place', 'Bank Street chaiKoramangala, added by a traveller'])
    expect(within(list).getByText('Your places')).toBeTruthy()
    expect(within(list).getByText('Other places')).toBeTruthy()
    fireEvent.click(rows[0])
    expect(onChange).toHaveBeenCalledWith(flat)
  })

  it('adds a place that isn’t there, starting from what was typed', async () => {
    vi.spyOn(api, 'get').mockResolvedValue([])
    picker()
    fireEvent.change(screen.getByLabelText('Place'), { target: { value: 'Aunt’s flat' } })
    await screen.findByText('No places match. Try the area name, like Koramangala.')
    fireEvent.click(screen.getByRole('button', { name: 'Not here? Add it as your own place' }))
    // The sheet's code loads the first time it opens.
    const sheet = await screen.findByRole('dialog', {}, { timeout: 5000 })
    expect(within(sheet).getByRole('heading', { name: 'Add a place' })).toBeTruthy()
    expect((within(sheet).getByLabelText('Name') as HTMLInputElement).value).toBe('Aunt’s flat')
    // No pin until the traveller taps where it is: one at the city's centre would be easy to leave there by mistake.
    expect(within(sheet).getByText('Tap the map where the place is.')).toBeTruthy()
  })
})
