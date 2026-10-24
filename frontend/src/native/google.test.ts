import { beforeEach, describe, expect, it, vi } from 'vitest'

const social = vi.hoisted(() => ({ initialize: vi.fn(async () => {}), login: vi.fn() }))
vi.mock('@capgo/capacitor-social-login', () => ({ SocialLogin: social }))
vi.mock('@/lib/google', () => ({ GOOGLE_CLIENT_ID: 'web-client.apps.googleusercontent.com' }))

import { googleCode } from './google'

beforeEach(() => vi.clearAllMocks())

describe('Google in the app', () => {
  it("signs in with Android's Google sign-in and returns the one-time code for the server", async () => {
    social.login.mockResolvedValue({ provider: 'google', result: { serverAuthCode: '4/0Abc', responseType: 'offline' } })
    await expect(googleCode('openid email profile')).resolves.toBe('4/0Abc')
    expect(social.initialize).toHaveBeenCalledWith({ google: { webClientId: 'web-client.apps.googleusercontent.com', mode: 'offline' } })
    expect(social.login).toHaveBeenCalledWith({ provider: 'google', options: { scopes: [] } })
  })

  it('asks for Calendar access when importing appointments, and sets up only once', async () => {
    social.login.mockResolvedValue({ provider: 'google', result: { serverAuthCode: '4/0Cal', responseType: 'offline' } })
    await googleCode('openid email profile https://www.googleapis.com/auth/calendar.readonly')
    expect(social.login).toHaveBeenLastCalledWith({ provider: 'google', options: { scopes: ['https://www.googleapis.com/auth/calendar.readonly'] } })
    expect(social.initialize).not.toHaveBeenCalled()
  })

  it("says what happened in the web's words", async () => {
    social.login.mockRejectedValueOnce(new Error('User cancelled the selector'))
    await expect(googleCode('openid')).rejects.toThrow('The Google window closed before signing in.')
    social.login.mockRejectedValueOnce(new Error('[16] Account reauth failed'))
    await expect(googleCode('openid')).rejects.toThrow("Google didn't finish signing in.")
    social.login.mockResolvedValueOnce({ provider: 'google', result: { idToken: 'x', responseType: 'online' } })
    await expect(googleCode('openid')).rejects.toThrow("Google didn't finish signing in.")
  })
})
