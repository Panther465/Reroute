// Google Identity Services, authorization code flow. The browser only ever gets a one-time code;
// the server exchanges it with the client secret. Hidden entirely when no client ID is configured.

export const GOOGLE_CLIENT_ID = (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) ?? ''
export const googleEnabled = GOOGLE_CLIENT_ID.length > 0

interface CodeClient {
  requestCode: () => void
}
interface GoogleOauth2 {
  initCodeClient: (cfg: { client_id: string; scope: string; ux_mode: 'popup'; callback: (r: { code?: string; error?: string }) => void; error_callback?: (e: { type: string }) => void }) => CodeClient
}
declare global {
  interface Window {
    google?: { accounts: { oauth2: GoogleOauth2 } }
  }
}

let loading: Promise<void> | null = null

function loadScript(): Promise<void> {
  loading ??= new Promise((resolve, reject) => {
    if (window.google?.accounts) return resolve()
    const s = document.createElement('script')
    s.src = 'https://accounts.google.com/gsi/client'
    s.async = true
    s.onload = () => resolve()
    s.onerror = () => {
      loading = null
      reject(new Error("Couldn't reach Google. Check your connection and try again."))
    }
    document.head.appendChild(s)
  })
  return loading
}

/** Ask Google for a one-time code. Sign-in asks for identity only; Calendar import adds read-only calendar access. */
export async function requestGoogleCode(scope = 'openid email profile'): Promise<string> {
  await loadScript()
  return new Promise((resolve, reject) => {
    const client = window.google!.accounts.oauth2.initCodeClient({
      client_id: GOOGLE_CLIENT_ID,
      scope,
      ux_mode: 'popup',
      callback: (r) => (r.code ? resolve(r.code) : reject(new Error(r.error === 'access_denied' ? 'Google access was not allowed.' : "Google didn't finish signing in."))),
      error_callback: () => reject(new Error('The Google window closed before signing in.')),
    })
    client.requestCode()
  })
}

export const CALENDAR_SCOPE = 'openid email profile https://www.googleapis.com/auth/calendar.readonly'
