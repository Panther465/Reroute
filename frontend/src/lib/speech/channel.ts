// Roo's one voice. Lines play one after another and none cuts the one before it off; an alert can cut in.
// While a line plays, the channel knows exactly where it is in it, so Roo's mouth (3D or flat) and the
// words appearing on screen follow the voice. With the voice off, a "silent" line takes its typing time and
// the mouth murmurs along. Silent lines make no sound, so they never wait behind a voice (an alert being
// read out doesn't hold up the chat); they keep their own order.

import { REST, type MouthParams } from '@/lib/roo/lipsync/mouth'
import { buildTrack, estimateWords, sampleTrack, type Key } from '@/lib/roo/lipsync/timeline'
import { getState, type AlertPrefs } from '@/lib/store'
import { prepare, type Prepared } from './clips'
import { loudAt } from './envelope'
import { phoneSay } from './phoneVoice'

export type Priority = 'chat' | 'alert'

/** What's being said right now, for React (`useSpeaking`). */
export interface Speaking {
  id: number
  priority: Priority
  voiced: boolean
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (v: T) => void
}
function deferred<T = void>(): Deferred<T> {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

interface Item {
  id: number
  text: string
  priority: Priority
  silent: boolean
  durationMs: number
  prefs: AlertPrefs
  clip?: Promise<Prepared | null>
  started: Deferred<void>
  done: Deferred<void>
  cancelled: boolean
}

interface Current {
  item: Item
  track: Key[]
  /** 1 when speaking aloud; less when murmuring along with typing. */
  strength: number
  durationMs: number
  clock: () => number
  clip: Prepared | null
  stop: () => void
}

/** A breath between two lines. */
const GAP_MS = 120

let seq = 0
const queue: Item[] = []
let current: Current | null = null
/** A silent line murmuring now, and the end of the silent lines waiting their turn. */
let murmur: Current | null = null
let murmurTail: Promise<void> = Promise.resolve()
const silentWaiting = new Set<Item>()
let running = false
let snapshot: Speaking | null = null
const listeners = new Set<() => void>()
let el: HTMLAudioElement | null = null
/** The browser refused to play before the first tap: lines go silent until one. */
let blocked = false

function emit() {
  const now = current ?? murmur
  snapshot = now ? { id: now.item.id, priority: now.item.priority, voiced: now.strength >= 1 } : null
  listeners.forEach((l) => l())
}

export function subscribe(l: () => void) {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function speakingNow(): Speaking | null {
  return snapshot
}

function audio(): HTMLAudioElement {
  el ??= new Audio()
  el.preload = 'auto'
  return el
}

/** Queue a line. `started` resolves when it begins (when its words should appear), `done` when it ends or is
 *  cancelled. `durationMs` is how long a silent line lasts (its typing time). */
export function enqueue(
  text: string,
  opts: { priority?: Priority; interrupt?: boolean; silent?: boolean; durationMs?: number; prefs?: AlertPrefs } = {},
): { id: number; started: Promise<void>; done: Promise<void>; cancel: () => void } {
  const prefs = opts.prefs ?? getState().alerts
  const item: Item = {
    id: ++seq,
    text,
    priority: opts.priority ?? 'chat',
    silent: !!opts.silent,
    durationMs: Math.max(0, opts.durationMs ?? 0),
    prefs,
    started: deferred(),
    done: deferred(),
    cancelled: false,
  }
  if (opts.interrupt) cancel()
  if (item.silent) {
    silentWaiting.add(item)
    murmurTail = murmurTail.then(async () => {
      silentWaiting.delete(item)
      if (!item.cancelled) await playSilent(item)
      settle(item)
    })
  } else {
    // Fetched now, so the next line is ready the moment this one's turn comes.
    item.clip = prepare(text, prefs).catch(() => null)
    queue.push(item)
    void run()
  }
  return { id: item.id, started: item.started.promise, done: item.done.promise, cancel: () => drop(item) }
}

function settle(item: Item) {
  item.started.resolve()
  item.done.resolve()
}

function drop(item: Item) {
  item.cancelled = true
  const i = queue.indexOf(item)
  if (i >= 0) {
    queue.splice(i, 1)
    settle(item)
  } else if (silentWaiting.delete(item)) settle(item)
  else if (current?.item === item) current.stop()
  else if (murmur?.item === item) murmur.stop()
}

/** Stop what's being said and what's waiting (only Roo's chat lines, with `priority: 'chat'`). Their
 *  promises resolve, so the conversation goes on in silence. */
export function cancel(priority?: Priority) {
  for (const item of [...queue, ...silentWaiting]) if (!priority || item.priority === priority) drop(item)
  if (current && (!priority || current.item.priority === priority)) drop(current.item)
  if (murmur && (!priority || murmur.item.priority === priority)) drop(murmur.item)
}

async function run() {
  if (running) return
  running = true
  try {
    while (queue.length) {
      const item = queue.shift()!
      if (!item.cancelled) await play(item)
      settle(item)
      if (queue.length && queue[0].priority === 'chat') await new Promise((r) => setTimeout(r, GAP_MS))
    }
  } finally {
    running = false
  }
}

function begin(item: Item, c: Omit<Current, 'item'>) {
  if (item.silent) murmur = { item, ...c }
  else current = { item, ...c }
  emit()
  item.started.resolve()
}

function end(item: Item) {
  if (current?.item === item) current = null
  if (murmur?.item === item) murmur = null
  emit()
  item.done.resolve()
}

async function play(item: Item): Promise<void> {
  if (!item.silent) {
    const clip = await item.clip
    if (item.cancelled) return
    if (clip && !blocked && (await playClip(item, clip))) return
    if (!clip && (await playPhone(item))) return
  }
  await playSilent(item)
}

async function playClip(item: Item, clip: Prepared): Promise<boolean> {
  const a = audio()
  a.src = clip.url
  a.volume = item.prefs.volume
  try {
    await a.play()
  } catch (err) {
    if (err instanceof DOMException && err.name === 'NotAllowedError') {
      blocked = true
      window.addEventListener('pointerdown', () => (blocked = false), { once: true })
    }
    return false
  }
  const words = clip.words.length ? clip.words : estimateWords(item.text, clip.durationMs)
  const finished = new Promise<void>((resolve) => {
    const cap = setTimeout(resolve, Math.max(3000, clip.durationMs * 1.6))
    const stop = () => {
      clearTimeout(cap)
      a.removeEventListener('ended', stop)
      a.removeEventListener('error', stop)
      resolve()
    }
    a.addEventListener('ended', stop)
    a.addEventListener('error', stop)
    begin(item, {
      track: buildTrack(words),
      strength: 1,
      durationMs: clip.durationMs,
      clock: () => a.currentTime * 1000,
      clip,
      stop: () => {
        a.pause()
        stop()
      },
    })
  })
  await finished
  end(item)
  return true
}

async function playPhone(item: Item): Promise<boolean> {
  const phone = phoneSay(item.text, item.prefs)
  if (!phone || !(await phone.started)) {
    phone?.cancel()
    return false
  }
  if (item.cancelled) {
    phone.cancel()
    return true
  }
  begin(item, {
    track: buildTrack(estimateWords(item.text, phone.estimateMs)),
    strength: 1,
    durationMs: phone.estimateMs,
    clock: phone.elapsed,
    clip: null,
    stop: phone.cancel,
  })
  await phone.done
  end(item)
  return true
}

async function playSilent(item: Item): Promise<void> {
  const ms = item.durationMs || Math.min(1500, item.text.split(/\s+/).length * 38)
  const t0 = performance.now()
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    begin(item, {
      track: buildTrack(estimateWords(item.text, ms), 0),
      strength: 0.5,
      durationMs: ms,
      clock: () => performance.now() - t0,
      clip: null,
      stop: () => {
        clearTimeout(timer)
        resolve()
      },
    })
  })
  end(item)
}

/** Roo's mouth right now, or null when Roo isn't saying anything. */
export function mouthNow(): MouthParams | null {
  const now = current ?? murmur
  if (!now) return null
  const t = now.clock()
  const loud = now.clip ? loudAt(now.clip.env, t) : 0.8
  return sampleTrack(now.track, t, loud, now.strength) ?? REST
}

/** How far through line `id` the voice is (0–1): 1 once it's over, 0 while it waits. */
export function progressOf(id: number): number {
  const now = current?.item.id === id ? current : murmur?.item.id === id ? murmur : null
  if (now) return Math.max(0, Math.min(1, now.clock() / Math.max(1, now.durationMs)))
  if (queue.some((i) => i.id === id) || [...silentWaiting].some((i) => i.id === id)) return 0
  return id <= seq ? 1 : 0
}
