import { QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError } from '@/api/client'
import { keys, queryClient } from '@/api/queries'
import type { Expense, ExpenseBook, Trip, TripsPage } from '@/api/types'
import * as session from '@/lib/session'
import * as store from '@/lib/store'
import { goldenTrip } from '@/test/fixtures'
import Expenses from './Expenses'

function expense(overrides: Partial<Expense> = {}): Expense {
  return {
    expenseId: 'exp-1',
    day: '2026-10-14',
    category: 'food',
    title: 'Lunch at Truffles',
    merchant: 'Truffles',
    note: null,
    amountPaise: 61250,
    taxPaise: null,
    gstin: null,
    payment: 'cash',
    reimbursable: true,
    source: 'manual',
    estimate: false,
    edited: false,
    hasReceipt: false,
    claimId: null,
    claimStatus: null,
    flags: ['needs_receipt'],
    duplicateOf: null,
    overByPaise: null,
    ...overrides,
  }
}

function book(overrides: Partial<ExpenseBook> = {}): ExpenseBook {
  const items = [
    expense(),
    expense({ expenseId: 'exp-2', category: 'transport', title: 'Hotel to Whitefield, Metro', merchant: null, amountPaise: 6000, source: 'plan', estimate: true, flags: ['estimate'] }),
  ]
  return {
    tripId: 'trip-001',
    cityName: 'Bengaluru',
    currency: 'INR',
    items,
    totals: {
      today: '2026-10-14',
      spentPaise: 67250,
      estimatedPaise: 6000,
      upcomingPaise: 0,
      forecastPaise: 128500,
      paceDailyPaise: 61250,
      toClaimPaise: 61250,
      claimedPaise: 0,
      reimbursedPaise: 0,
      owedToYouPaise: 61250,
      byCategory: [
        { key: 'food', paise: 61250 },
        { key: 'transport', paise: 6000 },
      ],
      byPayment: [{ key: 'cash', paise: 67250 }],
      byDay: [{ day: '2026-10-14', paise: 67250 }],
    },
    budget: null,
    alerts: [{ kind: 'needs_receipt', level: 'warn', text: '1 expense over ₹500 needs a receipt for the office.', expenseIds: ['exp-1'], day: null }],
    insights: ['Food is the biggest cost: 91% (₹612.50).'],
    claims: [],
    scanning: false,
    ...overrides,
  }
}

function show(data: ExpenseBook) {
  const trip: Trip = goldenTrip()
  const page: TripsPage = { items: [{ tripId: trip.tripId, citySlug: trip.citySlug, cityName: trip.cityName, startDate: trip.startDate, endDate: trip.endDate, stayLabel: trip.stayLabel, sample: trip.sample }], nextCursor: null }
  queryClient.setQueryData(keys.trips, page)
  queryClient.setQueryData(keys.trip(trip.tripId), trip)
  queryClient.setQueryData(keys.expenses(trip.tripId), data)
  const router = createMemoryRouter([{ path: '/expenses', element: <Expenses /> }], { initialEntries: ['/expenses'] })
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.spyOn(session, 'useSessionStatus').mockReturnValue('signedIn')
  queryClient.setDefaultOptions({ queries: { staleTime: Infinity, retry: false } })
})

afterEach(() => {
  vi.restoreAllMocks()
  queryClient.clear()
})

