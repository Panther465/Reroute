import { afterEach, describe, expect, it, vi } from 'vitest'

const KEY = 'reroute:prefs:v2'

/** The store as the next page load finds it, with `saved` left in storage. */
async function loadWith(saved: object) {
  localStorage.setItem(KEY, JSON.stringify(saved))
  vi.resetModules()
  return import('./store')
}

afterEach(() => localStorage.clear())

describe('saved settings', () => {
  it('gives Rico its own voice, Ana, where the old default was saved, once', async () => {
    const store = await loadWith({ alerts: { voiceId: 'en-IN-NeerjaNeural' } })
    expect(store.getState().alerts.voiceId).toBe('en-US-AnaNeural')
    // Neerja picked again afterwards stays.
    store.setState((s) => ({ alerts: { ...s.alerts, voiceId: 'en-IN-NeerjaNeural' } }))
    const again = await loadWith(JSON.parse(localStorage.getItem(KEY)!))
    expect(again.getState().alerts.voiceId).toBe('en-IN-NeerjaNeural')
    // Any other voice was a choice, and stays.
    expect((await loadWith({ alerts: { voiceId: 'en-GB-SoniaNeural' } })).getState().alerts.voiceId).toBe('en-GB-SoniaNeural')
    expect((await loadWith({})).getState().alerts.voiceId).toBe('en-US-AnaNeural')
  })
})
