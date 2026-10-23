// One conversation with Roo, shared by the chat panel and the welcome screen: the messages, Roo typing
// and speaking, the questions it asks (lib/roo/flows.ts), the cards it offers, and the work behind them.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { api, ApiError, newKey } from '@/api/client'
import { keys, queryClient, waitForJob } from '@/api/queries'
import type { City, JobAccepted, Place, RooOut, RooStep, Trip } from '@/api/types'
import { addTask, applyServerChange, checkIn, editTask, moveTaskToDay, replanDay, skipTask, undo, undoVersionOf } from '@/lib/actions'
import { hhmm } from '@/lib/format'
import { useOpenLate } from '@/lib/late'
import { askAgent, asksMore, forAgent, runProposal, SCREEN_PATHS, undoProposal } from '@/lib/roo/agent'
import { confirmFor, forSpeech, understand, type RooAction, type RooAnswer, type RooContext, type RooLink } from '@/lib/roo/brain'
import { beginDayPlan, beginEditTask, beginNewTrip, beginOnboard, beginReplan, intro, next, planSummary, type Answer, type Effect, type Expect, type FlowContext, type FlowState } from '@/lib/roo/flows'
import { understandPlan } from '@/lib/roo/understand'
import { cancel as hush, enqueue } from '@/lib/speech/channel'
import { useSpeaking } from '@/lib/speech/useSpeaking'
import { getState, setState, type Theme } from '@/lib/store'
import { buildDay, weekday, type DayView } from '@/lib/timeline'
import { listenOnce, VoiceError } from '@/lib/voice'
import { topUp } from '@/lib/wallet'
import type { PlanCardData } from './PlanCard'
import type { Mood } from './RooArt'

export type CardState = 'ask' | 'busy' | 'done' | 'no' | 'failed'
export interface Card {
  action: RooAction
  title: string
  detail?: string
  yes: string
  state: CardState
}
export interface ChatMsg {
  id: string
  from: 'roo' | 'me'
  text: string
  at: number
  card?: Card
  links?: RooLink[]
  /** Typed out as it arrives (a message restored from earlier shows at once). */
  fresh?: boolean
  /** The voice line it was said with (lib/speech/channel.ts), so the words appear as they're spoken. */
  speechId?: number
  /** Roo's agent's card: everything it would do, done only on "Do all". */
  plan?: PlanCardData
  /** What Roo looked at before answering ("Read your day"). */
  reads?: string[]
}

const KEEP = 40
const FREE: Expect = { kind: 'free' }
const id = () => Math.random().toString(36).slice(2, 10)

function load(key: string | null): ChatMsg[] {
  if (!key) return []
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) ?? '[]') as ChatMsg[]
    // A change cut off by a reload never ran: ask again (a card that did run says so when tapped). Nothing
    // restored types itself out again.
    return saved.map((m) => ({
      ...m,
      fresh: false,
      card: m.card?.state === 'busy' ? { ...m.card, state: 'ask' as const } : m.card,
      plan: m.plan?.state === 'busy' ? { ...m.plan, state: 'ask' as const } : m.plan?.state === 'undoing' ? { ...m.plan, state: 'done' as const } : m.plan,
    }))
  } catch {
    return []
  }
}

/** How long Roo takes to type a reply out, word by word (ChatThread's Typewriter uses the same pace). */
export const typingMs = (text: string) => Math.min(1500, text.split(/\s+/).length * 38)

/** What the server's AI offered, in the phone's terms, with the same card the phone would show. */
function fromServer(out: RooOut, trip: Trip): RooAnswer {
  const a = out.action
  if (!a) return { reply: out.reply, mood: 'happy' }
  const task = a.taskId ?? ''
  let action: RooAction | undefined
  let links: RooLink[] | undefined
  if (a.type === 'late') action = { type: 'late', minutes: a.minutes ?? null }
  else if (a.type === 'done' || a.type === 'left' || a.type === 'replan' || a.type === 'undo') action = { type: a.type }
  else if (a.type === 'skip') action = { type: 'skip', taskId: task }
  else if (a.type === 'move' && a.day) action = { type: 'move', taskId: task, day: a.day }
  else if (a.type === 'duration' && a.minutes) action = { type: 'duration', taskId: task, minutes: a.minutes }
  else if (a.type === 'time' && a.time) action = { type: 'time', taskId: task, hhmm: a.time }
  else if (a.type === 'add') action = { type: 'add', text: a.text ?? '' }
  else if (a.type === 'theme' && a.theme) action = { type: 'theme', theme: a.theme }
  else if (a.type === 'why') links = [{ label: 'Why this plan?', to: '/why' }]
  else if (a.type === 'summary') links = [{ label: 'See the summary', to: '/summary' }]
  return { reply: out.reply, action, confirm: action && confirmFor(action, trip), links, taskId: a.taskId ?? undefined, mood: 'happy' }
}

