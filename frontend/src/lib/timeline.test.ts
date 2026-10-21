import { describe, expect, it } from 'vitest'
import { goldenTrip } from '@/test/fixtures'
import { hhmm } from './format'
import { buildDay, dayLabel, diffDays, lastReroute, localMinutes, sharedToDay } from './timeline'

describe('buildDay never loses a task', () => {
  it('lists a task added after the plan as not planned yet', () => {
    const trip = goldenTrip()
    const extra = { ...trip.tasks[0], taskId: 'task-new', title: 'Pick up documents', fixedStart: null }
    const view = buildDay({ ...trip, tasks: [...trip.tasks, extra] })!
    expect(view.notPlanned).toEqual([{ taskId: 'task-new', title: 'Pick up documents' }])
    expect(view.leftOut).toEqual([])
  })

  it('says in plain words why the planner left a task out', () => {
    const trip = goldenTrip()
    const extra = { ...trip.tasks[0], taskId: 'task-far', title: 'Temple visit', fixedStart: null }
    const moved = [{ taskId: 'task-far', title: 'Temple visit', kind: 'unplaced' as const, toDayStart: null, reason: "There's no travel option to the temple visit in this snapshot" }]
    const view = buildDay({ ...trip, tasks: [...trip.tasks, extra], activePlan: { ...trip.activePlan!, moved } })!
    expect(view.leftOut).toEqual([{ taskId: 'task-far', title: 'Temple visit', reason: 'Reroute has no travel times to this place yet.' }])
    expect(view.notPlanned).toEqual([])
  })

  it("doesn't warn about a skip the traveller chose", () => {
    const trip = goldenTrip()
    const extra = { ...trip.tasks[0], taskId: 'task-tea', title: 'Tea', fixedStart: null, priority: 3, state: 'skipped' as const }
    const moved = [{ taskId: 'task-tea', title: 'Tea', kind: 'skipped' as const, toDayStart: null, reason: 'skipped, priority 3' }]
    const withPlan = (trigger: 'skipped' | 'created') => buildDay({ ...trip, tasks: [...trip.tasks, extra], activePlan: { ...trip.activePlan!, trigger, moved } })!
    expect(withPlan('skipped').leftOut).toEqual([])
    expect(withPlan('created').leftOut.map((x) => x.taskId)).toEqual(['task-tea'])
  })
})

describe('buildDay (golden plan version 1 at 10:55)', () => {
  const view = buildDay(goldenTrip())!

  it('lays out the stations and times from the API plan', () => {
    expect(view.stops.map((s) => [s.title, hhmm(s.time), hhmm(s.end)])).toEqual([
      ['Hotel near Majestic', '08:50', '08:50'],
      ['Meeting', '10:00', '11:00'],
      ['Bank', '12:25', '14:55'],
      ['University office', '15:40', '16:25'],
      ['Hotel near Majestic', '16:50', '16:50'],
    ])
    expect(view.legs.map((l) => l.leaveBy)).toEqual(['08:50', '11:05', '15:00', '16:30'])
  })

  it('puts the traveller at the meeting, with the bank leg next', () => {
    expect(view.stops.map((s) => s.status)).toEqual(['done', 'now', 'upcoming', 'upcoming', 'upcoming'])
    expect(view.legs.map((l) => l.status)).toEqual(['done', 'active', 'upcoming', 'upcoming'])
    expect(view.nextLeg?.toId).toBe('task-bank')
    expect(view.checkInTask?.taskId).toBe('task-meet')
    expect(view.done).toBe(false)
  })

  it('carries Raasta legs, totals and the fixed time', () => {
    expect(view.legs[2].raasta).toEqual({ routeId: 'sample-kor-jay', status: 'verified' })
    expect(view.fareInr).toBe(210)
    expect(view.travelMin).toBe(200)
    expect(view.stops[1].task?.fixedStart).toBe('10:00')
    expect(view.stops[2].task?.window).toEqual({ opensAt: '10:00', closesAt: '16:00' })
  })

  it('moves the traveller on after a check-in', () => {
    const trip = goldenTrip('11:02')
    trip.tasks[0].state = 'done'
    const after = buildDay(trip)!
    expect(after.stops.map((s) => s.status)).toEqual(['done', 'now', 'upcoming', 'upcoming', 'upcoming'])
    expect(after.checkInTask?.taskId).toBe('task-bank')
    const enRoute = buildDay(goldenTrip('11:10', { tasks: trip.tasks }))!
    expect(enRoute.stops.map((s) => s.status)).toEqual(['done', 'done', 'now', 'upcoming', 'upcoming'])
  })

  it('flags a fixed task when the task before it runs past the leave-by time', () => {
    const trip = goldenTrip('11:12')
    trip.tasks[1].fixedStart = '2026-10-14T12:35:00+05:30'
    trip.tasks[1].window = null
    expect(buildDay(trip)!.stops[2].problem).toBe('late')
    expect(buildDay({ ...trip, now: '2026-10-14T11:08:00+05:30' })!.stops[2].problem).toBeUndefined()
  })

  it('ends the day when every task is done and the traveller is home', () => {
    const trip = goldenTrip('17:00')
    trip.tasks.slice(0, 3).forEach((t) => (t.state = 'done'))
    const view = buildDay(trip)!
    expect(view.done).toBe(true)
    expect(view.checkInTask).toBeNull()
  })

  it("always shows tomorrow's tasks, with tasks moved there today", () => {
    expect(buildDay(goldenTrip())!.tomorrow.map((t) => [t.title, hhmm(t.time), t.moved])).toEqual([['Train home', '21:00', false]])
    const trip = goldenTrip()
    trip.activePlan!.moved = [{ taskId: 'task-office', title: 'University office', kind: 'moved', toDayStart: '2026-10-15T10:00:00+05:30', reason: 'moved' }]
    trip.tasks[2].state = 'moved'
    trip.tasks[2].day = '2026-10-15'
    const view = buildDay(trip)!
    expect(view.tomorrow.map((t) => [t.title, hhmm(t.time), t.moved])).toEqual([
      ['University office', '10:00', true],
      ['Train home', '21:00', false],
    ])
  })

  it('returns null without an active plan', () => {
    expect(buildDay(goldenTrip('10:55', { activePlan: null }))).toBeNull()
  })
})

