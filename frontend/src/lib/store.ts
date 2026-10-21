// Local UI state (useSyncExternalStore). Trip data lives on the server and in the persisted query
// cache; this store only holds preferences and transient UI: toasts, the reroute choreography, banners.
import { useSyncExternalStore } from 'react'
import { diffDays, type ChangeSet, type DayView } from './timeline'

export type Theme = 'system' | 'light' | 'dark'
export type ChimeStyle = 'bell' | 'soft' | 'marimba' | 'digital'
export type VoiceRate = 'slow' | 'normal' | 'fast'
export interface AlertPrefs {
  sound: boolean
  chime: ChimeStyle
  /** 0 to 1, for the chime and the voice. */
  volume: number
  vibrate: boolean
  voice: boolean
  /** An Edge neural voice (the server lists them); the phone's own voice is the fallback. */
  voiceId: string
  voiceRate: VoiceRate
}
export const DEFAULT_ALERTS: AlertPrefs = { sound: true, chime: 'bell', volume: 0.8, vibrate: true, voice: true, voiceId: 'en-IN-NeerjaNeural', voiceRate: 'normal' }
export type Lang = 'en' | 'hi'

export interface Change extends ChangeSet {
  token: number
  kind: 'reroute' | 'undo' | 'checkin'
  before: DayView
  pillDelayMs: number
}

export interface UiState {
  theme: Theme
  lang: Lang
  leaveAlerts: boolean
  /** How alerts reach the traveller, beyond the toast every alert shows. */
  alerts: AlertPrefs
  demo: { enabled: boolean; offline: boolean }
  /** The trip the traveller chose to look at; null means the most recent one. */
  tripId: string | null
  // Transient, never persisted
  change: Change | null
  reveal: number
  /** The automatic-shift banner. It clears once the plan moves on from `version`, or on the next check-in. */
  autoBanner: { text: string; previousVersion: number | null; version: number | null } | null
  /** "Leave now" from the live stream, for leg `seq`. It expires once that leg's leave-by time has passed. */
  leaveNow: { text: string; at: number; seq: number | null } | null
  pendingDelay: number | null
  /** Optimistic check-ins, shown before the server confirms them. */
  optimisticDone: string[]
  /**
   * The traveller said "I've left" for the stop `toId` (a task ID, or "end" for the way back). Kept by
   * destination, not leg number, so it survives a re-plan and a reload. Local only.
   */
  started: { tripId: string; toId: string } | null
}

const KEY = 'reroute:prefs:v2'
const PERSISTED: (keyof UiState)[] = ['theme', 'lang', 'leaveAlerts', 'alerts', 'demo', 'started', 'tripId']

function defaults(): UiState {
  return {
    theme: 'system',
    lang: 'en',
    leaveAlerts: false,
    alerts: DEFAULT_ALERTS,
    demo: { enabled: false, offline: false },
    tripId: null,
    change: null,
    reveal: 0,
    autoBanner: null,
    leaveNow: null,
    pendingDelay: null,
    optimisticDone: [],
    started: null,
  }
}

function load(): UiState {
  const base = defaults()
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const saved = JSON.parse(raw) as Partial<UiState>
      for (const k of PERSISTED) if (saved[k] !== undefined) (base as unknown as Record<string, unknown>)[k] = saved[k]
      // "Go offline" is a demo switch for this visit only: a reload always starts online.
      base.demo = { enabled: !!saved.demo?.enabled, offline: false }
      // Settings saved by an older version keep their choices; new ones start at their defaults.
      base.alerts = { ...DEFAULT_ALERTS, ...(saved.alerts ?? {}) }
    }
  } catch {
    /* ignore corrupt storage */
  }
  const params = new URLSearchParams(location.search)
  if (params.get('demo') === '1') base.demo = { ...base.demo, enabled: true }
  if (params.get('demo') === '0') base.demo = { ...base.demo, enabled: false }
  return base
}

let state: UiState = load()
const listeners = new Set<() => void>()

