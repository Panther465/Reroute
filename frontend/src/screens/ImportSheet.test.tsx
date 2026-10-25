import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/api/client'
import type { TaskDraft } from '@/api/types'
import { goldenTrip, places } from '@/test/fixtures'

const google = vi.hoisted(() => ({ requestGoogleCode: vi.fn(async () => '4/code') }))
vi.mock('@/lib/google', async (real) => ({ ...(await real<object>()), ...google, googleEnabled: true }))
const actions = vi.hoisted(() => ({ addTask: vi.fn(async (..._args: unknown[]) => ({ outcome: 'saved' })) }))
vi.mock('@/lib/actions', async (real) => ({ ...(await real<object>()), ...actions }))
vi.mock('@/components/LazyMap', () => ({ LazyMap: () => <div>Map</div>, MapUnavailable: () => null }))

import { CALENDAR_SCOPE } from '@/lib/google'
import { ImportSheet } from './PlanDay'

const DRAFTS: TaskDraft[] = [
  { title: 'Dentist', placeText: 'Apollo Clinic, Jayanagar', placeId: places.jay.placeId, place: places.jay, durationMin: 45, fixedStart: '2026-10-14T10:00:00+05:30', priority: 2, source: 'calendar' },
  { title: 'Client call', placeText: 'Their office', placeId: null, place: null, durationMin: 30, fixedStart: '2026-10-15T16:00:00+05:30', priority: 2, source: 'calendar' },
]

afterEach(() => vi.restoreAllMocks())

describe('importing from Google Calendar', () => {
  it('reads the trip’s appointments, ticks those with a place, and lets you choose one for the rest', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue(DRAFTS)
    vi.spyOn(api, 'get').mockResolvedValue([places.kor])
    const onAdded = vi.fn()
    const trip = goldenTrip('07:30')
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <ImportSheet trip={trip} open onOpenChange={() => {}} onAdded={onAdded} />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Allow read-only access' }))
    await screen.findByText('Dentist')
    expect(google.requestGoogleCode).toHaveBeenCalledWith(CALENDAR_SCOPE)
    expect(post).toHaveBeenCalledWith('/v1/trips/trip-001/calendar-import', { code: '4/code' }, expect.objectContaining({ idempotencyKey: expect.any(String) }))

    // The trip has two days: each appointment says which, its time and length, and where its place matched.
    const dentist = screen.getByRole('checkbox', { name: /Dentist/ })
    expect((dentist as HTMLInputElement).checked).toBe(true)
    expect(screen.getByText('Wednesday, 10:00, 45 min')).toBeTruthy()
    expect(screen.getByText('University admin office, Jayanagar')).toBeTruthy()
    const call = screen.getByRole('checkbox', { name: /Client call/ }) as HTMLInputElement
    expect(call.checked).toBe(false)
    expect(call.disabled).toBe(true)
    expect(screen.getByText('Thursday, 16:00, 30 min')).toBeTruthy()

    // Choosing its place ticks it.
    fireEvent.change(screen.getByLabelText('Where is the client call?'), { target: { value: 'Ko' } })
    const found = await screen.findByRole('list', { name: 'Places found' })
    fireEvent.click(await within(found).findByRole('button', { name: /Bank, 80 Feet Road/ }))
    await waitFor(() => expect(call.checked).toBe(true))

    fireEvent.click(screen.getByRole('button', { name: 'Add 2 tasks' }))
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith(2))
    // The day re-plans once, after the last.
    expect(actions.addTask.mock.calls.map((c) => [(c[1] as { placeId: string; day: string }).placeId, (c[1] as { day: string }).day, (c[3] as { replan: boolean }).replan])).toEqual([
      ['jayanagar-office', '2026-10-14', false],
      ['koramangala-bank', '2026-10-15', true],
    ])
  })
})
