// Alerts for the moments that matter: time to leave, a task about to end, nearly there, arrived.
// Each one plays the traveller's chosen chime, buzzes, has Roo say it in a natural voice and sends a
// phone notification, as chosen in Me, and always shows a toast and tells screen readers, so no alert
// relies on sound alone. Every alert fires once.
import { enqueue } from './speech/channel'
import { notify } from './live'
import { getState, showToast, type ChimeStyle } from './store'

export type Tone = 'nudge' | 'urgent' | 'arrive'

export interface AlertSpec {
  /** Fires once per key, until the app is reloaded with a new day. */
  key: string
  title: string
  /** What Roo says; defaults to the title. */
  speech?: string
  tone?: Tone
  /** Groups phone notifications, so a newer one replaces the older (the server's leave-now uses `leave-<seq>`). */
  tag?: string
}

/** The voices Roo can use, as the server lists them (`GET /v1/speech/voices`). */
export const VOICES: { id: string; label: string }[] = [
  { id: 'en-US-AnaNeural', label: 'Ana, Rico’s own voice' },
  { id: 'en-IN-NeerjaNeural', label: 'Neerja, Indian English' },
  { id: 'en-IN-PrabhatNeural', label: 'Prabhat, Indian English' },
  { id: 'hi-IN-SwaraNeural', label: 'Swara, Hindi accent' },
  { id: 'hi-IN-MadhurNeural', label: 'Madhur, Hindi accent' },
  { id: 'en-GB-SoniaNeural', label: 'Sonia, British English' },
  { id: 'en-US-AriaNeural', label: 'Aria, American English' },
]

const FIRED_KEY = 'reroute:alerts-fired'

function fired(): Set<string> {
  try {
    return new Set(JSON.parse(sessionStorage.getItem(FIRED_KEY) ?? '[]') as string[])
  } catch {
    return new Set()
  }
}

function remember(key: string) {
  const all = [...fired(), key].slice(-200)
  try {
    sessionStorage.setItem(FIRED_KEY, JSON.stringify(all))
  } catch {
    /* private mode: alerts may repeat after a reload */
  }
}

// ---------- Chimes ----------
let audio: AudioContext | null = null
function context() {
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null
  audio ??= new Ctor()
  return audio
}

/** Browsers only allow sound after the first tap or key press: wake the audio then. */
export function unlockAudioOnFirstTouch() {
  const wake = () => {
    void context()?.resume()
    window.removeEventListener('pointerdown', wake)
    window.removeEventListener('keydown', wake)
  }
  window.addEventListener('pointerdown', wake, { once: true })
  window.addEventListener('keydown', wake, { once: true })
}

interface Voicing {
  wave: OscillatorType
  attack: number
  decay: number
  gap: number
  /** Overtone an octave up, for a richer bell. */
  shimmer?: number
}
const STYLES: Record<ChimeStyle, Voicing> = {
  bell: { wave: 'sine', attack: 0.01, decay: 0.9, gap: 0.16, shimmer: 0.25 },
  soft: { wave: 'sine', attack: 0.08, decay: 0.7, gap: 0.22 },
  marimba: { wave: 'triangle', attack: 0.005, decay: 0.35, gap: 0.12, shimmer: 0.12 },
  digital: { wave: 'square', attack: 0.005, decay: 0.12, gap: 0.14 },
}
const NOTES: Record<Tone, number[]> = {
  nudge: [784, 1046],
  urgent: [880, 1175, 880, 1175],
  arrive: [659, 784, 1046],
}

/** Play a chime. Resolves when it has finished, so a voice can follow it. */
export function chime(tone: Tone = 'nudge', style: ChimeStyle = getState().alerts.chime, volume = getState().alerts.volume): Promise<void> {
  const ctx = context()
  if (!ctx || ctx.state !== 'running' || volume <= 0) return Promise.resolve()
  const v = STYLES[style]
  // Square waves are much louder to the ear: keep them in line with the others.
  const peak = Math.max(0.0002, volume * (v.wave === 'square' ? 0.08 : 0.3))
  const start = ctx.currentTime + 0.02
  const notes = NOTES[tone]
  notes.forEach((freq, i) => {
    const t = start + i * v.gap
    const layers: [number, number][] = [[freq, peak], ...(v.shimmer ? ([[freq * 2, peak * v.shimmer]] as [number, number][]) : [])]
    for (const [f, level] of layers) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = v.wave
      osc.frequency.value = f
      gain.gain.setValueAtTime(0.0001, t)
      gain.gain.exponentialRampToValueAtTime(level, t + v.attack)
      gain.gain.exponentialRampToValueAtTime(0.0001, t + v.attack + v.decay)
      osc.connect(gain).connect(ctx.destination)
      osc.start(t)
      osc.stop(t + v.attack + v.decay + 0.05)
    }
  })
  const ms = ((notes.length - 1) * v.gap + v.attack + v.decay) * 1000
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------- Roo's voice ----------
/** Roo says it: the chosen natural voice, or the phone's own voice when that can't be fetched. Resolves once
 *  it's said. An alert cuts in on whatever Roo was saying in the chat (lib/speech/channel.ts). */
export async function speak(text: string, prefs = getState().alerts) {
  await enqueue(text, { priority: 'alert', interrupt: true, prefs }).done
}

// Alerts sound one after another: two in the same minute (leave soon, and a task ending) never talk over each other.
let sounding: Promise<void> = Promise.resolve()

// ---------- The alert ----------
export function raise(spec: AlertSpec, opts: { force?: boolean } = {}) {
  if (!opts.force) {
    if (fired().has(spec.key)) return
    remember(spec.key)
  }
  const prefs = getState().alerts
  const tone = spec.tone ?? 'nudge'
  // The toast is announced to screen readers by itself (a polite live region), so it isn't announced twice.
  showToast({ title: spec.title })
  if (prefs.vibrate && 'vibrate' in navigator) navigator.vibrate?.(tone === 'urgent' ? [180, 90, 180] : tone === 'arrive' ? [80, 60, 80, 60, 200] : 120)
  // The chime first, then Roo's voice, after any alert still sounding.
  sounding = sounding.then(async () => {
    try {
      if (prefs.sound) await chime(tone, prefs.chime, prefs.volume)
      if (prefs.voice) await speak(spec.speech ?? spec.title, prefs)
    } catch {
      /* a sound that fails must not hold back the next alert */
    }
  })
  // On screen, the toast says it; the phone notification is for when Reroute is in the background.
  if (getState().leaveAlerts && 'Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
    void notify('Reroute', { body: spec.title, tag: spec.tag ?? spec.key, silent: prefs.sound || prefs.voice })
  }
}
