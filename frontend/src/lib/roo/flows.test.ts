import { describe, expect, it } from 'vitest'
import type { Place } from '@/api/types'
import { goldenTrip } from '@/test/fixtures'
import { buildDay } from '@/lib/timeline'
import { understand } from './brain'
import { beginNewTrip, beginOnboard, beginReplan, next, planSummary, type Answer, type FlowContext, type Step } from './flows'

const place = (placeId: string, name: string): Place => ({ placeId, name, area: name, lng: 77.6, lat: 12.97, sample: false }) as Place
const fresh: FlowContext = { trip: undefined, view: null, today: '2026-10-22', name: 'Asha Rao' }
const go = (step: Step, a: Answer, ctx = fresh) => next(step.state!, a, ctx)
const pick = (id: string, label = id): Answer => ({ kind: 'choice', id, label })

describe('setting up a trip by chatting', () => {
  it('asks city, days, stay and tasks in turn, and says what to do at each step', () => {
    let s = beginOnboard()
    expect(s.say).toEqual(['Which city are you visiting?'])
    // Another city: a kind no, and Bengaluru on offer.
    s = go(s, { kind: 'text', text: 'Mumbai' })
    expect(s.say[0]).toMatch(/only know Bengaluru/)
    s = go(s, pick('bengaluru'))
    s = go(s, pick('tomorrow'))
    s = go(s, pick('2'))
    expect(s.expect.kind).toBe('place')
    s = go(s, { kind: 'place', place: place('p-stay', 'Majestic') })
    expect(s.effect).toEqual({ kind: 'createTrip', startDate: '2026-10-23', endDate: '2026-10-24', stay: place('p-stay', 'Majestic') })

    s = go(s, { kind: 'done' })
    expect(s.expect).toEqual({ kind: 'text', placeholder: 'Like “Client meeting” or “Bank”' })
    s = go(s, { kind: 'text', text: 'a client meeting' })
    expect(s.say).toEqual(['Where is the client meeting?'])
    s = go(s, { kind: 'place', place: place('p-wf', 'Whitefield') })
    s = go(s, pick('fixed'))
    expect(s.expect.kind).toBe('time')
    s = go(s, { kind: 'time', hhmm: '10:30' })
    s = go(s, pick('60'))
    expect(s.effect).toEqual({ kind: 'addTask', title: 'Client meeting', place: place('p-wf', 'Whitefield'), durationMin: 60, fixed: '10:30', window: undefined })

    s = go(s, { kind: 'done' })
    expect(s.say).toEqual(['Added. Anything else today?'])
    s = go(s, pick('plan'))
    expect(s.effect).toEqual({ kind: 'plan' })
    s = go(s, { kind: 'done', summary: 'You leave at 09:10.' })
    expect(s.say).toContain('Your day is planned!')
    expect(s.say).toContain('You leave at 09:10.')
    s = go(s, pick('show'))
    expect(s.effect).toEqual({ kind: 'show' })
    expect(s.state).toBeNull()
  })

  it('opening hours come as choices, and a failure is said in plain words', () => {
    let s = beginOnboard()
    for (const a of [pick('bengaluru'), pick('today'), pick('1'), { kind: 'place', place: place('p', 'Majestic') } as Answer, { kind: 'done' } as Answer, { kind: 'text', text: 'Bank' } as Answer, { kind: 'place', place: place('k', 'Koramangala') } as Answer, pick('hours')]) s = go(s, a)
    s = go(s, pick('bank'))
    s = go(s, pick('30'))
    expect(s.effect).toMatchObject({ kind: 'addTask', window: { opensAt: '10:00', closesAt: '16:00' }, durationMin: 30 })
    s = go(s, { kind: 'failed', message: 'The place is outside Bengaluru.' })
    expect(s.say[0]).toBe('I couldn’t add it: The place is outside Bengaluru.')
  })
})

describe('re-planning by chatting', () => {
  const trip = goldenTrip('07:30')
  const ctx: FlowContext = { trip, view: buildDay(trip), today: trip.day, name: 'Arjun' }

  it('"a task changed" asks which, then what, and ends in a change to confirm', () => {
    let s = beginReplan()
    expect(s.expect).toMatchObject({ kind: 'choice' })
    s = go(s, pick('task'), ctx)
    expect(s.say).toEqual(['Which task?'])
    s = go(s, pick('task-bank'), ctx)
    expect(s.say).toEqual(['What about the bank?'])
    s = go(s, pick('length'), ctx)
    expect(s.say[0]).toBe('How long does the bank take now? It was 2 hours 30 minutes.')
    s = go(s, pick('120'), ctx)
    expect(s.say).toEqual(['Shall I make it 2 hours?'])
    expect(s.effect).toEqual({ kind: 'action', action: { type: 'duration', taskId: 'task-bank', minutes: 120 } })
  })

  it('running late asks how late, and a new plan asks first', () => {
    const late = go(beginReplan(), pick('late'), ctx)
    expect(go(late, pick('45'), ctx).effect).toEqual({ kind: 'action', action: { type: 'late', minutes: 45 } })
    const ask = beginNewTrip(ctx)
    expect(ask.say[0]).toMatch(/^Are you sure\? You already have a plan for Bengaluru on Wednesday/)
    expect(go(ask, pick('adjust'), ctx).say).toEqual(['Sure. What’s changed?'])
    expect(go(ask, pick('new'), ctx).say).toContain('Which city are you visiting?')
    expect(go(ask, pick('keep'), ctx).state).toBeNull()
  })

  it('says a planned day in one line', () => {
    expect(planSummary(buildDay(trip))).toBe('You leave at 08:50 for the meeting, and you’re back around 16:50.')
  })
})

describe('the brain starts these conversations, and knows money and flights', () => {
  const trip = goldenTrip('07:30')
  const c = { trip, view: buildDay(trip), clock: 450, leftFor: null, walletInr: 5000 }
  it('reads intent', () => {
    expect(understand('hey i wanna re plan', c).flow).toBe('replan')
    expect(understand('create an entire new plan', c).flow).toBe('newTrip')
    expect(understand('plan my day again', c).action).toEqual({ type: 'replan' })
    expect(understand('add 1000 to my wallet', c).action).toEqual({ type: 'topup', amount: 1000 })
    expect(understand("what's my balance?", c).reply).toBe('Your wallet has ₹5,000 of simulated money.')
    expect(understand('book a flight to Delhi', c).action).toEqual({ type: 'flight', to: 'DEL' })
  })
})
