import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { RooProposal, RooRun } from '@/api/types'
import { forAgent } from '@/lib/roo/agent'
import { PlanCard, type PlanCardData } from './PlanCard'

const proposal: RooProposal = {
  proposalId: 'rp_1',
  tripId: 'trip-001',
  totalCostInr: 185,
  final: [],
  expiresAt: '2026-10-14T08:00:00Z',
  steps: [
    { stepId: 's1', tool: 'skip_task', kind: 'server', label: 'Skip “University office”', detail: 'Your later stops move up.', icon: 'skip', args: {}, auto: false },
    { stepId: 's2', tool: 'book_cab', kind: 'server', label: 'Book a mini to Bank', detail: 'RideNow, about 4 min away', icon: 'cab', args: {}, costInr: 185, auto: false },
    { stepId: 's3', tool: 'set_theme', kind: 'phone', label: 'Switch to dark mode', icon: 'theme', args: { theme: 'dark' }, auto: false },
  ],
}

function card(plan: PlanCardData, on = { run: vi.fn(), no: vi.fn(), undo: vi.fn() }) {
  render(<PlanCard plan={plan} onRun={on.run} onDecline={on.no} onUndo={on.undo} />)
  return on
}

describe('PlanCard', () => {
  it('lists every step with its money, and does nothing until Do all', () => {
    const on = card({ proposal, state: 'ask' })
    expect(screen.getByText('Rico will do 3 things')).toBeTruthy()
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Skip “University office”Your later stops move up.',
      'Book a mini to Bank₹185RideNow, about 4 min away',
      'Switch to dark mode',
    ])
    expect(screen.getByText('₹185 from your wallet (simulated money)')).toBeTruthy()
    expect(on.run).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Do all 3' }))
    expect(on.run).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(on.no).toHaveBeenCalledOnce()
  })

  it('says how each step went, why one failed, and offers Undo', () => {
    const run: RooRun = {
      proposalId: 'rp_1',
      state: 'partial',
      tripId: 'trip-001',
      canUndo: true,
      phone: [],
      summary: 'I stopped at “Book a mini to Bank”.',
      steps: [
        { stepId: 's1', status: 'done', message: 'Skipped.' },
        { stepId: 's2', status: 'failed', message: 'The fare is ₹260 now, more than the ₹185 on the card. Ask me again.' },
        { stepId: 's3', status: 'skipped', message: '' },
      ],
    }
    const on = card({ proposal, state: 'partial', run })
    expect(screen.getByText('Partly done')).toBeTruthy()
    expect(screen.getByText(/The fare is ₹260 now/)).toBeTruthy()
    expect(screen.getAllByText('Not done').length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: /Do all/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(on.undo).toHaveBeenCalledOnce()
  })
})

describe('forAgent', () => {
  const sure = { reply: 'Okay.' }
  it('keeps what the phone understands on the phone, and sends the rest to Rico’s agent', () => {
    expect(forAgent('what’s next', sure)).toBe(false)
    expect(forAgent('something odd', { reply: '?', unknown: true })).toBe(true)
    expect(forAgent('the bank', { reply: 'The bank is at 2.', guess: true })).toBe(true)
  })

  it('sends a message that asks for several things to the agent', () => {
    expect(forAgent('skip the university office, book a cab to the bank and go dark', sure)).toBe(true)
    expect(forAgent('I am at the bank and it is nice', sure)).toBe(false)
  })
})
