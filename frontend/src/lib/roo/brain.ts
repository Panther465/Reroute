// Roo's brain on the phone: a sentence and the day as it is, in; what Roo says and what it offers to do,
// out. Plain patterns, no AI and no network, so it answers at once and offline. What it can't place comes
// back `unknown`, for the server's AI helper when that's on. Nothing here changes anything: a change to
// the day is offered as a card the traveller confirms.

import type { Task, Trip } from '@/api/types'
import { duration, hhmm, lowerFirst, rupees } from '@/lib/format'
import { addDays, localMinutes, weekday, type DayView } from '@/lib/timeline'
import { minutesIn, parseCommand } from '@/lib/voice'

export type RooAction =
  | { type: 'late'; minutes: number | null }
  | { type: 'done' }
  | { type: 'left' }
  | { type: 'skip'; taskId: string }
  | { type: 'move'; taskId: string; day: string }
  | { type: 'duration'; taskId: string; minutes: number }
  | { type: 'time'; taskId: string; hhmm: string }
  | { type: 'replan' }
  | { type: 'undo' }
  | { type: 'add'; text: string }
  | { type: 'options' }
  | { type: 'theme'; theme: 'light' | 'dark' | 'system' }
  | { type: 'voice'; on: boolean }

/** Screens Roo can point to. */
export type RooLink = { label: string; to: '/why' | '/summary' | '/plan' | '/raasta' | '/me' }

export type RooMood = 'idle' | 'happy' | 'alert' | 'sleeping' | 'celebrate' | 'wave' | 'thinking'

export interface RooAnswer {
  reply: string
  mood?: RooMood
  action?: RooAction
  /** A change to the day: Roo asks first, with this card. */
  confirm?: { title: string; detail?: string; yes: string }
  links?: RooLink[]
  /** The task the answer was about, so "it" means it next time. */
  taskId?: string
  /** Roo couldn't place the sentence. */
  unknown?: boolean
  /** Roo only recognised a task in it and said what it knows: the AI helper, when on, may do better. */
  guess?: boolean
}

export interface RooContext {
  trip: Trip | undefined
  view: DayView | null
  clock: number | null
  /** The leg the traveller said they've left on ("I've left"), by its destination. */
  leftFor: string | null
  name?: string | null
  /** The task the conversation is about. */
  lastTaskId?: string | null
}

const HELP = 'Try “I’m 20 minutes late”, “move the bank to tomorrow”, “make the meeting 2 hours” or “what’s next?”'

