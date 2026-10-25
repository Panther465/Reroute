// What the Android app does differently. The app is this same React code inside Capacitor's web view, and
// the web view lacks a few browser features (and Google refuses sign-in inside it), so the app fills them
// in from Android. Every hook stays empty in a browser, where the web code below each check runs as before;
// src/native/boot.ts fills them in before the app first renders, and only inside the app.
import type { PhoneSpeech } from './speech/phoneVoice'
import type { AlertPrefs } from './store'

export interface NativeHooks {
  /** The refresh token the app keeps in the Android Keystore (a browser keeps it in an httpOnly cookie). */
  session: { load: () => Promise<string | null>; save: (token: string) => Promise<void>; clear: () => Promise<void> }
  /** A one-time Google code from Android's own sign-in, for the same server exchange as the web's. */
  googleCode: (scope: string) => Promise<string>
  /** The phone's own voice (the web view has no speechSynthesis). */
  phoneSay: (text: string, prefs: Pick<AlertPrefs, 'voiceRate' | 'volume'>) => PhoneSpeech | null
  /** Listening for one sentence (the web view has no speech recognition). */
  listenOnce: (opts: { ms?: number; signal?: AbortSignal }) => Promise<string>
  /** Phone notifications (the web view has no Notification API). The app sounds even a `silent` one: see native/notifications.ts. */
  notifications: {
    granted: () => boolean
    request: () => Promise<boolean>
    show: (title: string, options: { body?: string; tag?: string; silent?: boolean }) => Promise<void>
  }
  /**
   * Push from Reroute's server through Firebase: this phone's token, or null where the build has no Firebase
   * set up. A browser gets its alerts over the live stream only, which Android stops for an app in the
   * background within seconds.
   */
  push: { token: () => Promise<string | null>; forget: () => Promise<boolean> }
  /** "Hey Rico": Rico's ear on the phone itself (src/native/wake.ts); a browser has none. */
  wake: {
    status: () => Promise<{ modelReady: boolean; enabled: boolean; background: boolean; listening: boolean; microphone: boolean; popUp: boolean; overlay: boolean }>
    download: (onProgress: (percent: number) => void) => Promise<void>
    start: (background: boolean) => Promise<void>
    stop: () => Promise<void>
    /** Rico pops up over other apps on "Hey Rico"; `asked` when Android's "Display over other apps" page opened. */
    popUp: (on: boolean) => Promise<{ asked: boolean }>
    pause: () => Promise<void>
    resume: () => Promise<void>
  }
  /** The status and navigation bars follow the light or dark theme (a browser has theme-color). */
  systemBars: (dark: boolean) => void
  /** Android's share sheet (the web view has no navigator.share). */
  shareText: (text: string, title?: string) => Promise<'shared' | 'cancelled' | 'failed'>
  /** Saves a text file where the traveller can find it (a web view can't download). Resolves with where it went. */
  saveText: (name: string, text: string) => Promise<string | null>
}

export const native: Partial<NativeHooks> = {}

/** True inside the Android app: Capacitor puts its bridge on the page before any of the app's code runs. */
export function isNative(): boolean {
  if (typeof window === 'undefined') return false
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor
  return cap?.isNativePlatform?.() === true
}

/** Where the traveller turns a permission back on: the browser's settings, or Android's for the app. */
export function settingsName(): string {
  return isNative() ? 'Android settings' : 'your browser settings'
}

/**
 * Where the web app lives, for links that leave the phone (a family share link). In a browser that's this
 * page's origin; the app's own page is https://localhost inside the phone, so it uses the API's host, which
 * serves the web app too.
 */
export function webOrigin(apiBase: string): string {
  if (isNative() && apiBase) return new URL(apiBase).origin
  return location.origin
}
