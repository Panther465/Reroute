// Roo's conversations: setting up a trip, re-planning the day, starting a new trip. A pure reducer: the
// state and an answer in; what Roo says, what it asks for next, and what the app should do, out. The app
// does the work (create the trip, add a task, plan, show a card) and hands back the result. Nothing here
// talks to the server, so every path is tested without one.

import type { City, Place, Trip } from '@/api/types'
import { duration, hhmm, lowerFirst } from '@/lib/format'
import { addDays, weekday, type DayView } from '@/lib/timeline'
import { clockIn, forSpeech } from './brain'
import type { RooAction } from './brain'
import { understandPlan, type PlanHints, type TaskHint } from './understand'

export interface Choice {
  id: string
  label: string
}

/** What Roo is waiting for. */
export type Expect =
  | { kind: 'free' }
  | { kind: 'choice'; options: Choice[]; allowText?: boolean }
  | { kind: 'text'; placeholder: string }
  | { kind: 'place'; placeholder: string; city?: { slug: string; name: string }; initial?: string }
  | { kind: 'date' }
  | { kind: 'time' }

/** What the app should do before the conversation goes on. Its result comes back as an answer. */
export type Effect =
  | { kind: 'findCity'; query: string }
  | { kind: 'createTrip'; city: City; startDate: string; endDate: string; stay: Place }
  | { kind: 'addTask'; title: string; place: Place; durationMin: number; fixed?: string; window?: { opensAt: string; closesAt: string } }
  | { kind: 'plan' }
  | { kind: 'action'; action: RooAction }
  | { kind: 'show' }

export type Answer =
  | { kind: 'choice'; id: string; label: string }
  | { kind: 'text'; text: string }
  | { kind: 'place'; place: Place }
  | { kind: 'date'; date: string }
  | { kind: 'time'; hhmm: string }
  | { kind: 'done'; summary?: string }
  | { kind: 'failed'; message: string }
  | { kind: 'cities'; cities: City[] }

interface TaskDraft {
  title?: string
  place?: Place
  fixed?: string
  window?: { opensAt: string; closesAt: string }
}

export interface FlowState {
  flow: 'onboard' | 'replan' | 'newTrip' | 'dayPlan'
  step: string
  start?: string
  days?: number
  task?: TaskDraft
  added?: number
  /** The task a re-plan is about. */
  taskId?: string
  city?: City
  /** Cities to choose between, when a name fits more than one. */
  cities?: City[]
  /** What a long first message said: where they stay, and tasks Roo then asks about one by one. */
  hints?: PlanHints
  queue?: TaskHint[]
}

export interface Step {
  state: FlowState | null
  say: string[]
  expect: Expect
  effect?: Effect
}

export interface FlowContext {
  trip: Trip | undefined
  view: DayView | null
  /** Today, as the trip clock (or the phone) sees it: YYYY-MM-DD. */
  today: string
  /** The time now, HH:MM, to catch a fixed time that has already gone today. */
  now?: string
  name?: string | null
}

const FREE: Expect = { kind: 'free' }
const choice = (options: [string, string][], allowText = false): Expect => ({ kind: 'choice', options: options.map(([id, label]) => ({ id, label })), allowText })

const WINDOWS: Record<string, { opensAt: string; closesAt: string; label: string }> = {
  bank: { opensAt: '10:00', closesAt: '16:00', label: 'Bank hours, 10:00 to 16:00' },
  office: { opensAt: '09:00', closesAt: '17:00', label: 'Office hours, 09:00 to 17:00' },
  shop: { opensAt: '10:00', closesAt: '20:00', label: 'Shop hours, 10:00 to 20:00' },
}
const LENGTHS: [string, string][] = [
  ['30', '30 min'],
  ['60', '1 hour'],
  ['120', '2 hours'],
  ['180', '3 hours'],
]

const BENGALURU: City = { slug: 'bengaluru', name: 'Bengaluru', state: 'Karnataka', sample: true }
const WHEN = choice([['today', 'From today'], ['tomorrow', 'From tomorrow'], ['other', 'Another day']])
const DAYS = choice([['1', 'Just that day'], ['2', '2 days'], ['3', '3 days']])
const HOW = choice([['fixed', 'At a fixed time'], ['hours', 'Within opening hours'], ['any', 'Any time']])

