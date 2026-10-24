// Phone notifications in the Android app, from Android itself (the web view has no Notification API).
// The same moments as on the web: an alert while Reroute is in the background, a leave-now from the
// live stream. A newer notification with the same tag replaces the older one, as on the web.
import { LocalNotifications } from '@capacitor/local-notifications'

const ALERTS = 'alerts'
/** For an alert Rico's chime or voice already says: no second sound. */
const QUIET = 'alerts-quiet'

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
    LocalNotifications.createChannel({ id: QUIET, name: 'Quiet alerts', description: 'The same alerts, without a sound, when Rico says them.', importance: 2, visibility: 1 }),
    refresh(),
  ])
}

export const notifications = {
  granted: () => granted,
  /** Turned on or off in Android's settings while the app was away. */
  refresh: () => refresh().catch(() => {}),
  async request(): Promise<boolean> {
    granted = (await LocalNotifications.requestPermissions()).display === 'granted'
    return granted
  },
  async show(title: string, { body = '', tag, silent = false }: { body?: string; tag?: string; silent?: boolean }): Promise<void> {
    if (!granted) return
    await LocalNotifications.schedule({
      notifications: [{ id: notificationId(tag ?? `${title}\n${body}`), title, body, channelId: silent ? QUIET : ALERTS, autoCancel: true }],
    })
  },
}
