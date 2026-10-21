// The timeline view model, derived from the API's trip. Pure: no fetching, no clock.
// The server plans; this only turns its plan (done legs + remaining legs, ISO times with the city's
// offset) into stations and line segments, and works out where the traveller is from check-ins and `now`.
import type { Leg, LogEntry, SharedTrip, Task, Trip } from '@/api/types'
import { hhmm, toMin } from './format'

export type Mode = Leg['mode']
export type StopStatus = 'done' | 'now' | 'upcoming'

export interface TaskView {
  taskId: string
  title: string
  place: { name: string; area: string }
  placeId: string
  durationMin: number
  /** "HH:MM" in the city's time, when the task is fixed. */
  fixedStart?: string
  window?: { opensAt: string; closesAt: string }
  priority: number
  state: Task['state']
  hoursUnknown: boolean
  day: string
}

export interface StopView {
  id: string
  kind: 'start' | 'task' | 'end'
  title: string
  area: string
  placeId: string
  /** Minutes from midnight of the trip day, in the city's time. */
  time: number
  end: number
  task?: TaskView
  status: StopStatus
  problem?: 'late' | 'closed'
}

export interface LegView {
  seq: number
  taskId: string | null
  label: string
  segments: { mode: Mode; minutes: number }[]
  leaveBy: string
  arriveAt: string
  leaveMin: number
  arriveMin: number
  travelMin: number
  waitMin: number
  fareInr: number
  optionId: string
  raasta?: { routeId: string; status: 'verified' | 'unverified' | 'stale' }
  extras: Leg['extras']
  fromId: string
  toId: string
  fromPlaceId: string
  toPlaceId: string
  status: 'done' | 'active' | 'upcoming'
  /** Every time and fare is an estimate. */
  estimate: boolean
}

export interface TomorrowItem {
  id: string
  title: string
  area: string
  time: number
  task: TaskView
  moved: boolean
}

export interface DayView {
  stops: StopView[]
  legs: LegView[]
  tomorrow: TomorrowItem[]
  /** Today's tasks the planner couldn't fit, with why in plain words. */
  leftOut: { taskId: string; title: string; reason: string }[]
  /** Today's open tasks newer than the plan: the plan doesn't know about them yet. */
  notPlanned: { taskId: string; title: string }[]
  nowIndex: number
  nextLeg: LegView | null
  done: boolean
  /** The task "Mark done" would mark done: the current one, else the next. */
  checkInTask: TaskView | null
  travelMin: number
  fareInr: number
  version: number | null
  planId: string | null
  reasonCodes: string[]
  explanation: string
  now: number
  day: string
}

/** Minutes for a "+05:30"-style offset. */
export function offsetMinutes(offset: string) {
  const sign = offset.startsWith('-') ? -1 : 1
  const [h, m] = offset.replace(/^[+-]/, '').split(':').map(Number)
  return sign * (h * 60 + (m || 0))
}

/**
 * Minutes from midnight of `day`, in the city's time, for any ISO 8601 instant.
 * The API sends plan times with the city's offset but stamps like log times may come back in UTC,
 * so this converts by the absolute instant rather than slicing the string.
 */
export function localMinutes(iso: string, day: string, offset = '+05:30'): number {
  const local = Date.parse(iso) + offsetMinutes(offset) * 60_000
  return Math.floor((local - Date.parse(`${day}T00:00:00Z`)) / 60_000)
}

export function toTaskView(t: Task, offset = '+05:30'): TaskView {
  return {
    taskId: t.taskId,
    title: t.title,
    place: { name: t.place.name, area: t.place.area },
    placeId: t.placeId,
    durationMin: t.durationMin,
    fixedStart: t.fixedStart ? hhmm(localMinutes(t.fixedStart, t.day, offset)) : undefined,
    window: t.window ?? undefined,
    priority: t.priority,
    state: t.state,
    hoursUnknown: t.hoursUnknown,
    day: t.day,
  }
}