const the = (s: string) => `the ${lowerFirst(s)}`
/** A length as Roo says it in a sentence: "2 hours", not "2 h". */
const said = (min: number) => forSpeech(duration(min))
const first = (name?: string | null) => (name ? name.replace(/\s*\(.*\)\s*$/, '').split(/\s+/)[0] : null)

// ---------------------------------------------------------------------------
// Setting up a trip (onboarding, and a new trip)
// ---------------------------------------------------------------------------

/** Roo's hello to a new account, before the first question. */
export function intro(name?: string | null): string[] {
  const n = first(name)
  return [
    `Hi${n ? ` ${n}` : ''}! I’m Roo.`,
    'I’m your travel companion. I plan your work day in a city you don’t know, tell you when to leave, and re-plan the rest when something runs late.',
    'Let’s set up your first trip. It takes about a minute.',
  ]
}

function askCity(state: Omit<FlowState, 'step'>): Step {
  return { state: { ...state, step: 'city' }, say: ['Which city are you visiting? Any city or town in India.'], expect: choice([['bengaluru', 'Bengaluru']], true) }
}

/** A place search in the trip's city, starting from what they already said, if anything. */
function placeIn(state: FlowState, ctx: FlowContext, placeholder: string, initial?: string): Expect {
  const c = state.city ?? (ctx.trip ? { slug: ctx.trip.citySlug, name: ctx.trip.cityName } : BENGALURU)
  return { kind: 'place', placeholder, city: { slug: c.slug, name: c.name }, initial }
}

function askStay(state: FlowState, ctx: FlowContext): Step {
  const stay = state.hints?.stay
  const sample = !state.city || state.city.sample
  return {
    state: { ...state, step: 'stay' },
    say: [stay ? `Where are you staying? Let’s find ${stay}: pick it from the list, or type another name.` : 'Where are you staying? Type your hotel or the area, and pick it from the list.'],
    expect: placeIn(state, ctx, sample ? 'Like Majestic or Indiranagar' : 'Your hotel, hostel or area', stay),
  }
}

/** Roo repeats back what it picked out of a long message, so the traveller knows it listened. */
function heard(h: PlanHints): string | null {
  const parts: string[] = []
  if (h.stay) parts.push(`you’re staying at ${h.stay}`)
  const tasks = h.tasks.map((t) => `${the(t.title)}${t.fixed ? ` at ${t.fixed}` : ''}`)
  if (tasks.length) parts.push(`you have ${joinAnd(tasks)}`)
  return parts.length ? `I heard that ${parts.join(', and ')}. I’ll ask about each.` : null
}

const joinAnd = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : (xs[0] ?? ''))

/**
 * A day described in the chat ("tomorrow I have college, then a meeting at 5"): Roo says what it
 * understood and offers to add it and plan, then asks where each thing is, as when setting up a trip.
 */
export function beginDayPlan(hints: PlanHints, ctx: FlowContext): Step {
  const things = hints.tasks.map((t) => `${the(t.title)}${t.fixed ? ` at ${t.fixed}` : ''}`)
  const day = !ctx.trip || ctx.trip.day === ctx.today ? 'today' : weekday(ctx.trip.day)
  return {
    state: { flow: 'dayPlan', step: 'confirm', hints, queue: hints.tasks },
    say: [`Oh, I get it: you have ${joinAnd(things)}.`, `Shall I add ${things.length > 1 ? 'them' : 'it'} to ${day} and plan your day around ${things.length > 1 ? 'them' : 'it'}?`],
    expect: choice([
      ['yes', 'Yes, plan my day'],
      ['no', 'Not now'],
    ]),
  }
}

/** "Edit the bank": what about it? The time, how long, another day, or skip it. */
export function beginEditTask(taskId: string, ctx: FlowContext): Step {
  return replan({ flow: 'replan', step: 'which' }, { kind: 'choice', id: taskId, label: '' }, ctx)
}

