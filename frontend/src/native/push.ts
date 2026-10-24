// Push notifications in the Android app: Firebase Cloud Messaging through the app's own small plugin
// (android/app/src/main/java/com/reroute/app/RerouteMessagingPlugin.java). The server sends each alert as a
// data message, and RerouteMessagingService shows it with the number this app gives the same alert
// (notifications.ts), so the two replace each other. While the app is on screen it hands the alert to the
// page instead, which shows it as it shows the live stream's.
import { registerPlugin, type PluginListenerHandle } from '@capacitor/core'

export interface PushedAlert {
  kind: string
  title: string
  body: string
  tag: string
  tripId: string
  seq?: string
  /** A check-in's details (reason, leaveBy, extraMin…), as strings. */
  [detail: string]: string | undefined
}

interface RerouteMessaging {
  launchAlert(): Promise<{ alert?: PushedAlert }>
  token(): Promise<{ token: string }>
  forget(): Promise<void>
  show(alert: { title: string; body: string; tag: string }): Promise<void>
  addListener(event: 'alert', listener: (alert: PushedAlert) => void): Promise<PluginListenerHandle>
}

const Messaging = registerPlugin<RerouteMessaging>('RerouteMessaging')

export const push = {
  /**
   * This phone's Firebase token; null in a build without Firebase (no google-services.json). Throws when Firebase
   * couldn't make one just now (no signal, Google Play busy), so it's asked again later.
   */
  async token(): Promise<string | null> {
    try {
      return (await Messaging.token()).token || null
    } catch (err) {
      if ((err as { code?: string }).code === 'UNAVAILABLE') return null
      throw err
    }
  },
  /** A new token next time: Firebase stops delivering to this one. False when Firebase couldn't be reached. */
  forget: (): Promise<boolean> => Messaging.forget().then(
    () => true,
    () => false,
  ),
}

/**
 * Shows an alert as a phone notification through the app's own Alerts, as a push is shown: the same alert from
 * the live stream and from a push shows once. Works in every build, with or without Firebase.
 */
export function showAlert(title: string, body: string, tag: string): Promise<void> {
  return Messaging.show({ title, body, tag })
}

export async function startPush(onAlert: (alert: PushedAlert) => void) {
  await Messaging.addListener('alert', onAlert)
  // Opened by tapping a pushed alert: the page shows it as if it had come with the app open.
  const { alert } = await Messaging.launchAlert().catch(() => ({ alert: undefined }))
  if (alert) onAlert(alert)
}