function legView(leg: Leg, day: string, fromId: string, offset: string): LegView {
  const ref = leg.transitRef
  const leaveMin = localMinutes(leg.leaveBy, day, offset)
  const arriveMin = localMinutes(leg.arriveAt, day, offset)
  return {
    seq: 0,
    taskId: leg.taskId,
    label: leg.label,
    segments: leg.segments,
    leaveBy: hhmm(leaveMin),
    arriveAt: hhmm(arriveMin),
    leaveMin,
    arriveMin,
    travelMin: leg.travelMin,
    waitMin: leg.waitMin,
    fareInr: leg.fareInr,
    optionId: leg.optionId,
    raasta: ref && ref.kind === 'raasta' ? { routeId: ref.refId, status: ref.status ?? 'verified' } : undefined,
    extras: leg.extras ?? [],
    fromId,
    toId: leg.taskId ?? 'end',
    fromPlaceId: leg.fromPlaceId,
    toPlaceId: leg.toPlaceId,
    status: 'upcoming',
    estimate: leg.estimate ?? true,
  }
}

const GONE: Task['state'][] = ['done', 'skipped', 'moved']

function leftOutReason(kind: string, reason: string) {
  if (kind === 'skipped') return 'It was marked "if there is time", and today is full.'
  if (/in this snapshot$/.test(reason)) return 'Reroute has no travel times to this place yet.'
  return `${reason.replace(/\.$/, '')}.`
}