function chosen(state: FlowState, city: City, ctx: FlowContext): Step {
  const s: FlowState = { ...state, city, cities: undefined }
  const lines = [`${city.name}${city.state && !city.sample ? `, ${city.state}` : ''}, lovely.`]
  if (!city.sample) lines.push('I don’t have metro or shared-auto times there yet, so I’ll plan with rough cab and walking times.')
  const h = state.hints && heard(state.hints)
  if (h) lines.push(h)
  if (state.hints?.start) {
    const start = state.hints.start === 'tomorrow' ? addDays(ctx.today, 1) : ctx.today
    return { state: { ...s, step: 'days', start }, say: [...lines, 'And for how many days?'], expect: DAYS }
  }
  return { state: { ...s, step: 'when' }, say: [...lines, 'When are you there?'], expect: WHEN }
}

/** The next task the first message mentioned: its title (and time) are known, so Roo asks where. */
function nextMentioned(state: FlowState, ctx: FlowContext, lead: string[]): Step {
  const [t, ...rest] = state.queue ?? []
  return {
    state: { ...state, step: 'task-place', queue: rest, task: { title: t.title, fixed: t.fixed } },
    say: [...lead, `Where is ${the(t.title)}?`],
    expect: placeIn(state, ctx, 'A place or area'),
  }
}

/** A fixed time today that has already gone. */
const gone = (state: FlowState, ctx: FlowContext, at?: string) => !!at && !!ctx.now && (state.start ?? ctx.today) === ctx.today && at <= ctx.now

function askTask(state: FlowState, again: boolean): Step {
  return {
    state: { ...state, step: 'task-title', task: {} },
    say: [again ? 'What else do you need to do?' : 'Now your tasks. What’s the first thing you need to do? A meeting, the bank, a visit…'],
    expect: { kind: 'text', placeholder: 'Like “Client meeting” or “Bank”' },
  }
}

export function beginOnboard(): Step {
  return askCity({ flow: 'onboard' })
}

