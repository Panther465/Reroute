import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/client'
import type { CheckinResult, Option, Trip } from '@/api/types'
import * as actions from '@/lib/actions'
import { goldenTrip } from '@/test/fixtures'
import { RunningLateSheet } from './RunningLateSheet'

const option: Option = {
  optionId: 'opt-cab',
  kind: 'faster_mode',
  label: 'Take a cab to the bank',
  consequence: 'All three tasks still happen today',
  explanation: 'A cab saves about 25 min.',
  extraFareInr: 180,
  timeSavedMin: 25,
  movedTasks: [],
  reasonCodes: ['FASTER_MODE'],
} as unknown as Option

function wrap(children: ReactNode) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
}

function sheet(trip: Trip, open = true) {
  return wrap(<RunningLateSheet trip={trip} clock={655} open={open} onOpenChange={() => {}} initialDelay={null} mode="late" />)
}

afterEach(() => vi.restoreAllMocks())

describe('RunningLateSheet', () => {
  it('keeps showing the options when the trip refetches with them (no jump back to the delay chips)', async () => {
    vi.spyOn(actions, 'reportDelay').mockResolvedValue({ checkinId: 'c1', planId: null, result: 'options', reasonCodes: [], explanation: 'Your later stops no longer fit.', options: [option] } as CheckinResult)
    const trip = goldenTrip('10:55')
    const withOptions = goldenTrip('10:55', { openOptions: { optionSetId: 'set-1', reasonCodes: [], explanation: 'Your later stops no longer fit.', options: [option] } })
    vi.spyOn(actions, 'refetchTrip').mockResolvedValue(withOptions)
    const { rerender } = render(sheet(trip))
    expect(screen.getByRole('heading', { name: 'How late will the meeting run?' })).toBeTruthy()
    fireEvent.click(screen.getByLabelText('About 40 min'))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Update my times' }))
    })
    expect(screen.getByRole('heading', { name: 'Choose how to fix your day' })).toBeTruthy()

    // The trip refetches: options_ready, the 60 s refresh, or the invalidation after the answer.
    const refetched = goldenTrip('10:55', { openOptions: { optionSetId: 'set-1', reasonCodes: [], explanation: 'Your later stops no longer fit.', options: [option] } })
    rerender(sheet(refetched))
    rerender(sheet(goldenTrip('10:56', { openOptions: refetched.openOptions })))
    expect(screen.getByRole('heading', { name: 'Choose how to fix your day' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reroute my day' })).toBeTruthy()
  })

  it('stays open while rerouting and shows an error there if it fails', async () => {
    let fail: (e: unknown) => void = () => {}
    vi.spyOn(actions, 'acceptOption').mockImplementation(() => new Promise((_r, reject) => (fail = reject)))
    const onOpenChange = vi.fn()
    const trip = goldenTrip('10:55', { openOptions: { optionSetId: 'set-1', reasonCodes: [], explanation: 'Your later stops no longer fit.', options: [option] } })
    render(wrap(<RunningLateSheet trip={trip} clock={655} open onOpenChange={onOpenChange} initialDelay={null} mode="options" />))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reroute my day' }))
    })
    expect(actions.acceptOption).toHaveBeenCalledWith('trip-001', 'opt-cab', 'set-1', expect.any(String))
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    await act(async () => fail(new Error('network')))
    expect(screen.getByRole('alert').textContent).toContain("Couldn't reroute. Try again.")
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })

  it('shows the fresh options, never applying anything, when the option set changed (409)', async () => {
    vi.spyOn(actions, 'acceptOption').mockRejectedValue(new ApiError(409, 'OPTIONS_CHANGED', 'Those options have changed.'))
    const fresh = { ...option, optionId: 'opt-move', label: 'Move the office to tomorrow' } as Option
    vi.spyOn(actions, 'refetchTrip').mockResolvedValue(goldenTrip('11:00', { openOptions: { optionSetId: 'set-2', reasonCodes: [], explanation: 'Your later stops no longer fit.', options: [fresh] } }))
    const play = vi.spyOn(actions, 'applyServerChange')
    const onOpenChange = vi.fn()
    const trip = goldenTrip('10:55', { openOptions: { optionSetId: 'set-1', reasonCodes: [], explanation: 'Your later stops no longer fit.', options: [option] } })
    render(wrap(<RunningLateSheet trip={trip} clock={655} open onOpenChange={onOpenChange} initialDelay={null} mode="options" />))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reroute my day' }))
    })
    expect(screen.getByText('Your options changed. Check them again.')).toBeTruthy()
    expect(screen.getByText('Move the office to tomorrow')).toBeTruthy()
    expect(play).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })

  it('starts fresh only when it opens again', async () => {
    const trip = goldenTrip('10:55')
    const { rerender } = render(sheet(trip))
    fireEvent.click(screen.getByLabelText('About 40 min'))
    rerender(sheet(goldenTrip('10:56')))
    expect((screen.getByLabelText('About 40 min') as HTMLInputElement).checked).toBe(true)
    rerender(sheet(trip, false))
    rerender(sheet(trip, true))
    expect((screen.getByLabelText('About 40 min') as HTMLInputElement).checked).toBe(false)
  })
})
