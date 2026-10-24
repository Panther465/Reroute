// The Android app's own pieces, put in place before the app first renders (src/main.tsx loads this only
// inside the app). The web code checks the hooks in lib/platform.ts and finds them filled in here.
import { native } from '@/lib/platform'
import { forgetPush, retryPush, showPushed } from '@/lib/push'
import { getSessionStatus, onSessionChange } from '@/lib/session'
import { googleCode } from './google'
import { notifications, startNotifications } from './notifications'
import { push, startPush } from './push'
import { session } from './session'
import { saveText, shareText } from './share'
import { startShell, systemBars } from './shell'

// Rico's own start (ricoBoot.ts) is locked with the rest of his code (lib/rico.tsx): without it, the app starts without him.
const rico = Object.values(import.meta.glob<{ prepare: () => Promise<void>; start: () => Promise<void> }>('./ricoBoot.ts', { eager: true }))[0]

/**
 * Push changes that failed (no signal) are tried again when the signal is back or the app returns to the screen.
 * Signed out, a phone the server was never told about drops its Firebase token, so the last traveller's alerts
 * stop: this runs from here because no screen of the app shell is mounted while signed out.
 */
function keepPushInStep() {
  const signedOut = () => {
    if (getSessionStatus() === 'signedOut') void forgetPush().catch(() => {})
  }
  const again = () => {
    void retryPush().catch(() => {})
    signedOut()
  }
  onSessionChange(signedOut)
  window.addEventListener('online', again)
  return again
}

export async function boot() {
  Object.assign(native, { session, googleCode, notifications, push, shareText, saveText, systemBars })
  await rico?.prepare()
  const pushAgain = keepPushInStep()
  // Neither may hold the app back: a failure here only loses that one piece.
  const results = await Promise.allSettled([
    startNotifications(),
    startShell(() => {
      void notifications.refresh()
      pushAgain()
    }),
    // Signed out, the alert belongs to whoever was signed in: it isn't shown.
    startPush((alert) => {
      if (getSessionStatus() !== 'signedOut') void showPushed(alert)
    }),
    rico?.start() ?? Promise.resolve(),
  ])
  for (const r of results) if (r.status === 'rejected') console.warn('Reroute: an Android piece failed to start', r.reason)
}
