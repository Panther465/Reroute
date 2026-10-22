import { describe, expect, it } from 'vitest'
import { goldenTrip } from '@/test/fixtures'
import { buildDay, localMinutes } from '@/lib/timeline'
import { clockIn, findTask, forSpeech, greeting, understand, type RooContext } from './brain'

function ctx(now = '07:30', extra: Partial<RooContext> = {}): RooContext {
  const trip = goldenTrip(now)
  return { trip, view: buildDay(trip), clock: localMinutes(trip.now, trip.day, trip.utcOffset), leftFor: null, name: 'Arjun Mehta (sample)', ...extra }
}

describe('Roo understands a change to one task, and asks first', () => {
  it('moves a task to the next day of the trip', () => {
    const a = understand('Move the bank to tomorrow', ctx())
    expect(a.action).toEqual({ type: 'move', taskId: 'task-bank', day: '2026-10-15' })
    expect(a.confirm?.yes).toBe('Move it')
  })

  it('skips a task by its title or its area', () => {
    expect(understand("I don't need to go to the university office any more", ctx()).action).toEqual({ type: 'skip', taskId: 'task-office' })
    expect(understand('skip the Jayanagar one', ctx()).action).toEqual({ type: 'skip', taskId: 'task-office' })
  })

  it('changes how long a task takes', () => {
    expect(understand('make the meeting 2 hours', ctx()).action).toEqual({ type: 'duration', taskId: 'task-meet', minutes: 120 })
    expect(understand('the bank only takes 45 minutes', ctx()).action).toEqual({ type: 'duration', taskId: 'task-bank', minutes: 45 })
  })

  it('fixes a start time, reading 1 to 7 without am or pm as the afternoon', () => {
    expect(understand('move the office to 3', ctx()).action).toEqual({ type: 'time', taskId: 'task-office', hhmm: '15:00' })
    expect(understand('change the meeting to 10:30 am', ctx()).action).toEqual({ type: 'time', taskId: 'task-meet', hhmm: '10:30' })
  })

  it('reads "can the bank wait till Thursday" as a move', () => {
    expect(understand('can the bank wait till thursday?', ctx()).action).toEqual({ type: 'move', taskId: 'task-bank', day: '2026-10-15' })
  })

  it('a sentence that only names a task is a guess, for the AI helper to answer better', () => {
    const a = understand('the bank is far from here, honestly', ctx())
    expect(a.guess).toBe(true)
    expect(a.action).toBeUndefined()
  })

  it('"it" means the task the conversation is about', () => {
    expect(understand('move it to tomorrow', ctx('07:30', { lastTaskId: 'task-bank' })).action).toEqual({ type: 'move', taskId: 'task-bank', day: '2026-10-15' })
  })

  it('a delay is never read as a new length', () => {
    expect(understand('I need 20 more minutes at the meeting', ctx('10:55')).action).toEqual({ type: 'late', minutes: 20 })
  })
})

describe('Roo answers about the day', () => {
  it('says what is next, and how long until it', () => {
    const a = understand("what's next?", ctx())
    expect(a.reply).toBe('Leave at 08:50 for the meeting, in 1 h 20 min. You should arrive around 09:50.')
    expect(a.action).toBeUndefined()
  })

  it('greets by name and the time of day', () => {
    expect(greeting(ctx()).reply).toMatch(/^Good morning, Arjun! /)
  })

  it('plans again, undoes and changes the theme', () => {
    expect(understand('can you plan my day again', ctx()).action).toEqual({ type: 'replan' })
    expect(understand('undo that', ctx()).action).toEqual({ type: 'undo' })
    expect(understand('switch to dark mode', ctx()).action).toEqual({ type: 'theme', theme: 'dark' })
  })

  it('opens Add a task with what was said', () => {
    expect(understand('remind me to buy flowers in Jayanagar', ctx()).action).toEqual({ type: 'add', text: 'buy flowers in Jayanagar' })
  })

  it('asks which task when two match equally, and passes on what it cannot place', () => {
    const trip = goldenTrip('07:30')
    const twin = { ...trip.tasks[1], taskId: 'task-bank-2', title: 'Bank' }
    const c = { ...ctx(), trip: { ...trip, tasks: [...trip.tasks, twin] } }
    expect(findTask('skip the bank', c).ambiguous.map((t) => t.taskId)).toEqual(['task-bank', 'task-bank-2'])
    expect(understand('what is the meaning of life', ctx()).unknown).toBe(true)
  })
})

describe('clockIn', () => {
  it('reads times people say', () => {
    expect(clockIn('at 11')).toBe('11:00')
    expect(clockIn('to 2:30 pm')).toBe('14:30')
    expect(clockIn('at noon')).toBe('12:00')
    expect(clockIn('at 12 am')).toBe('00:00')
    expect(clockIn('make it 45 minutes')).toBeNull()
  })
})

describe('forSpeech', () => {
  it('writes out times and money so a voice reads them naturally', () => {
    expect(forSpeech('Leave in 1 h 20 min, about ₹1,320 less. It was 1 h, now 45 min.')).toBe('Leave in 1 hour 20 minutes, about 1320 rupees less. It was 1 hour, now 45 minutes.')
  })
})