function onboard(state: FlowState, a: Answer, ctx: FlowContext): Step {
  const today = ctx.today
  switch (state.step) {
    case 'city': {
      if (a.kind === 'choice' && a.id === 'bengaluru') return chosen(state, BENGALURU, ctx)
      const text = a.kind === 'text' ? a.text.trim() : ''
      if (!text) return askCity(state)
      // A long first message can say much more than the city: keep it, so Roo asks only what's missing.
      const hints = text.split(/\s+/).length > 3 ? understandPlan(text) : state.hints
      return { state: { ...state, step: 'city-found', hints }, say: ['Let me find that…'], expect: FREE, effect: { kind: 'findCity', query: text } }
    }
    case 'city-found': {
      const found = a.kind === 'cities' ? a.cities : []
      if (found.length === 1) return chosen(state, found[0], ctx)
      if (found.length > 1) {
        const options = found.map((c): [string, string] => [c.slug, c.state ? `${c.name}, ${c.state}` : c.name])
        return { state: { ...state, step: 'city-pick', cities: found }, say: ['Which one do you mean?'], expect: choice([...options, ['none', 'None of these']], true) }
      }
      const why = a.kind === 'failed' ? `I couldn’t look that up: ${a.message}` : 'I couldn’t find a city or town by that name in India.'
      return { state: { ...state, step: 'city' }, say: [why, 'Type just its name, like Rajpura or Pune.'], expect: choice([['bengaluru', 'Bengaluru']], true) }
    }
    case 'city-pick': {
      const c = a.kind === 'choice' ? state.cities?.find((x) => x.slug === a.id) : undefined
      if (c) return chosen(state, c, ctx)
      if (a.kind === 'text') return onboard({ ...state, step: 'city' }, a, ctx)
      return askCity(state)
    }
    case 'when': {
      if (a.kind === 'choice' && a.id === 'other') return { state: { ...state, step: 'when-date' }, say: ['Which day does it start?'], expect: { kind: 'date' } }
      const start = a.kind === 'choice' && a.id === 'tomorrow' ? addDays(today, 1) : today
      return { state: { ...state, step: 'days', start }, say: ['And for how many days?'], expect: DAYS }
    }
    case 'when-date': {
      if (a.kind !== 'date' || a.date < today) return { state, say: ['Pick today or a day after it.'], expect: { kind: 'date' } }
      return { state: { ...state, step: 'days', start: a.date }, say: ['And for how many days?'], expect: DAYS }
    }
    case 'days': {
      const days = a.kind === 'choice' ? Number(a.id) : 1
      return askStay({ ...state, days: Math.min(14, Math.max(1, days || 1)) }, ctx)
    }
    case 'stay': {
      if (a.kind !== 'place') return askStay(state, ctx)
      const start = state.start ?? today
      return {
        state: { ...state, step: 'creating' },
        say: [`${a.place.name}, got it. Setting up your trip…`],
        expect: FREE,
        effect: { kind: 'createTrip', city: state.city ?? BENGALURU, startDate: start, endDate: addDays(start, (state.days ?? 1) - 1), stay: a.place },
      }
    }
    case 'creating': {
      if (a.kind === 'failed') return { state: { ...state, step: 'stay' }, say: [`That didn’t work: ${a.message} Try another place.`], expect: placeIn(state, ctx, 'Your hotel or area') }
      const mentioned = state.hints?.tasks ?? []
      if (mentioned.length) return nextMentioned({ ...state, added: 0, queue: mentioned }, ctx, ['Now the things you mentioned.'])
      return askTask({ ...state, added: 0 }, false)
    }
    case 'task-title': {
      const title = a.kind === 'text' ? a.text.trim().replace(/^(a|an|the)\s+/i, '') : ''
      if (!title) return askTask(state, (state.added ?? 0) > 0)
      const name = title.charAt(0).toUpperCase() + title.slice(1)
      return {
        state: { ...state, step: 'task-place', task: { title: name } },
        say: [`Where is ${the(name)}?`],
        expect: placeIn(state, ctx, state.city && !state.city.sample ? 'A place or area' : 'A place or area, like Koramangala'),
      }
    }
    case 'task-place': {
      if (a.kind !== 'place') return { state, say: [`Pick where ${the(state.task?.title ?? 'it')} is from the list.`], expect: placeIn(state, ctx, 'A place or area') }
      const task = { ...state.task, place: a.place }
      // A time from the first message: no need to ask, unless it has already gone today.
      if (task.fixed && !gone(state, ctx, task.fixed)) return askLength({ ...state, task })
      const lead = task.fixed ? [`${task.fixed} has already passed today, so let’s pick another way.`] : []
      return { state: { ...state, step: 'task-when', task: { ...task, fixed: undefined } }, say: [...lead, 'Does it happen at a fixed time?'], expect: HOW }
    }
    case 'task-when': {
      const id = a.kind === 'choice' ? a.id : 'any'
      if (id === 'fixed') return { state: { ...state, step: 'task-time' }, say: ['What time does it start?'], expect: { kind: 'time' } }
      if (id === 'hours') return { state: { ...state, step: 'task-hours' }, say: ['When is it open?'], expect: choice(Object.entries(WINDOWS).map(([k, w]) => [k, w.label])) }
      return askLength(state)
    }
    case 'task-time': {
      const t = a.kind === 'time' ? a.hhmm : a.kind === 'text' ? clockIn(`at ${a.text}`) : null
      if (!t) return { state, say: ['Give me a time, like 10:00.'], expect: { kind: 'time' } }
      if (gone(state, ctx, t)) return { state: { ...state, step: 'task-when' }, say: [`It’s already past ${t} today. Pick a later time, or another way.`], expect: HOW }
      return askLength({ ...state, task: { ...state.task, fixed: t } })
    }
    case 'task-hours': {
      const w = a.kind === 'choice' ? WINDOWS[a.id] : undefined
      return askLength({ ...state, task: { ...state.task, window: w ? { opensAt: w.opensAt, closesAt: w.closesAt } : undefined } })
    }
    case 'task-length': {
      const min = a.kind === 'choice' ? Number(a.id) : a.kind === 'text' ? parseInt(a.text, 10) : NaN
      const t = state.task ?? {}
      if (!t.title || !t.place) return askTask(state, (state.added ?? 0) > 0)
      return {
        state: { ...state, step: 'adding' },
        say: [`Adding ${the(t.title)}…`],
        expect: FREE,
        effect: { kind: 'addTask', title: t.title, place: t.place, durationMin: Number.isFinite(min) ? Math.min(720, Math.max(15, min)) : 60, fixed: t.fixed, window: t.window },
      }
    }
    case 'adding': {
      if (a.kind === 'failed') return { state: { ...state, step: 'more' }, say: [`I couldn’t add it: ${a.message}`], expect: choice([['another', 'Try another task'], ['plan', 'Plan my day']]) }
      const n = (state.added ?? 0) + 1
      if (state.queue?.length) return nextMentioned({ ...state, added: n, task: {} }, ctx, ['Added.'])
      return { state: { ...state, step: 'more', added: n, task: {} }, say: [n === 1 ? 'Added. Anything else today?' : `Added. That’s ${n} tasks. Anything else?`], expect: choice([['another', 'Add another task'], ['plan', 'That’s all, plan my day']]) }
    }
    case 'more': {
      if (a.kind === 'choice' && a.id === 'plan') return { state: { ...state, step: 'planning' }, say: ['Working out the best order, times and ways to travel…'], expect: FREE, effect: { kind: 'plan' } }
      return askTask(state, true)
    }
    case 'planning': {
      if (a.kind === 'failed') return { state: { ...state, step: 'more' }, say: [`I couldn’t plan it yet: ${a.message}`], expect: choice([['another', 'Add another task'], ['plan', 'Try planning again']]) }
      return { state: { ...state, step: 'planned' }, say: ['Your day is planned!', ...(a.kind === 'done' && a.summary ? [a.summary] : []), 'I’ll be on your Today screen, keeping an eye on the time. Tap me whenever you need me.'], expect: choice([['show', 'Show my day']]) }
    }
    case 'planned':
      return { state: null, say: [], expect: FREE, effect: { kind: 'show' } }
  }
  return { state: null, say: [], expect: FREE }
}

