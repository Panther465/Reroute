import { beforeEach, describe, expect, it, vi } from 'vitest'

const plugin = vi.hoisted(() => ({ token: vi.fn(), forget: vi.fn(async () => {}), show: vi.fn(async () => {}), launchAlert: vi.fn(async (): Promise<{ alert?: unknown }> => ({})), addListener: vi.fn(async () => ({ remove: async () => {} })) }))
vi.mock('@capacitor/core', () => ({ registerPlugin: () => plugin }))

import { push, showAlert, startPush } from './push'

beforeEach(() => vi.clearAllMocks())

describe('push in the app', () => {
  it("hands over the phone's Firebase token", async () => {
    plugin.token.mockResolvedValue({ token: 'firebase-token' })
    await expect(push.token()).resolves.toBe('firebase-token')
  })

  it('has no token in a build without Firebase, and says so without failing', async () => {
    plugin.token.mockRejectedValue(Object.assign(new Error('Push isn’t set up in this build.'), { code: 'UNAVAILABLE' }))
    await expect(push.token()).resolves.toBeNull()
    // Firebase is there but couldn't answer just now: that's asked again, not taken as "no push".
    plugin.token.mockRejectedValueOnce(Object.assign(new Error('Firebase gave no token.'), { code: 'FAILED' }))
    await expect(push.token()).rejects.toThrow('Firebase gave no token.')
    plugin.forget.mockRejectedValue(new Error('not set up'))
    await expect(push.forget()).resolves.toBe(false)
  })

  it("shows the page's own alerts through the app's Alerts, in every build", async () => {
    await showAlert('Reroute', 'Leave now. Metro.', 'leave-1')
    expect(plugin.show).toHaveBeenCalledWith({ title: 'Reroute', body: 'Leave now. Metro.', tag: 'leave-1' })
  })

  it('hands the page the alert whose notification opened the app', async () => {
    const onAlert = vi.fn()
    plugin.launchAlert.mockResolvedValueOnce({ alert: { kind: 'nudge', tag: 'nudge-2', body: 'Hi, are you there? 👋' } })
    await startPush(onAlert)
    expect(onAlert).toHaveBeenCalledWith({ kind: 'nudge', tag: 'nudge-2', body: 'Hi, are you there? 👋' })
  })

  it('passes alerts that arrive while the app is on screen to the page', async () => {
    const onAlert = vi.fn()
    await startPush(onAlert)
    expect(plugin.addListener).toHaveBeenCalledWith('alert', onAlert)
  })
})
