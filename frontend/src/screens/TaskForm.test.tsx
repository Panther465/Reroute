import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { Trip } from '@/api/types'
import { goldenTrip } from '@/test/fixtures'
import { TaskFormSheet } from './TaskForm'

function wrap(children: ReactNode) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
}

function form(trip: Trip, open = true, task = trip.tasks[1]) {
  return wrap(<TaskFormSheet trip={trip} open={open} onOpenChange={() => {}} initial={task} onSave={vi.fn()} />)
}

describe('TaskFormSheet', () => {
  it('keeps what the traveller typed when the trip refetches (a new trip object)', () => {
    const { rerender } = render(form(goldenTrip('10:55')))
    const title = screen.getByLabelText('Title') as HTMLInputElement
    expect(title.value).toBe('Bank')
    fireEvent.change(title, { target: { value: 'Bank, second visit' } })
    // The 60 s refresh, a live event or window focus: same trip, new object, new clock.
    rerender(form(goldenTrip('10:56')))
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Bank, second visit')
  })

  it('starts fresh when it opens again or switches to another task', () => {
    const trip = goldenTrip('10:55')
    const { rerender } = render(form(trip))
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Changed' } })
    rerender(form(trip, true, trip.tasks[2]))
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('University office')
    rerender(form(trip, false, trip.tasks[2]))
    rerender(form(goldenTrip('11:00'), true, trip.tasks[2]))
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('University office')
  })
})