function askLength(state: FlowState): Step {
  return { state: { ...state, step: 'task-length' }, say: [`How long will ${the(state.task?.title ?? 'it')} take?`], expect: choice(LENGTHS) }
}

// ---------------------------------------------------------------------------
// Re-planning today, and starting over
// ---------------------------------------------------------------------------

export function beginReplan(): Step {
  return {
    state: { flow: 'replan', step: 'what' },
    say: ['Sure. What’s changed?'],
    expect: choice([
      ['late', 'I’m running late'],
      ['task', 'A task changed'],
      ['add', 'Add something'],
      ['again', 'Plan again from now'],
      ['new', 'Start a new trip'],
    ]),
  }
}

export function beginNewTrip(ctx: FlowContext): Step {
  const t = ctx.trip
  if (!t) return askCity({ flow: 'newTrip' })
  return {
    state: { flow: 'newTrip', step: 'confirm' },
    say: [`Are you sure? You already have a plan for ${t.cityName} on ${weekday(t.day)}. Shall I adjust that one, or start a completely new trip?`],
    expect: choice([
      ['adjust', 'Adjust this plan'],
      ['new', 'Start a new trip'],
      ['keep', 'Never mind'],
    ]),
  }
}

function replan(state: FlowState, a: Answer, ctx: FlowContext): Step {
  const trip = ctx.trip
  const id = a.kind === 'choice' ? a.id : ''
  switch (state.step) {
    case 'what':
      if (id === 'late') return { state: { ...state, step: 'late' }, say: ['How late are you running?'], expect: choice([['15', '15 min'], ['30', '30 min'], ['45', '45 min'], ['60', 'An hour']]) }
      if (id === 'add') return { state: null, say: ['Let’s add it.'], expect: FREE, effect: { kind: 'action', action: { type: 'add', text: '' } } }
      if (id === 'again') return { state: null, say: ['Shall I plan the rest of your day again, from where you are now?'], expect: FREE, effect: { kind: 'action', action: { type: 'replan' } } }
      if (id === 'new') return beginNewTrip(ctx)
      if (id === 'task') {
        const open = trip?.tasks.filter((t) => t.day === trip.day && t.state !== 'done' && t.state !== 'skipped') ?? []
        if (!open.length) return { state: null, say: ['There’s nothing left to change today.'], expect: FREE }
        return { state: { ...state, step: 'which' }, say: ['Which task?'], expect: choice(open.map((t) => [t.taskId, t.title])) }
      }
      return beginReplan()
    case 'late': {
      const minutes = Number(id) || 15
      return { state: null, say: [`Okay, ${said(minutes)} late. Let’s see what that changes.`], expect: FREE, effect: { kind: 'action', action: { type: 'late', minutes } } }
    }
    case 'which': {
      const task = trip?.tasks.find((t) => t.taskId === id)
      if (!task) return beginReplan()
      const next = trip && addDays(trip.day, 1) <= trip.endDate ? addDays(trip.day, 1) : null
      const options: [string, string][] = [
        ['time', 'Change the time'],
        ['length', 'Change how long'],
        ...(next ? ([['move', `Move it to ${weekday(next)}`]] as [string, string][]) : []),
        ['skip', 'Skip it today'],
      ]
      return { state: { ...state, step: 'how', taskId: task.taskId }, say: [`What about ${the(task.title)}?`], expect: choice(options) }
    }
    case 'how': {
      const task = trip?.tasks.find((t) => t.taskId === state.taskId)
      if (!task || !trip) return beginReplan()
      if (id === 'time') return { state: { ...state, step: 'new-time' }, say: [`What time should ${the(task.title)} start?`], expect: { kind: 'time' } }
      if (id === 'length') return { state: { ...state, step: 'new-length' }, say: [`How long does ${the(task.title)} take now? It was ${said(task.durationMin)}.`], expect: choice(LENGTHS) }
      if (id === 'move') return { state: null, say: [`Shall I move ${the(task.title)} to ${weekday(addDays(trip.day, 1))}?`], expect: FREE, effect: { kind: 'action', action: { type: 'move', taskId: task.taskId, day: addDays(trip.day, 1) } } }
      return { state: null, say: [`Shall I skip ${the(task.title)} today?`], expect: FREE, effect: { kind: 'action', action: { type: 'skip', taskId: task.taskId } } }
    }
    case 'new-time': {
      const t = a.kind === 'time' ? a.hhmm : a.kind === 'text' ? clockIn(`at ${a.text}`) : null
      if (!t || !state.taskId) return { state, say: ['Give me a time, like 14:30.'], expect: { kind: 'time' } }
      return { state: null, say: [`Shall I fix it at ${t}?`], expect: FREE, effect: { kind: 'action', action: { type: 'time', taskId: state.taskId, hhmm: t } } }
    }
    case 'new-length': {
      const minutes = Number(id) || 60
      if (!state.taskId) return beginReplan()
      return { state: null, say: [`Shall I make it ${said(minutes)}?`], expect: FREE, effect: { kind: 'action', action: { type: 'duration', taskId: state.taskId, minutes } } }
    }
  }
  return { state: null, say: [], expect: FREE }
}