/** Build the day from the trip. `nowOverride` lets the UI tick the clock between fetches. */
export function buildDay(trip: Trip, nowOverride?: number): DayView | null {
  const plan = trip.activePlan
  if (!plan) return null
  const day = trip.day
  const off = trip.utcOffset
  const at = (iso: string) => localMinutes(iso, day, off)
  const now = nowOverride ?? at(trip.now)
  const tasks = new Map(trip.tasks.map((t) => [t.taskId, t]))
  const raw = [...(plan.doneLegs ?? []), ...plan.legs]

  const stay = trip.stayPlace
  const stops: StopView[] = []
  const legs: LegView[] = []
  if (raw.length) {
    stops.push({ id: 'start', kind: 'start', title: stay.name, area: stay.area, placeId: stay.placeId, time: at(raw[0].leaveBy), end: at(raw[0].leaveBy), status: 'upcoming' })
  }
  let prevId = 'start'
  raw.forEach((leg, i) => {
    const lv = legView(leg, day, prevId, off)
    lv.seq = i + 1
    legs.push(lv)
    const task = leg.taskId ? tasks.get(leg.taskId) : undefined
    if (task) {
      const tv = toTaskView(task, off)
      const stop: StopView = { id: task.taskId, kind: 'task', title: task.title, area: task.place.area, placeId: task.placeId, time: at(leg.taskStart), end: at(leg.taskEnd), task: tv, status: 'upcoming' }
      if (tv.window && stop.end > toMin(tv.window.closesAt)) stop.problem = 'closed'
      stops.push(stop)
    } else {
      const t = at(leg.arriveAt)
      stops.push({ id: 'end', kind: 'end', title: stay.name, area: stay.area, placeId: stay.placeId, time: t, end: t, status: 'upcoming' })
    }
    prevId = lv.toId
  })

  // Where is the traveller? The first open task whose leg has already left is under way.
  let nowIndex = 0
  let current = -1
  for (let i = 1; i < stops.length; i++) {
    const s = stops[i]
    if (s.kind === 'task' && GONE.includes(s.task!.state)) {
      nowIndex = i
      continue
    }
    if (legs[i - 1].leaveMin <= now) current = i
    break
  }
  if (current >= 0) nowIndex = current
  const last = stops.length - 1
  if (last > 0 && stops[last].kind === 'end' && nowIndex === last - 1 && stops[last - 1].kind === 'task' && GONE.includes(stops[last - 1].task!.state) && legs[last - 1].arriveMin <= now) {
    nowIndex = last
  }
  if (last > 0 && stops.slice(1, last).every((s) => s.kind !== 'task' || GONE.includes(s.task!.state)) && legs[last - 1].leaveMin <= now) {
    nowIndex = last
  }

  stops.forEach((s, i) => (s.status = i < nowIndex ? 'done' : i === nowIndex ? 'now' : 'upcoming'))
  legs.forEach((l, i) => (l.status = i + 1 <= nowIndex ? 'done' : i + 1 === nowIndex + 1 ? 'active' : 'upcoming'))

  // A fixed task is at risk when the task before it still isn't checked in done more than
  // 5 minutes after the leg to it should have left (the brief's "behind schedule" rule).
  legs.forEach((l, i) => {
    const stop = stops[i + 1]
    const before = stops[i]
    const beforeOpen = before.kind === 'task' && !GONE.includes(before.task!.state)
    if (stop.kind === 'task' && stop.task?.fixedStart && beforeOpen && now > l.leaveMin + 5) stop.problem = 'late'
  })

  const checkIn = stops.find((s, i) => i >= 1 && s.kind === 'task' && !GONE.includes(s.task!.state))
  const moved = new Map((plan.moved ?? []).filter((m) => m.kind === 'moved').map((m) => [m.taskId, m]))
  const nextDay = addDays(day, 1)
  const tomorrow: TomorrowItem[] = moved.size
    ? trip.tasks
        .filter((t) => t.day === nextDay || moved.has(t.taskId))
        .map((t) => {
          const m = moved.get(t.taskId)
          const time = m?.toDayStart ? localMinutes(m.toDayStart, nextDay, off) : t.fixedStart ? localMinutes(t.fixedStart, nextDay, off) : t.window ? toMin(t.window.opensAt) : 600
          return { id: t.taskId, title: t.title, area: t.place.area, time, task: toTaskView(t, off), moved: !!m }
        })
        .sort((a, b) => a.time - b.time)
    : []

  // Never let a task vanish: say which of today's tasks the plan leaves out, and why.
  const open = (id: string) => {
    const t = tasks.get(id)
    return !!t && t.state !== 'done'
  }
  // A skip the traveller chose (an accepted "skip" option) is their decision, not a warning.
  const leftOut = (plan.moved ?? [])
    .filter((m) => m.kind !== 'moved' && open(m.taskId) && !(m.kind === 'skipped' && plan.trigger === 'skipped'))
    .map((m) => ({ taskId: m.taskId, title: m.title, reason: leftOutReason(m.kind, m.reason) }))
  const accounted = new Set<string>([...raw.map((l) => l.taskId ?? ''), ...(plan.moved ?? []).map((m) => m.taskId)])
  const notPlanned = trip.tasks.filter((t) => t.day === day && !GONE.includes(t.state) && !accounted.has(t.taskId)).map((t) => ({ taskId: t.taskId, title: t.title }))

  const nextLeg = legs.find((l) => l.status === 'active') ?? null
  return {
    stops,
    legs,
    tomorrow,
    leftOut,
    notPlanned,
    nowIndex,
    nextLeg,
    done: nowIndex === stops.length - 1,
    checkInTask: checkIn?.task ?? null,
    travelMin: legs.reduce((n, l) => n + l.travelMin, 0),
    fareInr: legs.reduce((n, l) => n + l.fareInr, 0),
    version: plan.version ?? null,
    planId: plan.planId,
    reasonCodes: plan.reasonCodes,
    explanation: plan.explanation,
    now,
    day,
  }
}