const clean = (s: string) => s.toLowerCase().replace(/[’']/g, "'").replace(/[.,!?]/g, ' ').replace(/\s+/g, ' ').trim()
const has = (text: string, re: RegExp) => re.test(text)
const firstName = (name?: string | null) => (name ? name.replace(/\s*\(.*\)\s*$/, '').split(/\s+/)[0] : null)
const LATE = /\b(late|behind|delayed|running over|overrun|more time|stuck|more minutes)\b/

// ---------------------------------------------------------------------------
// Finding the task a sentence is about
// ---------------------------------------------------------------------------

const STOP = new Set(['the', 'a', 'an', 'my', 'to', 'at', 'for', 'and', 'of', 'in', 'on', 'with', 'work', 'near', 'road', 'office'])
const words = (s: string) => clean(s).split(' ').filter((w) => w.length > 2 && !STOP.has(w))

function openTasks(trip: Trip) {
  return trip.tasks.filter((t) => t.state !== 'done' && t.state !== 'skipped')
}

/** The task a sentence names, by its title or area; "it" is the task the conversation is about. */
export function findTask(text: string, ctx: RooContext): { task: Task | null; ambiguous: Task[] } {
  const trip = ctx.trip
  if (!trip) return { task: null, ambiguous: [] }
  const said = new Set(clean(text).split(' '))
  const scored = openTasks(trip)
    .map((t) => {
      const title = words(t.title)
      // A one-word title like "Bank" counts double: it is the name people use.
      const score = title.filter((w) => said.has(w) || said.has(`${w}s`)).length * 2 + words(t.place.area).filter((w) => said.has(w)).length
      // "Office" alone names an office task, though it is too common to count elsewhere.
      const office = /\boffice\b/.test(clean(t.title)) && said.has('office') ? 1 : 0
      return { t, score: score + office }
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
  if (scored.length === 1 || (scored.length > 1 && scored[0].score > scored[1].score)) return { task: scored[0].t, ambiguous: [] }
  if (scored.length > 1) return { task: null, ambiguous: scored.filter((x) => x.score === scored[0].score).map((x) => x.t) }
  if (/\b(it|this|that|this one|that one)\b/.test(clean(text))) {
    const id = ctx.lastTaskId ?? ctx.view?.checkInTask?.taskId
    return { task: trip.tasks.find((t) => t.taskId === id) ?? null, ambiguous: [] }
  }
  return { task: null, ambiguous: [] }
}

const the = (t: { title: string }) => `the ${lowerFirst(t.title)}`
const The = (t: { title: string }) => `The ${lowerFirst(t.title)}`

/** The card Roo shows before a change to the day, whoever understood the request (the phone or the AI). */
export function confirmFor(action: RooAction, trip: Trip): RooAnswer['confirm'] | undefined {
  const task = 'taskId' in action ? trip.tasks.find((t) => t.taskId === action.taskId) : undefined
  switch (action.type) {
    case 'skip':
      return task && { title: `Skip ${the(task)}`, detail: 'Later stops move up. You can undo it.', yes: 'Skip it' }
    case 'move':
      return task && { title: `Move ${the(task)} to ${weekday(action.day)}`, detail: 'Today re-plans without it. You can undo it.', yes: 'Move it' }
    case 'time':
      return task && { title: `${The(task)} at ${action.hhmm}`, detail: 'A fixed start time. The day re-plans around it.', yes: 'Set the time' }
    case 'duration':
      return task && { title: `${The(task)}: ${duration(action.minutes)}`, detail: `It was ${duration(task.durationMin)}. The day re-plans.`, yes: 'Change it' }
    case 'replan':
      return { title: 'Plan the day again', detail: 'From where you are now, with every task still to do.', yes: 'Plan it' }
    case 'undo':
      return { title: 'Bring back the earlier plan', detail: 'The last change to your day is undone.', yes: 'Undo it' }
    default:
      return undefined
  }
}

/** A clock time in a sentence: "at 11", "to 2:30 pm", "10.15", "noon". Without am/pm, 1 to 7 is the afternoon. */
export function clockIn(text: string): string | null {
  const t = clean(text)
  if (/\bnoon\b|\bmidday\b/.test(t)) return '12:00'
  const m = t.match(/\b(?:at|to|for|by|from|around)\s+(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a m|p m)?\b/) ?? t.match(/\b(\d{1,2})[:.](\d{2})\s*(am|pm|a m|p m)?\b/) ?? t.match(/\b(\d{1,2})\s*(am|pm|a m|p m)\b/)
  if (!m) return null
  let h = Number(m[1])
  const min = m[2] && /^\d{2}$/.test(m[2]) ? Number(m[2]) : 0
  const ampm = (m[3] ?? (m[2] && !/^\d{2}$/.test(m[2]) ? m[2] : undefined))?.replace(' ', '')
  if (h > 23 || min > 59) return null
  if (ampm === 'pm' && h < 12) h += 12
  else if (ampm === 'am' && h === 12) h = 0
  else if (!ampm && h >= 1 && h <= 7) h += 12
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// What Roo knows about the day, in words
// ---------------------------------------------------------------------------

function destOf(view: DayView, toId: string) {
  const to = view.stops.find((s) => s.id === toId)
  return to ? (to.kind === 'end' ? 'the hotel' : `the ${lowerFirst(to.title)}`) : 'your next stop'
}

/** A reply as Roo says it out loud: "1 h 20 min" and "₹350" written out, so a voice reads them naturally. */
export function forSpeech(text: string): string {
  return text
    .replace(/\b(\d+) h (\d+) min\b/g, (_, h, m) => `${h} ${h === '1' ? 'hour' : 'hours'} ${m} minutes`)
    .replace(/\b(\d+) h\b/g, (_, h) => `${h} ${h === '1' ? 'hour' : 'hours'}`)
    .replace(/\b(\d+) min\b/g, '$1 minutes')
    .replace(/₹\s?([\d,]+)/g, (_, n) => `${n.replace(/,/g, '')} rupees`)
}

/** Where the day stands, in a sentence or two. */
export function status(ctx: RooContext): string {
  const { view, clock, trip } = ctx
  if (!trip) return 'There’s no trip yet. Start one on Plan and I’ll keep an eye on it.'
  if (!view || clock == null) return 'Your day isn’t planned yet. Ask me to plan it, or tap Plan my day.'
  if (view.done) return 'That’s everything for today. Nicely done.'
  if (trip.openOptions) return 'Your later stops don’t fit any more. There are fixes waiting for you to choose.'
  const end = view.stops[view.stops.length - 1]
  const back = end ? ` Back at the hotel around ${hhmm(end.time)}.` : ''
  const leg = view.nextLeg
  if (leg) {
    const dest = destOf(view, leg.toId)
    const left = ctx.leftFor === leg.toId
    if (left) return `You’re on your way to ${dest}, arriving around ${leg.arriveAt}.${back}`
    if (clock >= leg.leaveMin) return `Time to leave for ${dest}. You’ll get there around ${leg.arriveAt}.${back}`
    return `Next, leave at ${leg.leaveBy} for ${dest}, in ${duration(leg.leaveMin - clock)}.${back}`
  }
  return `Your day is on track.${back}`
}

function dayStats(view: DayView) {
  const done = view.stops.filter((s) => s.task?.state === 'done').length
  const tasks = view.stops.filter((s) => s.kind === 'task').length
  return `${done} of ${tasks} tasks done, ${rupees(view.fareInr)} in fares and ${duration(view.travelMin)} travelling.`
}

/** Hello, by the time of day and the traveller's name, and where the day stands. */
export function greeting(ctx: RooContext): RooAnswer {
  const name = firstName(ctx.name)
  const clock = ctx.clock
  const part = clock == null ? 'Hi' : clock < 12 * 60 ? 'Good morning' : clock < 17 * 60 ? 'Good afternoon' : 'Good evening'
  return { reply: `${part}${name ? `, ${name}` : ''}! ${status(ctx)} What can I do for you?`, mood: 'wave' }
}

/** Replies Roo suggests, for the day as it is. */
export function suggestions(ctx: RooContext): string[] {
  const { view, trip, clock } = ctx
  if (!trip) return ['What can you do?']
  if (!view || clock == null) return ['Plan my day', 'What can you do?']
  if (view.done) return ['How did my day go?', 'Why this plan?']
  const out: string[] = []
  if (trip.openOptions) out.push('Show me the fixes')
  out.push('What’s next?', 'I’m running late')
  const task = view.checkInTask
  const stop = task ? view.stops.find((s) => s.id === task.taskId) : undefined
  if (task && stop && stop.status === 'now' && clock >= stop.time) out.push(`Mark the ${lowerFirst(task.title)} done`)
  out.push('Add a task', 'How’s my day?', 'Why this plan?')
  return out
}

// ---------------------------------------------------------------------------
// Understanding a sentence
// ---------------------------------------------------------------------------

function nextTripDay(trip: Trip, text: string): string | null {
  const days: string[] = []
  for (let d = addDays(trip.day, 1); d <= trip.endDate; d = addDays(d, 1)) days.push(d)
  if (!days.length) return null
  const named = days.find((d) => clean(text).includes(weekday(d).toLowerCase()))
  return named ?? days[0]
}

function taskEdit(t: string, ctx: RooContext): RooAnswer | null {
  const trip = ctx.trip
  if (!trip) return null
  const skip = has(t, /\b(skip|drop|cancel|don't need|do not need|no need|forget about|forget the|remove|not going|won't go|can't go|cannot go)\b/)
  const move = has(t, /\b(tomorrow|next day|another day|day after)\b/) || (has(t, /\b(move|push|shift|postpone|reschedule|do|wait|keep)\b/) && has(t, /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/))
  const time = clockIn(t)
  const timeVerb = has(t, /\b(move|change|make|set|reschedule|shift|start|put|book|fix)\b/) || has(t, /\b(at|to)\s+\d/)
  const mins = minutesIn(t)
  const lengthVerb = has(t, /\b(make|set|change|extend|shorten|give|takes?|take|should take|lasts?|long|needs?|only)\b/)
  if (!skip && !move && !(time && timeVerb) && !(mins && lengthVerb)) return null

  const { task, ambiguous } = findTask(t, ctx)
  if (!task) {
    if (ambiguous.length) return { reply: `Which one do you mean: ${ambiguous.map(the).join(' or ')}?`, mood: 'thinking' }
    return null
  }
  const name = the(task)
  if (skip) {
    const action: RooAction = { type: 'skip', taskId: task.taskId }
    return { reply: `Shall I skip ${name}? The rest of the day moves up to fill the gap.`, action, confirm: confirmFor(action, trip), taskId: task.taskId }
  }
  if (move) {
    const day = nextTripDay(trip, t)
    if (!day) return { reply: `Your trip ends today, so there’s no other day to move ${name} to.`, taskId: task.taskId }
    if (day === task.day) return { reply: `${The(task)} is already on ${weekday(day)}.`, taskId: task.taskId }
    const action: RooAction = { type: 'move', taskId: task.taskId, day }
    return { reply: `Shall I move ${name} to ${weekday(day)}? Today re-plans without it.`, action, confirm: confirmFor(action, trip), taskId: task.taskId }
  }
  if (time && timeVerb && !LATE.test(t)) {
    const action: RooAction = { type: 'time', taskId: task.taskId, hhmm: time }
    return { reply: `Shall I fix ${name} at ${time}? I’ll plan the rest of the day around it.`, action, confirm: confirmFor(action, trip), taskId: task.taskId }
  }
  if (mins && lengthVerb && !LATE.test(t) && !/\bmore\b/.test(t)) {
    const action: RooAction = { type: 'duration', taskId: task.taskId, minutes: Math.min(720, Math.max(15, mins)) }
    return { reply: `Shall I make ${name} ${forSpeech(duration(action.minutes))}? I’ll re-plan the day to fit.`, action, confirm: confirmFor(action, trip), taskId: task.taskId }
  }
  return null
}

/** What a sentence asks of Roo. */
export function understand(spoken: string, ctx: RooContext): RooAnswer {
  const t = clean(spoken)
  const { trip, view, clock } = ctx
  if (!t) return { reply: HELP }

  // Talk
  if (/^(hi|hello|hey|hii+|namaste|namaskar|hola|yo|good (morning|afternoon|evening))( roo)?$/.test(t)) return greeting(ctx)
  if (/\b(thanks|thank you|thx|shukriya|dhanyavaad|dhanyavad|cheers)\b/.test(t)) return { reply: 'Any time! I’m right here on your Now line.', mood: 'happy' }
  if (/\b(who are you|what are you|your name)\b/.test(t)) return { reply: 'I’m Roo, your travel companion. I watch your day, nudge you when it’s time to go, and change the plan when you ask.', mood: 'wave' }
  if (/\b(how are you|how're you|how r u|how do you do)\b/.test(t)) return { reply: `I’m good, thanks for asking! ${status(ctx)}`, mood: 'happy' }
  if (/\b(help|what can you do|what do you do|commands)\b/.test(t)) {
    return { reply: `I can tell you what’s next, deal with running late, mark stops done, skip or move a task, change its time or length, plan the day again, or undo a change. ${HELP}`, mood: 'happy' }
  }

  // Settings
  if (/\b(dark|night)\s*(mode|theme)\b|\bgo dark\b|\bturn (the )?lights off\b/.test(t)) return { reply: 'Dark mode it is. Easier on the eyes at night.', action: { type: 'theme', theme: 'dark' }, mood: 'happy' }
  if (/\b(light|day|bright)\s*(mode|theme)\b/.test(t)) return { reply: 'Light mode it is.', action: { type: 'theme', theme: 'light' }, mood: 'happy' }
  if (/\b(mute|be quiet|stop talking|silence|quiet mode|no voice|turn off (the |your )?voice)\b/.test(t)) return { reply: 'I’ll stay quiet. Alerts still show on screen and chime.', action: { type: 'voice', on: false } }
  if (/\b(unmute|turn on (the |your )?voice|speak up|talk out loud|read (it|them) (out|aloud))\b/.test(t)) return { reply: 'I’ll read your alerts out loud again.', action: { type: 'voice', on: true }, mood: 'happy' }

  // The plan as a whole
  if (/\b(undo|change it back|put it back|revert|go back to the (old|earlier|previous|last) plan|previous plan)\b/.test(t)) {
    return { reply: 'Shall I bring back your earlier plan?', action: { type: 'undo' }, confirm: trip && confirmFor({ type: 'undo' }, trip) }
  }
  if (/\b(re-?plan|plan (my|the) day( again)?|plan (it|everything) again|optimi[sz]e|re-?route (my|the) day|start over)\b/.test(t)) {
    if (!trip) return { reply: 'There’s no trip to plan yet. Start one on Plan.', links: [{ label: 'Go to Plan', to: '/plan' }] }
    return { reply: 'Shall I plan the rest of your day again, from where you are now?', action: { type: 'replan' }, confirm: confirmFor({ type: 'replan' }, trip) }
  }
  if (/\b(show (me )?the fixes|options|choose a fix|what are my options)\b/.test(t) && trip?.openOptions) return { reply: 'Here are the fixes for the rest of your day.', action: { type: 'options' } }
  if (/\bwhy\b/.test(t) && !LATE.test(t)) return { reply: 'I compared your day by cab, without cabs and every way for each leg. Here’s how I chose.', links: [{ label: 'Why this plan?', to: '/why' }], mood: 'happy' }
  if (/\b(how('s| is| was) my day|how did (my day|it|today) go|summary|expense|expenses|spent|spend|how much)\b/.test(t)) {
    if (!view) return { reply: status(ctx) }
    return { reply: `${status(ctx)} So far: ${dayStats(view)}`, links: [{ label: 'See the summary', to: '/summary' }], mood: 'happy' }
  }
  if (/\b(shared autos?|raasta|e-?rickshaws?|tempos?|auto routes?)\b/.test(t)) return { reply: 'Raasta has the shared autos and e-rickshaws riders have mapped and checked.', links: [{ label: 'Open Raasta', to: '/raasta' }] }
  if (/\b(settings|preferences|my profile)\b/.test(t)) return { reply: 'Your settings are on Me.', links: [{ label: 'Open Me', to: '/me' }] }

  // One task: skip it, move it, change its time or its length
  const edit = taskEdit(t, ctx)
  if (edit) return edit

  // The day as it goes: late, done, left, next, add
  const cmd = parseCommand(spoken)
  if (cmd.kind === 'add') {
    const text = spoken.replace(/^\s*(please\s+)?(can you\s+)?(add( a task)?( to)?|remind me to|i also need to|i need to|new task:?)\s*/i, '').trim()
    return { reply: text ? `Let’s add it. Check the details, then I’ll fit it into your day.` : 'Let’s add a task.', action: { type: 'add', text } }
  }
  if (cmd.kind !== 'unknown' && (!trip || !view || clock == null || view.done)) {
    return { reply: view?.done ? 'That’s everything for today.' : 'Your day isn’t planned yet. Ask me to plan it.', mood: 'idle' }
  }
  if (cmd.kind === 'late' && view) {
    if (trip?.openOptions) return { reply: 'Your later stops already don’t fit. Here are the fixes.', action: { type: 'options' }, mood: 'alert' }
    const ok = cmd.minutes != null && cmd.minutes >= 5 && cmd.minutes <= 240
    return {
      reply: ok ? `Okay, ${cmd.minutes} minutes late. Let’s see what that changes.` : 'How late are you? Pick it here and I’ll work out the rest.',
      action: { type: 'late', minutes: ok ? cmd.minutes : null },
      mood: 'alert',
    }
  }
  if (cmd.kind === 'done' && view && clock != null) {
    const task = view.checkInTask
    const stop = task ? view.stops.find((s) => s.id === task.taskId) : undefined
    if (!task || !stop) return { reply: 'There’s nothing to mark done right now.' }
    if (stop.time - clock > 10) return { reply: `The ${lowerFirst(task.title)} starts at ${hhmm(stop.time)}. Tap Mark done if it’s really finished.`, taskId: task.taskId }
    return { reply: `The ${lowerFirst(task.title)} is done. Nice one!`, action: { type: 'done' }, mood: 'celebrate', taskId: task.taskId }
  }
  if ((cmd.kind === 'left' || cmd.kind === 'next') && view && clock != null) {
    const leg = view.nextLeg
    if (!leg) return { reply: 'No more travel today.' }
    const dest = destOf(view, leg.toId)
    const arrive = `You should arrive around ${leg.arriveAt}.`
    if (cmd.kind === 'next') return { reply: clock >= leg.leaveMin ? `Leave now for ${dest}. ${arrive}` : `Leave at ${leg.leaveBy} for ${dest}, in ${duration(leg.leaveMin - clock)}. ${arrive}`, mood: clock >= leg.leaveMin ? 'alert' : 'idle' }
    if (ctx.leftFor === leg.toId) return { reply: `You’re already on your way. ${arrive}` }
    const here = view.checkInTask ? view.stops.find((s) => s.id === view.checkInTask?.taskId) : undefined
    if (here?.status === 'now') return { reply: `Finish the ${lowerFirst(here.title)} first. Tell me when it’s done.` }
    return { reply: leg.toId === 'end' ? 'On your way back. Safe travels!' : `On your way to ${dest}. ${arrive}`, action: { type: 'left' }, mood: 'happy' }
  }

  // Where things stand
  if (/\b(am i on time|on track|status|where am i|what now|what should i do|what do i do|what's happening|update)\b/.test(t)) return { reply: status(ctx) }
  if (/\b(when do i (get|reach)|when will i (get|be)|what time (do|will) i get) (back|home|to the hotel)\b/.test(t) && view) {
    const end = view.stops[view.stops.length - 1]
    return { reply: end ? `You’ll be back at the hotel around ${hhmm(end.time)}.` : status(ctx) }
  }
  const { task } = findTask(t, ctx)
  if (task && view) {
    const stop = view.stops.find((s) => s.id === task.taskId)
    const when = stop ? `at ${hhmm(stop.time)}, until ${hhmm(stop.end)}` : task.fixedStart ? `at ${hhmm(localMinutes(task.fixedStart, task.day, trip?.utcOffset))} on ${weekday(task.day)}` : task.day !== view.day ? `on ${weekday(task.day)}` : 'not in today’s plan'
    return { reply: `${The(task)} is ${when}, at ${task.place.area}. Want to change it? Say “move it to tomorrow” or “make it an hour”.`, taskId: task.taskId, guess: true }
  }

  return { reply: `I’m not sure I follow. ${HELP}`, unknown: true, mood: 'thinking' }
}
