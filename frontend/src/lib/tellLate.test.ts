import { describe, expect, it } from 'vitest'
import type { Trip } from '@/api/types'
import { goldenTrip } from '@/test/fixtures'
import { understand } from './roo/brain'
import { lateFixed, lateMessage, missMessage } from './tellLate'
import { buildDay } from './timeline'

const later = (iso: string, min: number) => new Date(new Date(iso).getTime() + min * 60_000).toISOString()

/** The demo day at 08:00, with the 10:00 meeting reached `by` minutes after 09:50 (as "go anyway" plans it). */
function lateDay(by: number): Trip {
  const trip = goldenTrip('08:00')
  const legs = trip.activePlan!.legs.map((leg) =>
    leg.taskId === 'task-meet' ? { ...leg, arriveAt: later(leg.arriveAt, by), taskStart: later(leg.arriveAt, by), taskEnd: later(leg.taskEnd, by) } : leg,
  )
  return { ...trip, activePlan: { ...trip.activePlan!, legs } }
}

describe('telling them you’re late', () => {
  it('finds the fixed meeting the day reaches after its time, with when you’ll get there', () => {
    expect(lateFixed(buildDay(goldenTrip('08:00')))).toBeNull()
    expect(lateFixed(buildDay(lateDay(25)))).toEqual({ taskId: 'task-meet', title: 'Meeting', at: '10:00', arrive: '10:15', minutes: 15 })
    // Already there: nothing to tell.
    expect(lateFixed(buildDay(lateDay(25), 10 * 60 + 20))).toBeNull()
  })

  it('writes a plain message the traveller can change, and one for when they can’t make it at all', () => {
    const late = lateFixed(buildDay(lateDay(25)))!
    expect(lateMessage(late)).toBe('Hi, I’m sorry, I’m running about 15 minutes late for the meeting at 10:00. I’ll be there around 10:15.')
    expect(lateMessage({ ...late, minutes: 75 })).toContain('about 1 hour 15 minutes late')
    expect(missMessage('College', '10:00')).toBe('Hi, I’m sorry, I won’t be able to make it to college at 10:00 today. Could we find another time?')
  })

  it('Roo says you’ll be late, and writes the message when asked', () => {
    const trip = lateDay(25)
    const ctx = { trip, view: buildDay(trip), clock: 8 * 60, leftFor: null }
    expect(understand('how is my day', ctx).reply).toMatch(/^You’ll reach the meeting at about 10:15, 15 min after its 10:00 start\. Say “tell them I’m late”/)
    expect(understand('tell them I am running late', ctx).action).toEqual({ type: 'tellLate' })
    expect(understand('let my boss know', ctx).action).toEqual({ type: 'tellLate' })
    const onTime = goldenTrip('08:00')
    expect(understand('tell them I am late', { trip: onTime, view: buildDay(onTime), clock: 8 * 60, leftFor: null }).reply).toBe(
      'You’ll be on time for your fixed stops, so there’s nothing to tell them yet.',
    )
  })
})
