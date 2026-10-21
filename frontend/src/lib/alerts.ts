// Alerts for the moments that matter: time to leave, a task about to end, nearly there, arrived.
// Each one plays a chime, buzzes, has Roo say it and sends a phone notification, as the traveller
// chose in Me, and always shows a toast and tells screen readers, so no alert relies on sound alone.
// Every alert fires once.
import { notify } from './live'
import { announce, getState, showToast } from './store'

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

// ---------- Sound ----------
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

const NOTES: Record<Tone, number[]> = {
  nudge: [784, 1046],
  urgent: [880, 1175, 880],
  arrive: [659, 784, 1046],
}

export function chime(tone: Tone = 'nudge') {
  const ctx = context()
  if (!ctx || ctx.state !== 'running') return
  const start = ctx.currentTime + 0.02
  NOTES[tone].forEach((freq, i) => {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = freq
    const t = start + i * 0.16
    gain.gain.setValueAtTime(0.0001, t)
    gain.gain.exponentialRampToValueAtTime(0.25, t + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.38)
    osc.connect(gain).connect(ctx.destination)
    osc.start(t)
    osc.stop(t + 0.4)
  })
}

// ---------- Voice ----------
export function speak(text: string) {
  if (!('speechSynthesis' in window)) return
  const u = new SpeechSynthesisUtterance(text)
  // The alerts are written in English, so an English (India) voice reads them, whatever the app language.
  u.lang = 'en-IN'
  const voices = window.speechSynthesis.getVoices()
  const voice = voices.find((v) => v.lang === 'en-IN') ?? voices.find((v) => v.lang.startsWith('en'))
  if (voice) u.voice = voice
  u.rate = 1
  window.speechSynthesis.cancel()
  window.speechSynthesis.speak(u)
}

// ---------- The alert ----------
export function raise(spec: AlertSpec, opts: { force?: boolean } = {}) {
  if (!opts.force) {
    if (fired().has(spec.key)) return
    remember(spec.key)
  }
  const prefs = getState().alerts
  const tone = spec.tone ?? 'nudge'
  showToast({ title: spec.title })
  announce(spec.title)
  if (prefs.sound) chime(tone)
  if (prefs.vibrate && 'vibrate' in navigator) navigator.vibrate?.(tone === 'urgent' ? [180, 90, 180] : tone === 'arrive' ? [80, 60, 80, 60, 200] : 120)
  if (prefs.voice) speak(spec.speech ?? spec.title)
  // On screen, the toast says it; the phone notification is for when Reroute is in the background.
  if (getState().leaveAlerts && 'Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
    void notify('Reroute', { body: spec.title, tag: spec.tag ?? spec.key })
  }
}
