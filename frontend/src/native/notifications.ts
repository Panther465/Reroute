// Phone notifications in the Android app, from Android itself (the web view has no Notification API).
// The same moments as on the web: an alert while Reroute is in the background, a leave-now from the
// live stream. A newer notification with the same tag replaces the older one, as on the web. They're shown
// by the app's own Alerts (android/.../Alerts.java), as pushes are: the same alert from both shows once.
import { LocalNotifications } from '@capacitor/local-notifications'
import { showAlert } from './push'

const ALERTS = 'alerts'

let granted = false

/** A notification's number from its tag: the same tag, the same notification. */
export function notificationId(tag: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < tag.length; i++) {
    h ^= tag.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h & 0x7fffffff) || 1
}

async function refresh() {
  granted = (await LocalNotifications.checkPermissions()).display === 'granted'
}

export async function startNotifications() {
  await Promise.all([
    LocalNotifications.createChannel({ id: ALERTS, name: 'Alerts', description: 'Time to leave, nearly there and arrived.', importance: 4, visibility: 1 }),
    refresh(),
  ])
}

/** How often the permission is checked while Android is asked, and for how long at most. */
const ASK_CHECK_MS = 1000
const ASK_GIVE_UP_MS = 60_000

/**
 * Android's answer to the permission request, or the permission seen allowed: on a phone the request was left
 * unanswered (the switch in Me waited forever, and push never registered), so the permission is also checked every
 * second while it's asked, and the request is given up on after a minute.
 */
function asked(): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false
    const finish = (allowed: boolean) => {
      if (done) return
      done = true
      clearInterval(check)
      clearTimeout(giveUp)
      resolve(allowed)
    }
    const check = setInterval(() => {
      void LocalNotifications.checkPermissions().then((p) => p.display === 'granted' && finish(true), () => {})
    }, ASK_CHECK_MS)
    const giveUp = setTimeout(() => finish(false), ASK_GIVE_UP_MS)
    LocalNotifications.requestPermissions().then((p) => finish(p.display === 'granted'), () => finish(false))
  })
}

export const notifications = {
  granted: () => granted,
  /** Turned on or off in Android's settings while the app was away. */
  refresh: () => refresh().catch(() => {}),
  async request(): Promise<boolean> {
    // Already allowed: nothing to ask Android.
    await refresh().catch(() => {})
    if (!granted) granted = await asked()
    return granted
  },
  /**
   * Always with Android's sound, even when the web asks for a silent one (because Rico's chime or voice says it):
   * Android may not play a web view's sound while the app is in the background, which is when these show.
   * Not an exact alarm: these show at once, and for an exact one the plugin first opens Android's "Alarms &
   * reminders" screen, which Android refuses to open from the background, so the alert would never show.
   * An alert that replaces an earlier one under the same tag ("Leave now" after "Leave in 9 min") sounds too.
   */
  async show(title: string, { body = '', tag }: { body?: string; tag?: string; silent?: boolean }): Promise<void> {
    if (!granted) return
    const key = tag ?? `${title}\n${body}`
    try {
      await showAlert(title, body, key)
    } catch {
      // The app's own Alerts couldn't be reached: the plugin shows it (an alert under a tag still showing is silent).
      await LocalNotifications.schedule({
        notifications: [{ id: notificationId(key), title, body, channelId: ALERTS, autoCancel: true, isExactNotification: false }],
      })
    }
  },
}
