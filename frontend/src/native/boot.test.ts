import { afterEach, describe, expect, it, vi } from 'vitest'

const started = vi.hoisted(() => ({ notifications: vi.fn(async () => {}), shell: vi.fn(async () => {}), push: vi.fn(async () => {}), wake: vi.fn(async (_onWake: () => void) => {}) }))
vi.mock('./push', () => ({ push: { token: vi.fn(), forget: vi.fn() }, startPush: started.push }))
vi.mock('./notifications', () => ({ notifications: { granted: () => false, refresh: vi.fn() }, startNotifications: started.notifications }))
vi.mock('./shell', () => ({ startShell: started.shell, systemBars: vi.fn() }))
vi.mock('./session', () => ({ session: { load: vi.fn(), save: vi.fn(), clear: vi.fn() } }))
vi.mock('./google', () => ({ googleCode: vi.fn() }))
vi.mock('./share', () => ({ shareText: vi.fn(), saveText: vi.fn() }))
vi.mock('./speech', () => ({ listenOnce: vi.fn(), phoneSay: vi.fn() }))
const bar = vi.hoisted(() => ({ on: false }))
vi.mock('./wake', () => ({ wake: { status: vi.fn(), openApp: vi.fn() }, startWake: started.wake, inBar: vi.fn(async () => bar.on) }))

import { native } from '@/lib/platform'
import { resetSession } from '@/lib/session'
import { getState, setState } from '@/lib/store'
import { boot } from './boot'

afterEach(() => {
  for (const k of Object.keys(native)) delete native[k as keyof typeof native]
})

describe('starting the app', () => {
  it("fills in every hook the web code checks, so none of the browser's gaps is left", async () => {
    await boot()
    expect(Object.keys(native).sort()).toEqual(['googleCode', 'listenOnce', 'notifications', 'phoneSay', 'push', 'saveText', 'session', 'shareText', 'systemBars', 'wake'])
    expect(started.notifications).toHaveBeenCalled()
    expect(started.shell).toHaveBeenCalled()
    expect(started.push).toHaveBeenCalled()
    expect(started.wake).toHaveBeenCalled()
  })

  it('"Hey Rico" brings Rico up talking, for whoever is signed in', async () => {
    await boot()
    const onWake = started.wake.mock.calls[0][0]
    resetSession('signedOut')
    onWake()
    expect(getState().ricoVoice).toBeNull()
    resetSession('signedIn')
    onWake()
    expect(getState().ricoVoice).toEqual({ from: 'wake' })
    setState({ ricoVoice: null })
  })

  it('over other apps, shows only him, big; from there, opens the app on what he showed, him carrying on', async () => {
    bar.on = true
    try {
      await boot()
      expect(getState().ricoBar).toBe(true)
      expect(document.documentElement.hasAttribute('data-rico-bar')).toBe(true)
      const onWake = started.wake.mock.calls.at(-1)![0] as (from?: { path?: string; said?: string }) => void
      resetSession('signedIn')
      // "Hey Rico" with Reroute closed: Rico big with his glow, not a bar.
      onWake()
      expect(getState()).toMatchObject({ ricoVoice: { from: 'wake' }, ricoVoiceMini: false })
      onWake({ path: '/leg/2', said: 'Traveller: show me the way' })
      expect(getState()).toMatchObject({ ricoVoice: { from: 'tap', carriedOn: 'Traveller: show me the way' }, ricoVoiceMini: true })
      expect(location.pathname).toBe('/leg/2')
      onWake({ path: 'rico', said: '' })
      expect(getState().ricoVoiceMini).toBe(false)
    } finally {
      bar.on = false
      document.documentElement.removeAttribute('data-rico-bar')
      setState({ ricoBar: false, ricoVoice: null, ricoVoiceMini: false })
      history.replaceState(null, '', '/')
    }
  })

  it('still starts when one piece fails', async () => {
    started.notifications.mockRejectedValueOnce(new Error('no channel'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(boot()).resolves.toBeUndefined()
    expect(native.session).toBeDefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
