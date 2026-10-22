import { describe, expect, it } from 'vitest'
import type { City, Place } from '@/api/types'
import { goldenTrip } from '@/test/fixtures'
import { buildDay } from '@/lib/timeline'
import { understand } from './brain'
import { beginDayPlan, beginEditTask, beginNewTrip, beginOnboard, beginReplan, next, planSummary, type Answer, type FlowContext, type Step } from './flows'
import { understandPlan } from './understand'

const place = (placeId: string, name: string): Place => ({ placeId, name, area: name, lng: 77.6, lat: 12.97, sample: false }) as Place
const fresh: FlowContext = { trip: undefined, view: null, today: '2026-10-22', name: 'Asha Rao' }
const go = (step: Step, a: Answer, ctx = fresh) => next(step.state!, a, ctx)
const pick = (id: string, label = id): Answer => ({ kind: 'choice', id, label })
const BLR: City = { slug: 'bengaluru', name: 'Bengaluru', state: 'Karnataka', sample: true }
const RAJPURA: City = { slug: 'rajpura', name: 'Rajpura', state: 'Punjab', sample: false }

describe('setting up a trip by chatting', () => {
  it('asks city, days, stay and tasks in turn, and says what to do at each step', () => {
    let s = beginOnboard()
    expect(s.say).toEqual(['Which city are you visiting? Any city or town in India.'])
    s = go(s, pick('bengaluru'))
    s = go(s, pick('tomorrow'))
    s = go(s, pick('2'))
    expect(s.expect.kind).toBe('place')
    s = go(s, { kind: 'place', place: place('p-stay', 'Majestic') })
    expect(s.effect).toEqual({ kind: 'createTrip', city: BLR, startDate: '2026-10-23', endDate: '2026-10-24', stay: place('p-stay', 'Majestic') })

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
    expect(go(ask, pick('new'), ctx).say).toContain('Which city are you visiting? Any city or town in India.')
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

describe('any city in India, and a long first message', () => {
  const said =
    'Hey so actully i am new to bengluru and i will be living in the ramson hotel i think i will reach at 9 am and then i will go to my college ' +
    'becoz i am new here i dont know where is my iit bengluru so i wannna go there also i will have a quicl meethinga as well at 5 pm'

  it('picks out where they stay and the tasks, with a time only where one was given for the task', () => {
    expect(understandPlan(said)).toEqual({ stay: 'ramson hotel', tasks: [{ title: 'College' }, { title: 'Meeting', fixed: '17:00' }] })
    expect(understandPlan('Tomorrow I have an interview at 11:30 and lunch, then the bank').tasks).toEqual([{ title: 'Interview', fixed: '11:30' }, { title: 'Lunch' }, { title: 'Bank' }])
    expect(understandPlan('Tomorrow I have an interview at 11:30').start).toBe('tomorrow')
    expect(understandPlan('I have a sales call').tasks).toEqual([])
  })

  it('looks the city up, says what it heard, then asks only what is missing', () => {
    let s = beginOnboard()
    s = go(s, { kind: 'text', text: said })
    expect(s.effect).toEqual({ kind: 'findCity', query: said })
    s = go(s, { kind: 'cities', cities: [BLR] })
    expect(s.say).toEqual(['Bengaluru, lovely.', 'I heard that you’re staying at ramson hotel, and you have the college and the meeting at 17:00. I’ll ask about each.', 'When are you there?'])
    s = go(s, pick('today'))
    s = go(s, pick('1'))
    // The hotel search starts with what they said.
    expect(s.expect).toEqual({ kind: 'place', placeholder: 'Like Majestic or Indiranagar', city: { slug: 'bengaluru', name: 'Bengaluru' }, initial: 'ramson hotel' })
    s = go(s, { kind: 'place', place: place('p-stay', 'Ramson Hotel') })
    s = go(s, { kind: 'done' })
    expect(s.say).toEqual(['Now the things you mentioned.', 'Where is the college?'])
    s = go(s, { kind: 'place', place: place('p-col', 'IISc') })
    expect(s.say).toEqual(['Does it happen at a fixed time?'])
    s = go(s, pick('any'))
    s = go(s, pick('120'))
    expect(s.effect).toMatchObject({ kind: 'addTask', title: 'College', durationMin: 120 })
    s = go(s, { kind: 'done' })
    expect(s.say).toEqual(['Added.', 'Where is the meeting?'])
    // The meeting's time came with the message: Roo goes straight to how long.
    s = go(s, { kind: 'place', place: place('p-meet', 'MG Road') }, { ...fresh, now: '14:00' })
    expect(s.say).toEqual(['How long will the meeting take?'])
    s = go(s, pick('60'))
    expect(s.effect).toMatchObject({ kind: 'addTask', title: 'Meeting', fixed: '17:00' })
    s = go(s, { kind: 'done' })
    expect(s.say).toEqual(['Added. That’s 2 tasks. Anything else?'])
  })

  it('a town beyond Bengaluru plans with rough times, and a name that fits several asks which', () => {
    let s = go(beginOnboard(), { kind: 'text', text: 'raj' })
    s = go(s, { kind: 'cities', cities: [RAJPURA, { slug: 'rajkot', name: 'Rajkot', state: 'Gujarat', sample: false }] })
    expect(s.say).toEqual(['Which one do you mean?'])
    s = go(s, pick('rajpura'))
    expect(s.say).toEqual(['Rajpura, Punjab, lovely.', 'I don’t have metro or shared-auto times there yet, so I’ll plan with rough cab and walking times.', 'When are you there?'])
    s = go(s, pick('today'))
    s = go(s, pick('1'))
    expect(s.expect).toMatchObject({ kind: 'place', city: { slug: 'rajpura', name: 'Rajpura' } })
    s = go(s, { kind: 'place', place: place('p', 'Chitkara University') })
    expect(s.effect).toMatchObject({ kind: 'createTrip', city: RAJPURA })
    expect(go(go(beginOnboard(), { kind: 'text', text: 'Atlantis' }), { kind: 'cities', cities: [] }).say).toEqual([
      'I couldn’t find a city or town by that name in India.',
      'Type just its name, like Rajpura or Pune.',
    ])
  })

  it('a fixed time that has already gone today is caught', () => {
    const at3 = { ...fresh, now: '15:00' }
    let s = go(beginOnboard(), pick('bengaluru'), at3)
    for (const a of [pick('today'), pick('1'), { kind: 'place', place: place('p', 'Majestic') } as Answer, { kind: 'done' } as Answer, { kind: 'text', text: 'College' } as Answer, { kind: 'place', place: place('c', 'IISc') } as Answer, pick('fixed')]) s = go(s, a, at3)
    s = go(s, { kind: 'time', hhmm: '10:00' }, at3)
    expect(s.say).toEqual(['It’s already past 10:00 today. Pick a later time, or another way.'])
    s = go(s, pick('fixed'), at3)
    s = go(s, { kind: 'time', hhmm: '16:30' }, at3)
    expect(s.say).toEqual(['How long will the college take?'])
  })
})

describe('Roo in the chat, with a trip', () => {
  const trip = goldenTrip()
  const ctx: FlowContext = { trip, view: buildDay(trip), today: trip.day, now: '07:30', name: 'Arjun' }

  it('a described day: Roo says what it understood, offers to plan, then asks where each thing is', () => {
    const hints = understandPlan('so today I need to go to my college and I also have an interview at 4 pm near MG Road')
    let s = beginDayPlan(hints, ctx)
    expect(s.say).toEqual(['Oh, I get it: you have the college and the interview at 16:00.', 'Shall I add them to today and plan your day around them?'])
    s = go(s, pick('yes'), ctx)
    expect(s.say).toEqual(['Great, one at a time.', 'Where is the college?'])
    expect(s.expect).toMatchObject({ kind: 'place', city: { slug: 'bengaluru' } })
    expect(go(beginDayPlan(hints, ctx), pick('no'), ctx).state).toBeNull()
  })

  it('"edit the bank" asks what to change, and "edit my plan" asks what changed', () => {
    const s = beginEditTask('task-bank', ctx)
    expect(s.say).toEqual(['What about the bank?'])
    expect(s.expect).toMatchObject({ kind: 'choice' })
    expect(understand('edit the bank', { trip, view: buildDay(trip), clock: 450, leftFor: null })).toMatchObject({ flow: 'editTask', taskId: 'task-bank' })
    expect(understand('edit my plan', { trip, view: buildDay(trip), clock: 450, leftFor: null }).flow).toBe('replan')
    expect(understand('delete the bank', { trip, view: buildDay(trip), clock: 450, leftFor: null }).action).toMatchObject({ type: 'skip', taskId: 'task-bank' })
  })
})