function persist() {
  const out: Partial<UiState> = {}
  for (const k of PERSISTED) (out as Record<string, unknown>)[k] = state[k]
  out.demo = { enabled: state.demo.enabled, offline: false }
  try {
    localStorage.setItem(KEY, JSON.stringify(out))
  } catch {
    /* storage full or blocked */
  }
}

export function getState() {
  return state
}

export function setState(patch: Partial<UiState> | ((s: UiState) => Partial<UiState>)) {
  const p = typeof patch === 'function' ? patch(state) : patch
  state = { ...state, ...p }
  persist()
  listeners.forEach((l) => l())
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function useStore<T>(select: (s: UiState) => T): T {
  return useSyncExternalStore(subscribe, () => select(state))
}

let token = 1
export const nextToken = () => token++
const uid = () => Math.random().toString(36).slice(2, 9)

// ---------- Toasts ----------
export interface ToastItem {
  id: string
  title: string
  /** The version Undo makes active again. */
  undoVersion?: number | null
  /** A local Undo (a check-in not sent yet). */
  onUndo?: () => void
  /** Runs once when the toast closes for any reason other than Undo. */
  onClose?: () => void
  /** Milliseconds before it closes (default 8 s). */
  duration?: number
}
let toasts: ToastItem[] = []
const toastListeners = new Set<() => void>()
export function useToasts() {
  return useSyncExternalStore(
    (l) => {
      toastListeners.add(l)
      return () => toastListeners.delete(l)
    },
    () => toasts,
  )
}
export function getToasts() {
  return toasts
}
export function showToast(t: Omit<ToastItem, 'id'>) {
  const id = uid()
  // A toast pushed out by newer ones still runs its close action.
  const dropped = toasts.slice(0, -2)
  toasts = [...toasts.slice(-2), { ...t, id }]
  toastListeners.forEach((l) => l())
  dropped.forEach((d) => settleToast(d.id, 'close', d))
  return id
}
export function dismissToast(id: string) {
  toasts = toasts.filter((t) => t.id !== id)
  toastListeners.forEach((l) => l())
}
// Each toast's Undo or close action runs once, however it closes (button, timeout, swipe, pushed out).
const settled = new Set<string>()
export function settleToast(id: string, how: 'undo' | 'close', item = toasts.find((t) => t.id === id)) {
  if (!item || settled.has(id)) return
  settled.add(id)
  if (how === 'undo') item.onUndo?.()
  else item.onClose?.()
}

// ---------- Announcer ----------
let announcement = ''
const announceListeners = new Set<() => void>()
export function announce(text: string) {
  announcement = ''
  announceListeners.forEach((l) => l())
  setTimeout(() => {
    announcement = text
    announceListeners.forEach((l) => l())
  }, 60)
}
export function useAnnouncement() {
  return useSyncExternalStore(
    (l) => {
      announceListeners.add(l)
      return () => announceListeners.delete(l)
    },
    () => announcement,
  )
}

// ---------- The reroute choreography (UI brief, section 9) ----------
export function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

interface PlayOpts {
  kind: 'reroute' | 'undo' | 'checkin'
  before: DayView | null
  after: DayView | null
  toast?: string
  undoVersion?: number | null
  /** Show the automatic-shift banner instead of asking. */
  banner?: string
}

/** Run the choreography for a change the server just made, then toast and announce it. */
export function playChange({ kind, before, after, toast, undoVersion, banner }: PlayOpts) {
  if (before && after) {
    const diff = diffDays(before, after)
    setState({ change: { ...diff, token: nextToken(), kind, before, pillDelayMs: kind === 'reroute' ? 1000 : 0 }, pendingDelay: null })
    if (toast) {
      const delay = kind === 'reroute' && !prefersReducedMotion() ? 1200 : 0
      setTimeout(() => showToast({ title: toast, undoVersion: undoVersion ?? null }), delay)
      announce(`${toast.split('.')[0]}. ${diff.announcement}${undoVersion != null ? ' Undo available.' : ''}`)
    }
  } else if (toast) {
    showToast({ title: toast, undoVersion: undoVersion ?? null })
    announce(toast)
  }
  if (banner) setState({ autoBanner: { text: banner, previousVersion: undoVersion ?? null, version: after?.version ?? null } })
}