describe('the expense manager', () => {
  it('shows what was spent, where it’s heading, what needs attention and each day', () => {
    show(book())
    expect(screen.getByRole('heading', { level: 1, name: 'Expenses' })).toBeTruthy()
    expect(screen.getByText('Spent so far').nextElementSibling?.textContent).toBe('₹672.50')
    expect(screen.getByText('₹1,285')).toBeTruthy()
    expect(screen.getByText('1 expense over ₹500 needs a receipt for the office.')).toBeTruthy()
    expect(screen.getByText('Food is the biggest cost: 91% (₹612.50).')).toBeTruthy()
    const lunch = screen.getByRole('button', { name: /Lunch at Truffles/ })
    expect(within(lunch).getByText('Needs a receipt')).toBeTruthy()
    // The plan's estimate reads as one.
    expect(within(screen.getByRole('button', { name: /Hotel to Whitefield/ })).getByText('~₹60')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Claim ₹612.50 back' })).toBeTruthy()
    // No AI helper: no scanning, typing and the form still work.
    expect(screen.queryByRole('button', { name: 'Scan a receipt' })).toBeNull()
  })

  it('turns a typed line into an expense to check, then adds it', async () => {
    const post = vi
      .spyOn(api, 'post')
      .mockResolvedValueOnce({ title: 'Auto', merchant: null, amountPaise: 8000, taxPaise: null, category: 'transport', payment: 'upi', day: null, gstin: null, source: 'text' })
      .mockResolvedValueOnce(expense({ expenseId: 'exp-9', title: 'Auto', amountPaise: 8000, category: 'transport', payment: 'upi' }))
    const toast = vi.spyOn(store, 'showToast')
    show(book())
    fireEvent.change(screen.getByLabelText('Type an expense, like Lunch 350 cash'), { target: { value: 'auto 80 gpay' } })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Add' })))
    expect(post).toHaveBeenNthCalledWith(1, '/v1/trips/trip-001/expenses/parse', { text: 'auto 80 gpay' }, { idempotencyKey: expect.stringMatching(/^parse-/) })
    const sheet = screen.getByRole('dialog', { name: 'Add an expense' })
    expect((within(sheet).getByLabelText('Amount (₹)') as HTMLInputElement).value).toBe('80')
    expect((within(sheet).getByLabelText('What was it?') as HTMLInputElement).value).toBe('Auto')
    expect((within(sheet).getByLabelText('Travel') as HTMLInputElement).checked).toBe(true)
    expect((within(sheet).getByLabelText('UPI') as HTMLInputElement).checked).toBe(true)
    await act(async () => fireEvent.click(within(sheet).getByRole('button', { name: 'Add the expense' })))
    expect(post).toHaveBeenNthCalledWith(
      2,
      '/v1/trips/trip-001/expenses',
      expect.objectContaining({ day: '2026-10-14', category: 'transport', title: 'Auto', amountPaise: 8000, payment: 'upi', reimbursable: true, fromReceipt: false }),
      { idempotencyKey: expect.stringMatching(/^expense-/) },
    )
    expect(toast).toHaveBeenCalledWith({ title: 'Added ₹80 for Auto.' })
  })

  it('checks the form before saving', async () => {
    const post = vi.spyOn(api, 'post')
    show(book())
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Fill it in' })))
    const sheet = screen.getByRole('dialog', { name: 'Add an expense' })
    fireEvent.change(within(sheet).getByLabelText('Amount (₹)'), { target: { value: '12.345' } })
    await act(async () => fireEvent.click(within(sheet).getByRole('button', { name: 'Add the expense' })))
    expect(within(sheet).getByText('Enter the amount, like 350 or 612.50.')).toBeTruthy()
    expect(within(sheet).getByText('Choose what kind of expense it is.')).toBeTruthy()
    expect(post).not.toHaveBeenCalled()
  })

  it('confirms the plan’s estimate as paid', async () => {
    const patch = vi.spyOn(api, 'patch').mockResolvedValue(expense({ expenseId: 'exp-2', estimate: false }))
    show(book())
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /Hotel to Whitefield/ })))
    const sheet = screen.getByRole('dialog', { name: 'Confirm what you paid' })
    await act(async () => fireEvent.click(within(sheet).getByRole('button', { name: 'Confirm ₹60 as paid' })))
    expect(patch).toHaveBeenCalledWith('/v1/trips/trip-001/expenses/exp-2', { confirm: true })
  })

  it('claims what is ready, leaving the estimates out until confirmed', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({ claimId: 'clm-1', reference: 'RR-7Q4K2M', status: 'submitted', totalPaise: 61250, count: 1, submittedAt: '2026-10-14T12:00:00+05:30', reimbursedAt: null })
    const toast = vi.spyOn(store, 'showToast')
    show(book())
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Claim ₹612.50 back' })))
    const sheet = screen.getByRole('dialog', { name: 'Claim ₹612.50 back' })
    expect(within(sheet).getByText(/1 has no receipt photo/)).toBeTruthy()
    expect(within(sheet).getByText(/1 ride is still the plan’s estimate/)).toBeTruthy()
    await act(async () => fireEvent.click(within(sheet).getByRole('button', { name: 'Make the claim' })))
    expect(post).toHaveBeenCalledWith('/v1/trips/trip-001/expense-claims', {}, { idempotencyKey: expect.stringMatching(/^claim-/) })
    expect(toast).toHaveBeenCalledWith({ title: 'Claim RR-7Q4K2M for ₹612.50 is ready to send to your office.' })
  })

  it('says why a receipt couldn’t be read, and keeps the photo for the form', async () => {
    vi.spyOn(api, 'upload').mockRejectedValue(new ApiError(422, 'SCAN_FAILED', 'Couldn’t read a total on that receipt.'))
    const toast = vi.spyOn(store, 'showToast')
    Object.assign(globalThis, { createImageBitmap: vi.fn().mockRejectedValue(new Error('no decoder')) })
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() })
    show(book({ scanning: true }))
    const input = document.querySelector<HTMLInputElement>('input[type=file]')!
    const photo = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], 'r.jpg', { type: 'image/jpeg' })
    await act(async () => fireEvent.change(input, { target: { files: [photo] } }))
    expect(toast).toHaveBeenCalledWith({ title: 'Couldn’t read a total on that receipt. Fill it in, the photo is attached.' })
    expect(screen.getByRole('dialog', { name: 'Add an expense' })).toBeTruthy()
    expect(screen.getByRole('img', { name: 'The receipt' })).toBeTruthy()
  })
})