export interface ConversationOptions {
  /** Where the conversation is kept for the session (null: not kept). */
  storageKey: string | null
  ctx: RooContext
  ai: boolean
  /** Roo's agent is on (the server's AI helper with a Gemini key): it answers what the phone can't place. */
  agent?: boolean
  online: boolean
  /** Roo reads its replies aloud. */
  voice: boolean
  /** The chat steps aside for a sheet or a screen (the panel closes on a phone). */
  stepAside: () => void
  /** "Show my day" at the end of setting up a trip. */
  onShow: () => void
}

export function useConversation(o: ConversationOptions) {
  const navigate = useNavigate()
  const openLate = useOpenLate()
  const [msgs, setMsgs] = useState<ChatMsg[]>(() => load(o.storageKey))
  const [thinking, setThinking] = useState(false)
  // Roo's agent is working on a message (reading the day, places, fares).
  const [working, setWorking] = useState(false)
  // Talking is whatever Roo's one voice is saying: a line aloud, or murmuring as it types.
  const talking = useSpeaking() !== null
  const [listening, setListening] = useState(false)
  const [mood, setMood] = useState<Mood>('happy')
  const [flow, setFlow] = useState<FlowState | null>(null)
  const [expect, setExpect] = useState<Expect>(FREE)
  const [busy, setBusy] = useState(false)
  const lastTask = useRef<string | null>(null)
  // Each reply Roo gives is a turn. A new message from the traveller ends the turn being spoken: the rest
  // of its lines still appear, quietly.
  const turn = useRef(0)
  const listenCtl = useRef<AbortController | null>(null)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  // The trip a conversation made (a new trip): tasks are added to it and it is planned.
  const flowTrip = useRef<Trip | null>(null)
  // The theme and voice before a card changed them, so its Undo can put them back.
  const phoneBefore = useRef<Record<string, { theme: Theme; voice: boolean }>>({})
  const latest = useRef(o)
  latest.current = o
  const flowRef = useRef(flow)
  flowRef.current = flow

  useEffect(() => setMsgs(load(o.storageKey)), [o.storageKey])
  useEffect(() => {
    if (!o.storageKey) return
    try {
      sessionStorage.setItem(o.storageKey, JSON.stringify(msgs.slice(-KEEP)))
    } catch {
      // Private mode: the chat lasts until the page closes.
    }
  }, [o.storageKey, msgs])
  // Timers outlive React's development remount (StrictMode), but do nothing once the chat is really gone.
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const later = (fn: () => void, ms: number) =>
    timers.current.push(
      setTimeout(() => {
        if (alive.current) fn()
      }, ms),
    )
  const push = (m: Omit<ChatMsg, 'id' | 'at'>) => setMsgs((all) => [...all, { ...m, id: id(), at: Date.now() }].slice(-KEEP))
  const flowCtx = (): FlowContext => {
    const { ctx } = latest.current
    const t = ctx.trip
    const today = t ? t.day : new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
    const now = ctx.clock != null ? hhmm(ctx.clock) : new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false })
    return { trip: t, view: ctx.view, today, now, name: ctx.name }
  }

  const pause = (ms: number) => new Promise<void>((resolve) => later(resolve, ms))

  /** Roo says one or more lines, one after another, then waits for `expect`. Read aloud, each line appears
   *  as its voice starts and the next waits for it to finish, so nothing is cut off; quiet, each types out
   *  at the usual pace. */
  const say = useCallback(async (lines: string[], extra: { card?: Card; links?: RooLink[]; plan?: PlanCardData; reads?: string[]; mood?: Mood; spoken?: boolean; expect?: Expect } = {}) => {
    const words = lines.filter(Boolean)
    if (!words.length) {
      setThinking(false)
      if (extra.expect) setExpect(extra.expect)
      return
    }
    const mine = ++turn.current
    const aloud = latest.current.voice || !!extra.spoken
    for (let i = 0; i < words.length; i++) {
      const line = words[i]
      const last = i === words.length - 1
      // A short pause, as anyone takes; then the line.
      await pause(i === 0 ? Math.min(700, 260 + line.length * 3) : 420)
      const quiet = !aloud || turn.current !== mine
      const voiced = enqueue(forSpeech(line), { priority: 'chat', silent: quiet, durationMs: typingMs(line) })
      await voiced.started
      if (!alive.current) return
      setThinking(false)
      setMood(extra.mood && extra.mood !== 'idle' ? extra.mood : 'happy')
      push({
        from: 'roo',
        text: line,
        fresh: true,
        speechId: voiced.id,
        ...(i === 0 && extra.reads?.length ? { reads: extra.reads } : {}),
        ...(last ? { card: extra.card, links: extra.links, plan: extra.plan } : {}),
      })
      if (!last) setThinking(true)
      await voiced.done
      if (!alive.current) return
    }
    if (extra.expect) setExpect(extra.expect)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** The traveller said something: Roo stops talking (its words still finish appearing). */
  const interrupt = () => {
    turn.current += 1
    hush('chat')
  }

  // Actions that need no card: a sheet opens, a setting changes, or Roo says where you are.
  const runNow = (action: RooAction) => {
    const { ctx, stepAside } = latest.current
    const { trip: t, view: v, clock: c } = ctx
    if (action.type === 'theme') return setState({ theme: action.theme })
    if (action.type === 'voice') return setState({ alerts: { ...getState().alerts, voice: action.on } })
    if (action.type === 'left' && t && v?.nextLeg && c != null) return setState({ started: { tripId: t.tripId, toId: v.nextLeg.toId, day: t.day, at: c } })
    if (action.type === 'done' && t && v && c != null) return checkIn(t.tripId, v, c)
    // A sheet takes over: the chat steps aside once Roo has said what it's doing.
    later(() => {
      stepAside()
      if (action.type === 'late') openLate(action.minutes)
      else if (action.type === 'options') openLate(null, 'options')
      else if (action.type === 'add') navigate('/', { state: { add: Date.now(), addText: action.text || undefined } })
      else if (action.type === 'flight') navigate('/', { state: { bookFlight: { to: action.to } } })
      else if (action.type === 'tellLate') navigate('/', { state: { tellLate: Date.now() } })
    }, 900)
  }

  /** When the traveller will be back at the hotel, from the fresh trip. */
  const backAt = (tripId: string): string => {
    const trip = queryClient.getQueryData<Trip>(keys.trip(tripId))
    const view = trip ? buildDay(trip) : null
    const end = view?.stops[view.stops.length - 1]
    return end && !view?.done ? ` You’ll be back at the hotel around ${hhmm(end.time)}.` : ''
  }

  /** Where the day stands after a change, from the fresh trip. */
  const afterChange = (tripId: string, action: RooAction): string => {
    const trip = queryClient.getQueryData<Trip>(keys.trip(tripId))
    const back = backAt(tripId)
    const task = trip && 'taskId' in action ? trip.tasks.find((x) => x.taskId === action.taskId) : undefined
    const name = task ? `the ${task.title.toLowerCase()}` : 'it'
    if (action.type === 'move') return `Done. ${name[0].toUpperCase()}${name.slice(1)} is on ${weekday(action.day)} now.${back}`
    if (action.type === 'skip') return `Done. I’ve skipped ${name} and moved the rest up.${back}`
    if (action.type === 'undo') return `Your earlier plan is back.${back}`
    return `Done. Your day is re-planned.${back}`
  }

  const answer = (a: RooAnswer, spoken: boolean) => {
    if (a.taskId) lastTask.current = a.taskId
    if (a.flow === 'editTask') return void begin(a.taskId ? beginEditTask(a.taskId, flowCtx()) : beginReplan())
    if (a.flow) return void startFlow(a.flow)
    const card = a.confirm && a.action ? { action: a.action, ...a.confirm, state: 'ask' as const } : undefined
    void say([a.reply], { card, links: a.links, mood: a.mood, spoken, expect: FREE })
    if (a.action && !card) runNow(a.action)
  }

  // ---- conversations ----

  const doEffect = async (e: Effect, state: FlowState) => {
    const ctx = flowCtx()
    try {
      if (e.kind === 'action') {
        const card = confirmFor(e.action, ctx.trip as Trip)
        if (card) {
          // The question was Roo's last line: the card goes under it.
          setMsgs((all) => {
            const lastRoo = [...all].reverse().find((m) => m.from === 'roo')
            return lastRoo ? all.map((m) => (m.id === lastRoo.id ? { ...m, card: { action: e.action, ...card, state: 'ask' } } : m)) : all
          })
        } else runNow(e.action)
        return
      }
      if (e.kind === 'show') return latest.current.onShow()
      setBusy(true)
      setMood('thinking')
      if (e.kind === 'findCity') {
        const cities = await api.get<City[]>('/v1/cities', { query: { q: e.query.slice(0, 300) } })
        return await feed(state, { kind: 'cities', cities })
      }
      if (e.kind === 'createTrip') {
        const trip = await api.post<Trip>(
          '/v1/trips',
          { citySlug: e.city.slug, cityName: e.city.name, startDate: e.startDate, endDate: e.endDate, stayPlaceId: e.stay.placeId, stayLabel: e.stay.name },
          { idempotencyKey: newKey('trip') },
        )
        queryClient.setQueryData(keys.trip(trip.tripId), trip)
        await queryClient.refetchQueries({ queryKey: keys.trips })
        setState({ tripId: trip.tripId })
        flowTrip.current = trip
        return await feed(state, { kind: 'done' })
      }
      const trip = flowTrip.current ?? ctx.trip
      if (!trip) throw new ApiError(409, 'NO_TRIP', 'There’s no trip to add it to yet.')
      // A trip just set up starts on its first day; otherwise it's the day on screen.
      const day = flowTrip.current ? trip.startDate : trip.day
      if (e.kind === 'addTask') {
        const fixedStart = e.fixed ? `${day}T${e.fixed}:00${trip.utcOffset}` : null
        await addTask(trip.tripId, { title: e.title, placeId: e.place.placeId, durationMin: e.durationMin, fixedStart, window: e.window ?? null, priority: 2, hoursUnknown: false, day }, newKey('task'), { replan: false })
        return await feed(state, { kind: 'done' })
      }
      if (e.kind === 'plan') {
        const job = await api.post<JobAccepted>(`/v1/trips/${trip.tripId}/plans`, { day }, { idempotencyKey: newKey('plan') })
        const done = await waitForJob(job.jobId)
        if (done.status === 'failed' || done.error) throw new ApiError(409, 'NO_FEASIBLE_PLAN', done.error ?? 'Your tasks don’t fit in one day.')
        const fresh = await api.get<Trip>(`/v1/trips/${trip.tripId}`)
        queryClient.setQueryData(keys.trip(trip.tripId), fresh)
        setState({ reveal: Date.now(), change: null, autoBanner: null })
        return await feed(state, { kind: 'done', summary: planSummary(buildDay(fresh)) })
      }
    } catch (err) {
      await feed(state, { kind: 'failed', message: err instanceof ApiError ? err.message : 'Something went wrong.' })
    } finally {
      setBusy(false)
    }
  }

  /** Hand an answer (or a result) to the conversation, and say what comes next. */
  const feed = async (state: FlowState, a: Answer) => {
    const step = next(state, a, flowCtx())
    setFlow(step.state)
    setExpect(FREE)
    await say(step.say, { expect: step.state ? step.expect : FREE, mood: 'happy' })
    if (step.effect) await doEffect(step.effect, step.state ?? state)
  }

  /** Start a conversation at a step worked out elsewhere. */
  const begin = async (step: ReturnType<typeof beginReplan>) => {
    flowTrip.current = null
    setFlow(step.state)
    await say(step.say, { expect: step.expect, mood: 'happy' })
  }

  const startFlow = async (kind: 'onboard' | 'replan' | 'newTrip', withIntro = false) => {
    const step = kind === 'onboard' ? beginOnboard() : kind === 'replan' ? beginReplan() : beginNewTrip(flowCtx())
    flowTrip.current = null
    setFlow(step.state)
    setThinking(true)
    setMood('wave')
    await say([...(withIntro ? intro(latest.current.ctx.name) : []), ...step.say], { expect: step.expect, mood: 'wave' })
  }

  // ---- what the traveller does ----

  const send = async (text: string, spoken = false) => {
    const said = text.trim()
    if (!said || thinking || busy) return
    interrupt()
    push({ from: 'me', text: said })
    setExpect(FREE)
    const f = flowRef.current
    if (f) {
      // In a conversation, typing answers the question (or picks a choice by its words).
      const ex = expect
      if (ex.kind === 'choice') {
        // "yes" answers "Yes, plan my day"; "no" answers "Not now".
        const low = said.toLowerCase()
        const hit = ex.options.find((c) => c.label.toLowerCase() === low || low.includes(c.label.toLowerCase()) || (low.length >= 2 && c.label.toLowerCase().startsWith(low)))
        if (hit) return void feed(f, { kind: 'choice', id: hit.id, label: hit.label })
        if (ex.allowText) return void feed(f, { kind: 'text', text: said })
        // Something else entirely: leave the conversation and answer it.
        setFlow(null)
      } else if (ex.kind === 'text' || ex.kind === 'time') return void feed(f, { kind: 'text', text: said })
      else if (ex.kind === 'place') return
    }
    setThinking(true)
    setMood('thinking')
    const o2 = latest.current
    const local = understand(said, { ...o2.ctx, lastTaskId: lastTask.current })
    const t = o2.ctx.trip
    // A day described in a few sentences: things to do that aren't in the trip yet. Roo offers to plan it,
    // unless the message is plainly about a task already there ("move the bank to 4 pm").
    if (t) {
      const hints = understandPlan(said)
      const known = t.tasks.map((x) => x.title.toLowerCase())
      hints.tasks = hints.tasks.filter((x) => !known.some((k) => k.includes(x.title.toLowerCase())))
      const act = local.action
      const target = act && 'taskId' in act ? t.tasks.find((x) => x.taskId === act.taskId) : undefined
      const aboutKnown = !!target && said.toLowerCase().includes(target.title.toLowerCase().split(/\s+/)[0])
      const open = local.unknown || local.guess || local.action?.type === 'add' || local.action?.type === 'replan' || said.split(/\s+/).length >= 8
      // A day that also asks for more ("…and book a cab to the meeting") is for Roo's agent, which does it all.
      const forPhone = !(o2.agent && o2.online && asksMore(said))
      if (forPhone && (hints.tasks.length >= 2 || (hints.tasks.length === 1 && !aboutKnown && open))) return void begin(beginDayPlan(hints, flowCtx()))
    }
    if (o2.agent && o2.online && forAgent(said, local)) return void agentTurn(said, spoken, local)
    if ((!local.unknown && !local.guess) || !o2.ai || !o2.online || !t) return answer(local, spoken)
    try {
      const history = msgs.slice(-8).map((m) => ({ role: m.from === 'me' ? ('user' as const) : ('roo' as const), text: m.text.slice(0, 600) }))
      const out = await api.post<RooOut>(`/v1/trips/${t.tripId}/roo`, { message: said.slice(0, 500), history }, { idempotencyKey: newKey('roo') })
      answer(fromServer(out, t), spoken)
    } catch {
      answer(local, spoken)
    }
  }

  // ---- Roo's agent ----

  /** A message for Roo's agent: what it read, its reply, a question to tap or its card. If the agent can't
   *  answer (busy, or Gemini is down), the phone's own answer stands in. */
  const agentTurn = async (said: string, spoken: boolean, local: RooAnswer) => {
    const history = msgs.slice(-8).map((m) => ({ role: m.from === 'me' ? ('user' as const) : ('roo' as const), text: m.text.slice(0, 600) }))
    setWorking(true)
    try {
      const out = await askAgent(said, history, latest.current.ctx.trip?.tripId ?? null)
      setWorking(false)
      const ask: Expect = out.ask ? { kind: 'choice', options: out.ask.options.map((label, i) => ({ id: `agent-${i}`, label })), allowText: true } : FREE
      await say([out.reply], { plan: out.proposal ? { proposal: out.proposal, state: 'ask' } : undefined, reads: out.reads, mood: 'happy', spoken, expect: ask })
    } catch {
      setWorking(false)
      answer(local, spoken)
    }
  }

  const setPlan = (msgId: string, change: Partial<PlanCardData>) =>
    setMsgs((all) => all.map((m) => (m.id === msgId && m.plan ? { ...m, plan: { ...m.plan, ...change } } : m)))

  /** After a card ran or was undone: the day, the wallet and the bookings as they are now. */
  const refresh = async (tripId: string | null, before: DayView | null, kind: 'reroute' | 'undo') => {
    void queryClient.invalidateQueries({ queryKey: keys.wallet })
    if (!tripId) return
    void queryClient.invalidateQueries({ queryKey: keys.bookings(tripId) })
    if (tripId === latest.current.ctx.trip?.tripId) return void (await applyServerChange(tripId, before, { kind }))
    // A trip the card started becomes the one on screen.
    await queryClient.refetchQueries({ queryKey: keys.trips })
    setState({ tripId })
  }

  /** The card's steps the app does itself: the theme and voice at once, a screen or sheet once Roo has spoken. */
  const runPhone = (steps: RooStep[]) => {
    for (const s of steps) {
      if (s.tool === 'set_theme') setState({ theme: s.args.theme as Theme })
      else if (s.tool === 'set_voice') setState({ rooVoice: s.args.on === true })
    }
    const go = steps.find((s) => s.tool === 'open_screen' || s.tool === 'tell_them_late' || s.tool === 'show_options')
    if (!go) return
    later(() => {
      latest.current.stepAside()
      if (go.tool === 'show_options') openLate(null, 'options')
      else if (go.tool === 'tell_them_late') navigate('/', { state: { tellLate: Date.now() } })
      else if (go.args.screen === 'add_task') navigate('/', { state: { add: Date.now() } })
      else if (go.args.screen === 'book_flight') navigate('/', { state: { bookFlight: {} } })
      else navigate(SCREEN_PATHS[String(go.args.screen)] ?? '/')
    }, 900)
  }

  const runPlan = async (msgId: string, plan: PlanCardData) => {
    const before = latest.current.ctx.view
    const id = plan.proposal.proposalId
    setPlan(msgId, { state: 'busy' })
    setMood('thinking')
    try {
      const run = await runProposal(id)
      setPlan(msgId, { state: run.state === 'done' ? 'done' : run.state === 'partial' ? 'partial' : 'failed', run })
      phoneBefore.current[id] = { theme: getState().theme, voice: getState().rooVoice }
      await refresh(run.tripId ?? null, before, 'reroute')
      setMood(run.state === 'done' ? 'celebrate' : 'alert')
      later(() => setMood('happy'), 1600)
      const back = run.state !== 'failed' && run.tripId ? backAt(run.tripId) : ''
      void say([`${run.summary}${back}`])
      runPhone(run.phone)
    } catch (err) {
      setMood('alert')
      if (err instanceof ApiError && err.status !== 0) {
        // Expired, already done, or the day changed since: the card can't run as it is.
        setPlan(msgId, { state: 'expired', note: err.message })
        return void say([err.message])
      }
      setPlan(msgId, { state: 'ask' })
      void say(['I lost the connection. Check your day before trying again.'])
    }
  }

  const declinePlan = (msgId: string) => {
    setPlan(msgId, { state: 'no' })
    void say(['Okay, I’ll leave it as it is.'])
  }

  const undoPlan = async (msgId: string, plan: PlanCardData) => {
    const before = latest.current.ctx.view
    const id = plan.proposal.proposalId
    setPlan(msgId, { state: 'undoing' })
    setMood('thinking')
    try {
      const out = await undoProposal(id)
      const was = phoneBefore.current[id]
      if (was) setState({ theme: was.theme, rooVoice: was.voice })
      await refresh(out.tripId ?? null, before, 'undo')
      setPlan(msgId, { state: 'undone' })
      setMood('happy')
      void say([out.summary])
    } catch (err) {
      setPlan(msgId, { state: plan.state })
      setMood('alert')
      void say([`I couldn’t undo that: ${err instanceof ApiError ? err.message : 'something went wrong.'}`])
    }
  }

  const pick = (choiceId: string, label: string) => {
    const f = flowRef.current
    // Outside a conversation, a choice answers Roo's agent's question: it's a message to Roo.
    if (!f) return void send(label)
    interrupt()
    push({ from: 'me', text: label })
    setExpect(FREE)
    if (f) void feed(f, { kind: 'choice', id: choiceId, label })
  }
  const pickPlace = (place: Place) => {
    const f = flowRef.current
    push({ from: 'me', text: place.name })
    setExpect(FREE)
    if (f) void feed(f, { kind: 'place', place })
  }
  const pickDate = (date: string) => {
    const f = flowRef.current
    push({ from: 'me', text: new Date(`${date}T12:00:00`).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' }) })
    setExpect(FREE)
    if (f) void feed(f, { kind: 'date', date })
  }
  const pickTime = (value: string) => {
    const f = flowRef.current
    push({ from: 'me', text: value })
    setExpect(FREE)
    if (f) void feed(f, { kind: 'time', hhmm: value })
  }
  const leaveFlow = () => {
    setFlow(null)
    setExpect(FREE)
    push({ from: 'me', text: 'Never mind' })
    void say(['Okay, let’s leave it there.'], { expect: FREE })
  }

  const run = async (msgId: string, card: Card) => {
    const t = latest.current.ctx.trip
    const set = (state: CardState) => setMsgs((all) => all.map((m) => (m.id === msgId && m.card ? { ...m, card: { ...m.card, state } } : m)))
    set('busy')
    setMood('thinking')
    const before = latest.current.ctx.view
    const a = card.action
    try {
      if (a.type === 'topup') {
        const w = await topUp(a.amount)
        set('done')
        setMood('celebrate')
        later(() => setMood('happy'), 1600)
        return void say([`Done. Your wallet has ${w.balanceInr.toLocaleString('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 })} now.`])
      }
      if (!t) throw new ApiError(409, 'NO_TRIP', 'There’s no trip yet.')
      if (a.type === 'skip') await skipTask(t.tripId, a.taskId, before)
      else if (a.type === 'move') await moveTaskToDay(t.tripId, a.taskId, a.day, before)
      else if (a.type === 'duration') await editTask(t.tripId, a.taskId, { durationMin: a.minutes }, before)
      else if (a.type === 'time') {
        const task = t.tasks.find((x) => x.taskId === a.taskId)
        await editTask(t.tripId, a.taskId, { timing: 'fixed', fixedStart: `${task?.day ?? t.day}T${a.hhmm}:00${t.utcOffset}` }, before)
      } else if (a.type === 'replan') await replanDay(t.tripId, before)
      else if (a.type === 'undo') {
        const version = undoVersionOf(t)
        if (version == null) throw new ApiError(409, 'NOTHING_TO_UNDO', 'There’s no earlier plan to go back to.')
        await undo(t.tripId, version)
      }
      set('done')
      setMood('celebrate')
      later(() => setMood('happy'), 1600)
      void say([afterChange(t.tripId, a)])
    } catch (err) {
      set('failed')
      setMood('alert')
      void say([`I couldn’t do that: ${err instanceof ApiError ? err.message : 'something went wrong.'} Your day is as it was.`])
    }
  }

  const decline = (msgId: string) => {
    setMsgs((all) => all.map((m) => (m.id === msgId && m.card ? { ...m, card: { ...m.card, state: 'no' } } : m)))
    void say(['Okay, I’ll leave it as it is.'])
  }

  const stopListening = () => {
    listenCtl.current?.abort()
    listenCtl.current = null
    setListening(false)
  }
  const listen = async () => {
    if (listening) {
      stopListening()
      return setMood('happy')
    }
    interrupt()
    const ctl = new AbortController()
    listenCtl.current = ctl
    setListening(true)
    setMood('listening')
    try {
      const heard = await listenOnce({ signal: ctl.signal })
      setListening(false)
      void send(heard, true)
    } catch (err) {
      setListening(false)
      setMood('happy')
      void say([err instanceof VoiceError ? err.message : 'I couldn’t listen just now. Type it instead.'])
    }
  }

  return {
    msgs,
    thinking,
    working,
    talking,
    listening,
    mood,
    flow,
    expect,
    busy,
    say,
    send,
    pick,
    pickPlace,
    pickDate,
    pickTime,
    leaveFlow,
    run,
    decline,
    runPlan,
    declinePlan,
    undoPlan,
    listen,
    stopListening,
    startFlow,
  }
}