describe('time conversion', () => {
  it('reads instants in any offset as city time', () => {
    expect(localMinutes('2026-10-14T10:55:00+05:30', '2026-10-14')).toBe(655)
    expect(localMinutes('2026-10-14T05:25:00Z', '2026-10-14')).toBe(655)
    expect(localMinutes('2026-10-15T10:00:00+05:30', '2026-10-14')).toBe(1440 + 600)
  })

  it('labels the day', () => {
    expect(dayLabel('2026-10-14')).toBe('Wednesday 14 October')
  })

  it('finds the latest reroute that was not undone', () => {
    const log = [
      { logId: 'b', at: '2026-10-14T05:30:00Z', kind: 'undo', text: '', automatic: false, planId: null, previousPlanId: null, reasonCodes: [], undone: false, canUndo: false },
      { logId: 'a', at: '2026-10-14T05:25:00Z', kind: 'option', text: '', automatic: false, planId: null, previousPlanId: null, reasonCodes: [], undone: false, canUndo: false },
    ]
    expect(lastReroute(log, '2026-10-14')).toBe(655)
  })
})

describe('diffDays', () => {
  it('lists changed stops and legs after a reroute', () => {
    const before = buildDay(goldenTrip())!
    const trip = goldenTrip()
    const legs = trip.activePlan!.legs
    legs[1] = { ...legs[1], label: 'Cab', segments: [{ mode: 'cab', minutes: 50 }], leaveBy: '2026-10-14T11:45:00+05:30', arriveAt: '2026-10-14T12:35:00+05:30', taskStart: '2026-10-14T12:35:00+05:30', taskEnd: '2026-10-14T15:05:00+05:30' }
    const after = buildDay(trip)!
    const diff = diffDays(before, after)
    expect(diff.changedStops).toContain('task-bank')
    expect(diff.changedLegs).toContain(2)
    expect(diff.announcement).toContain('Bank now at 12:35.')
  })
})

describe('sharedToDay', () => {
  it('builds a read-only day from the family view', () => {
    const view = sharedToDay({
      travellerFirstName: 'Arjun',
      cityName: 'Bengaluru',
      utcOffset: '+05:30',
      day: '2026-10-14',
      updatedAt: '2026-10-14T10:50:00+05:30',
      now: '2026-10-14T10:55:00+05:30',
      stops: [
        { title: 'Hotel', area: 'Majestic', time: '2026-10-14T08:50:00+05:30', end: null, status: 'done', fixed: false },
        { title: 'Meeting', area: 'Whitefield', time: '2026-10-14T10:00:00+05:30', end: '2026-10-14T11:00:00+05:30', status: 'now', fixed: true },
        { title: 'Hotel', area: 'Majestic', time: '2026-10-14T12:30:00+05:30', end: null, status: 'upcoming', fixed: false },
      ],
      legs: [
        { label: 'Metro', mode: 'metro', segments: [{ mode: 'metro', minutes: 60 }], leaveBy: '2026-10-14T08:50:00+05:30', arriveAt: '2026-10-14T09:50:00+05:30', travelMin: 60, status: 'done' },
        { label: 'Metro', mode: 'metro', segments: [{ mode: 'metro', minutes: 60 }], leaveBy: '2026-10-14T11:05:00+05:30', arriveAt: '2026-10-14T12:05:00+05:30', travelMin: 60, status: 'active' },
      ],
    })
    expect(view.nowIndex).toBe(1)
    expect(view.stops[1].task?.fixedStart).toBe('10:00')
    expect(view.nextLeg?.leaveBy).toBe('11:05')
  })
})
