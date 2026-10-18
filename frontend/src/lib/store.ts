// Local UI state (useSyncExternalStore). Trip data lives on the server and in the persisted query
// cache; this store only holds preferences and transient UI: toasts, the reroute choreography, banners.
import { useSyncExternalStore } from 'react'
import { diffDays, type ChangeSet, type DayView } from './timeline'

export type Theme = 'system' | 'light' | 'dark'
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
  demo: { enabled: boolean; offline: boolean }
  // Transient, never persisted
  change: Change | null
  reveal: number
  autoBanner: { text: string; previousVersion: number | null } | null
  leaveNow: { text: string; at: number } | null
  pendingDelay: number | null
  /** Optimistic check-ins, shown before the server confirms them. */
  optimisticDone: string[]
  /** The leg the traveller said they started ("Start this leg"); local only. */
  startedSeq: number | null
}

const KEY = 'reroute:prefs:v2'
const PERSISTED: (keyof UiState)[] = ['theme', 'lang', 'leaveAlerts', 'demo']

function defaults(): UiState {
  return {
    theme: 'system',
    lang: 'en',
    leaveAlerts: false,
    demo: { enabled: false, offline: false },
    change: null,
    reveal: 0,
    autoBanner: null,
    leaveNow: null,
    pendingDelay: null,
    optimisticDone: [],
    startedSeq: null,
  }
}

function load(): UiState {
  const base = defaults()
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const saved = JSON.parse(raw) as Partial<UiState>
      for (const k of PERSISTED) if (saved[k] !== undefined) (base as unknown as Record<string, unknown>)[k] = saved[k]
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
export function showToast(t: Omit<ToastItem, 'id'>) {
  toasts = [...toasts.slice(-2), { ...t, id: uid() }]
  toastListeners.forEach((l) => l())
}
export function dismissToast(id: string) {
  toasts = toasts.filter((t) => t.id !== id)
  toastListeners.forEach((l) => l())
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
    setState({ change: { ...diff, token: nextToken(), kind, before, pillDelayMs: kind === 'reroute' ? 1000 : 0 }, pendingDelay: null, optimisticDone: [] })
    if (toast) {
      const delay = kind === 'reroute' && !prefersReducedMotion() ? 1200 : 0
      setTimeout(() => showToast({ title: toast, undoVersion: undoVersion ?? null }), delay)
      announce(`${toast.split('.')[0]}. ${diff.announcement}${undoVersion != null ? ' Undo available.' : ''}`)
    }
  } else if (toast) {
    showToast({ title: toast, undoVersion: undoVersion ?? null })
    announce(toast)
  }
  if (banner) setState({ autoBanner: { text: banner, previousVersion: undoVersion ?? null } })
}