/** The family view: the server already worked out stops and statuses; no IDs or places are shared. */
export function sharedToDay(shared: SharedTrip): DayView {
  const day = shared.day
  const offset = shared.utcOffset
  const now = localMinutes(shared.now, day, offset)
  const stops: StopView[] = shared.stops.map((s, i) => ({
    id: `s${i}`,
    kind: i === 0 ? 'start' : i === shared.stops.length - 1 && !s.end ? 'end' : 'task',
    title: s.title,
    area: s.area,
    placeId: '',
    time: localMinutes(s.time, day, offset),
    end: s.end ? localMinutes(s.end, day, offset) : localMinutes(s.time, day, offset),
    status: s.status === 'done' ? 'done' : s.status === 'now' ? 'now' : 'upcoming',
    task: s.end ? { taskId: `s${i}`, title: s.title, place: { name: s.title, area: s.area }, placeId: '', durationMin: localMinutes(s.end, day, offset) - localMinutes(s.time, day, offset), fixedStart: s.fixed ? hhmm(localMinutes(s.time, day, offset)) : undefined, priority: 1, state: s.status === 'done' ? 'done' : 'planned', hoursUnknown: false, day } : undefined,
  }))
  let nowIndex = stops.findIndex((s) => s.status === 'now')
  if (nowIndex < 0) nowIndex = stops.filter((s) => s.status === 'done').length - 1
  stops.forEach((s, i) => (s.status = i < nowIndex ? 'done' : i === nowIndex ? 'now' : 'upcoming'))
  const legs: LegView[] = shared.legs.map((l, i) => ({
    seq: i + 1,
    taskId: null,
    label: l.label,
    segments: l.segments,
    leaveBy: hhmm(localMinutes(l.leaveBy, day, offset)),
    arriveAt: hhmm(localMinutes(l.arriveAt, day, offset)),
    leaveMin: localMinutes(l.leaveBy, day, offset),
    arriveMin: localMinutes(l.arriveAt, day, offset),
    travelMin: l.travelMin,
    waitMin: 0,
    fareInr: 0,
    optionId: '',
    extras: [],
    fromId: stops[i]?.id ?? '',
    toId: stops[i + 1]?.id ?? '',
    fromPlaceId: '',
    toPlaceId: '',
    status: i + 1 <= nowIndex ? 'done' : i + 1 === nowIndex + 1 ? 'active' : 'upcoming',
    estimate: true,
  }))
  return { stops, legs, tomorrow: [], leftOut: [], notPlanned: [], nowIndex: Math.max(0, nowIndex), nextLeg: legs.find((l) => l.status === 'active') ?? null, done: nowIndex === stops.length - 1, checkInTask: null, travelMin: 0, fareInr: 0, version: null, planId: null, reasonCodes: [], explanation: '', now, day }
}

export interface ChangeSet {
  changedStops: string[]
  changedLegs: number[]
  movedTasks: string[]
  announcement: string
}

/** What changed between two versions of the day, for the reroute choreography and the screen-reader announcement. */
export function diffDays(before: DayView, after: DayView): ChangeSet {
  const beforeTimes = new Map(before.stops.map((s) => [s.id, s.time]))
  const changedStops = after.stops.filter((s) => s.status === 'upcoming' && beforeTimes.has(s.id) && beforeTimes.get(s.id) !== s.time).map((s) => s.id)
  const sig = (l: LegView) => `${l.fromId}>${l.toId}:${l.leaveBy}:${l.segments.map((s) => s.mode + s.minutes).join(',')}`
  const beforeSigs = new Set(before.legs.map(sig))
  const changedLegs = after.legs.filter((l) => l.status !== 'done' && !beforeSigs.has(sig(l))).map((l) => l.seq)
  const beforeTomorrow = new Set(before.tomorrow.filter((t) => t.moved).map((t) => t.id))
  const movedTasks = after.tomorrow.filter((t) => t.moved && !beforeTomorrow.has(t.id)).map((t) => t.id)
  const parts = after.stops.filter((s) => s.kind === 'task' && changedStops.includes(s.id)).map((s) => `${s.title} now at ${hhmm(s.time)}.`)
  after.tomorrow.filter((t) => movedTasks.includes(t.id)).forEach((t) => parts.push(`${t.title} moves to tomorrow at ${hhmm(t.time)}.`))
  return { changedStops, changedLegs, movedTasks, announcement: parts.join(' ') }
}

/** When the latest change Reroute or the traveller made, that hasn't been undone, happened. */
export function lastReroute(log: LogEntry[], day: string, offset = '+05:30'): number | null {
  const hit = log.find((e) => !e.undone && (e.kind === 'shift' || e.kind === 'option'))
  return hit ? localMinutes(hit.at, day, offset) : null
}

export function addDays(day: string, n: number) {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** "Wednesday 14 October", in the trip's calendar (dates are plain dates, so UTC formatting is exact). */
export function dayLabel(day: string) {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })
}

export function weekday(day: string) {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' })
}
