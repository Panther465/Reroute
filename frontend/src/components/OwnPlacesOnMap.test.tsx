import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { keys } from '@/api/queries'
import type { OwnPlace } from '@/api/types'
import { goldenTrip } from '@/test/fixtures'
import { useOwnPlacesOnMap } from './OwnPlacesOnMap'

vi.mock('@/components/LazyMap', () => ({ LazyMap: () => <div>Map</div>, MapUnavailable: () => null }))

const place = (placeId: string, name: string, extra: Partial<OwnPlace> = {}): OwnPlace => ({
  placeId,
  name,
  area: 'Koramangala',
  lng: 77.62,
  lat: 12.935,
  sample: false,
  category: 'food',
  mine: true,
  citySlug: 'bengaluru',
  note: null,
  status: 'private',
  rejectReason: null,
  createdAt: '2026-10-25T10:00:00+05:30',
  ...extra,
})

const trip = goldenTrip('10:55')

/** A trip's map, reduced to what the hook gives it: the pins, a press and hold, and the sheets. */
function Map({ shown }: { shown: string[] }) {
  const own = useOwnPlacesOnMap(trip, shown)
  return (
    <>
      <ul aria-label="Pins">
        {own.points.map((p) => (
          <li key={p.id}>
            <button type="button" onClick={p.onClick}>
              {p.kind}: {p.label}
            </button>
          </li>
        ))}
      </ul>
      <button type="button" onClick={() => own.onLongPress([77.6, 12.93])}>
        Press and hold
      </button>
      {own.sheets}
    </>
  )
}

function show(shown: string[] = []) {
  const client = new QueryClient()
  client.setQueryData(keys.ownPlaces('bengaluru'), [place('own-aaaaaaaaaaaa', 'Chai stall'), place('own-bbbbbbbbbbbb', 'Cousin’s house', { category: 'stay' })])
  render(
    <QueryClientProvider client={client}>
      <Map shown={shown} />
    </QueryClientProvider>,
  )
}

describe('your places on a trip’s map', () => {
  it('pins each of your places apart from the day’s stops, once', () => {
    show(['own-bbbbbbbbbbbb'])
    const pins = within(screen.getByRole('list', { name: 'Pins' })).getAllByRole('button')
    // The cousin's house is a stop of the day already: no second pin.
    expect(pins.map((b) => b.textContent)).toEqual(['saved: Chai stall, your place'])
  })

  it('opens the place from its pin, and adds one where the map was held', async () => {
    show()
    fireEvent.click(screen.getByRole('button', { name: 'saved: Cousin’s house, your place' }))
    expect(within(await screen.findByRole('dialog', {}, { timeout: 5000 })).getByRole('heading', { name: 'Cousin’s house' })).toBeTruthy()
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Press and hold' }))
    const sheet = await screen.findByRole('dialog', { name: 'Add a place' }, { timeout: 5000 })
    expect(within(sheet).getByText('Somewhere in Bengaluru that isn\'t on the map. Only you see it unless you share it.')).toBeTruthy()
  })
})