function newTrip(state: FlowState, a: Answer, ctx: FlowContext): Step {
  if (state.step === 'confirm') {
    const id = a.kind === 'choice' ? a.id : ''
    if (id === 'adjust') return beginReplan()
    if (id === 'new') {
      const s = askCity({ flow: 'newTrip' })
      return { ...s, say: ['A fresh start, then. Your current trip stays in Your trips.', ...s.say] }
    }
    return { state: null, say: ['Okay, your plan stays as it is.'], expect: FREE }
  }
  // After the confirmation a new trip is set up exactly like the first one.
  return onboard(state, a, ctx)
}

/** The next step of a conversation, from the traveller's answer (or the result of what the app did). */
export function next(state: FlowState, a: Answer, ctx: FlowContext): Step {
  if (a.kind === 'choice' && a.id === 'cancel') return { state: null, say: ['Okay, let’s leave it there.'], expect: FREE }
  if (state.flow === 'onboard') return onboard(state, a, ctx)
  if (state.flow === 'replan') return replan(state, a, ctx)
  if (state.flow === 'dayPlan') {
    if (state.step !== 'confirm') return onboard(state, a, ctx)
    if (a.kind === 'choice' && a.id === 'yes') return nextMentioned({ ...state, added: 0 }, ctx, ['Great, one at a time.'])
    return { state: null, say: ['Okay. Tell me whenever you want to plan it.'], expect: FREE }
  }
  return newTrip(state, a, ctx)
}

/** How a planned day reads in one line, for Roo to say when it's done. */
export function planSummary(view: DayView | null): string | undefined {
  if (!view || !view.legs.length) return undefined
  const leg = view.legs[0]
  const to = view.stops.find((s) => s.id === leg.toId)
  const end = view.stops[view.stops.length - 1]
  return `You leave at ${leg.leaveBy}${to && to.kind !== 'end' ? ` for ${the(to.title)}` : ''}, and you’re back around ${hhmm(end.time)}.`
}
