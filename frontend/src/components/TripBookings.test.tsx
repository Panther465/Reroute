import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Booking } from '@/api/types'
import { goldenTrip } from '@/test/fixtures'

const ticket: Booking = {
  bookingId: 'bk_1',
  tripId: 'trip-001',
  kind: 'ticket',
  taskId: null,
  toId: null,
  provider: 'sightpass',
  status: 'confirmed',
  reference: 'SPABCD2345',
  fareInr: 300,
  details: { partner: 'SightPass', placeId: 'place-lalbagh', place: 'Lalbagh Botanical Garden', date: '2026-10-14', ticket: 'guided', ticketLabel: 'Entry and a guided tour', visitors: 2, fareEachInr: 150 },
  createdAt: '2026-10-14T05:00:00Z',
  demo: true,
}
vi.mock('@/api/queries', () => ({ useBookingsEnabled: () => true, useBookings: () => ({ data: [ticket] }) }))

import { TripBookings } from './TripBookings'

describe('entry tickets in the trip’s bookings', () => {
  it('lists them, and opens them as a ticket with Cancel', async () => {
    render(<TripBookings trip={goldenTrip()} />)
    expect(screen.getByText('Lalbagh Botanical Garden, SightPass')).toBeTruthy()
    expect(screen.getByText('Ticket SPABCD2345, ₹300')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Lalbagh/ }))
    expect(await screen.findByRole('dialog', { name: 'Your tickets' }, { timeout: 8000 })).toBeTruthy()
    expect(screen.getByText('Entry and a guided tour, 2 people')).toBeTruthy()
    expect(screen.getByText('₹150 each')).toBeTruthy()
    expect(screen.getByText('Ticket SPABCD2345')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Cancel the tickets' })).toBeTruthy()
  })
})
