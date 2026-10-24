// Google sign-in and Calendar access in the Android app. Google refuses its sign-in inside an app's web
// view, so Android's own Google sign-in (Credential Manager, then Google's authorization screen for the
// scopes) gets the one-time code instead. The server exchanges it exactly as it does the web's.
import { SocialLogin } from '@capgo/capacitor-social-login'
import { GOOGLE_CLIENT_ID } from '@/lib/google'

/** Asked for anyway: sign-in itself. Only the extra scopes (Calendar) are passed on. */
const SIGN_IN_SCOPES = new Set(['openid', 'email', 'profile'])

let ready: Promise<void> | null = null

export async function googleCode(scope: string): Promise<string> {
  // 'offline': Android hands back a code for the server, not tokens for the app.
  ready ??= SocialLogin.initialize({ google: { webClientId: GOOGLE_CLIENT_ID, mode: 'offline' } }).catch((err: unknown) => {
    ready = null
    throw err
  })
  try {
    await ready
    const scopes = scope.split(/\s+/).filter((s) => s && !SIGN_IN_SCOPES.has(s))
    const res = await SocialLogin.login({ provider: 'google', options: { scopes } })
    const code = 'serverAuthCode' in res.result ? res.result.serverAuthCode : ''
    if (!code) throw new Error('no code')
    return code
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err)
    if (/cancel/i.test(text)) throw new Error('The Google window closed before signing in.')
    if (/denied|access_denied/i.test(text)) throw new Error('Google access was not allowed.')
    throw new Error("Google didn't finish signing in.")
  }
}
