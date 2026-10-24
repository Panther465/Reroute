import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ post: vi.fn(async () => ({ deviceId: 'x' })), delete: vi.fn(async () => undefined) }))
vi.mock('@/api/client', async (actual) => ({ ApiError: (await actual<typeof import('@/api/client')>()).ApiError, api }))
const notify = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('./live', () => ({ canNotify: () => true, notify }))

import { ApiError } from '@/api/client'
import { raise } from './alerts'
import { native } from './platform'
import { deviceId, dropPush, forgetPush, retryPush, seenAlert, showPushed, syncPush } from './push'
import { getState, setState } from './store'

const TOKEN = 'firebase-token-for-this-phone'
const firebase = { token: vi.fn(async (): Promise<string | null> => TOKEN), forget: vi.fn(async () => true) }
const offline = () => new ApiError(0, 'OFFLINE', 'No connection.')

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  native.push = firebase
})

afterEach(async () => {
  // Each test starts with no phone registered in this run.
  api.delete.mockResolvedValue(undefined)
  await dropPush().catch(() => {})
  delete native.push
  delete native.session
  setState({ leaveNow: null, leaveAlerts: false, pushReady: false })
})

describe('alerts as push notifications', () => {
  it('names the phone by the SHA-256 of its token', async () => {
    expect(await deviceId('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('registers the phone while alerts are on, and says so once the server has it', async () => {
    await syncPush(true)
    expect(api.post).toHaveBeenCalledWith('/v1/me/push-devices', { token: TOKEN, platform: 'android' })
    expect(getState().pushReady).toBe(true)
    // Asked again (the signal came back): the server has this token already.
    await syncPush(true)
    expect(api.post).toHaveBeenCalledTimes(1)
  })

  it('does nothing in a browser, or in a build without Firebase', async () => {
    delete native.push
    await syncPush(true)
    native.push = { ...firebase, token: vi.fn(async () => null) }
    await syncPush(true)
    expect(api.post).not.toHaveBeenCalled()
    expect(getState().pushReady).toBe(false)
  })

  it('takes the phone off with alerts off, and asks Firebase for a new token', async () => {
    await syncPush(true)
    await syncPush(false)
    expect(api.delete).toHaveBeenCalledWith(`/v1/me/push-devices/${await deviceId(TOKEN)}`, { noRefresh: false })
    expect(firebase.forget).toHaveBeenCalled()
    expect(getState().pushReady).toBe(false)
    // Off again: nothing more to take off.
    await syncPush(false)
    expect(api.delete).toHaveBeenCalledTimes(1)
  })

  it('takes off a phone an earlier start registered, after the app was closed', async () => {
    localStorage.setItem('reroute:push-registered', TOKEN)
    await syncPush(false)
    expect(api.delete).toHaveBeenCalledWith(`/v1/me/push-devices/${await deviceId(TOKEN)}`, { noRefresh: false })
    expect(firebase.token).not.toHaveBeenCalled()
  })

  it('tries a registration again when the app comes back, after it failed for want of signal', async () => {
    api.post.mockRejectedValueOnce(offline())
    await expect(syncPush(true)).rejects.toThrow()
    expect(getState().pushReady).toBe(false)
    await retryPush()
    expect(api.post).toHaveBeenCalledTimes(2)
    expect(getState().pushReady).toBe(true)
    // Nothing failed since: nothing to try again.
    await retryPush()
    expect(api.post).toHaveBeenCalledTimes(2)
  })

  it('tries again when the phone could not be taken off, by the server or by Firebase', async () => {
    await syncPush(true)
    api.delete.mockRejectedValueOnce(offline())
    firebase.forget.mockResolvedValueOnce(false)
    await expect(syncPush(false)).rejects.toThrow()
    api.delete.mockRejectedValueOnce(new ApiError(503, 'UNAVAILABLE', 'Try again.'))
    firebase.forget.mockResolvedValueOnce(false)
    await expect(retryPush()).rejects.toThrow()
    await retryPush()
    expect(api.delete).toHaveBeenCalledTimes(3)
    // Taken off this time: nothing left to do.
    await syncPush(false)
    expect(api.delete).toHaveBeenCalledTimes(3)
  })

  it('counts a phone off once Firebase dropped its token, even with no session left to ask the server', async () => {
    await syncPush(true)
    api.delete.mockRejectedValueOnce(new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue.'))
    await syncPush(false)
    await syncPush(false)
    expect(api.delete).toHaveBeenCalledTimes(1)
  })

  it('keeps trying when neither the server nor Firebase could take the phone off', async () => {
    await syncPush(true)
    api.delete.mockRejectedValueOnce(new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue.'))
    firebase.forget.mockResolvedValueOnce(false)
    await expect(syncPush(false)).rejects.toThrow()
    expect(localStorage.getItem('reroute:push-registered')).toBe(TOKEN)
  })

  it('registers nothing with a server that sends no pushes, and does not keep trying', async () => {
    api.post.mockRejectedValueOnce(new ApiError(409, 'PUSH_OFF', "Push notifications aren't on for this server."))
    await syncPush(true)
    expect(getState().pushReady).toBe(false)
    expect(localStorage.getItem('reroute:push-registered')).toBeNull()
    await retryPush()
    expect(api.post).toHaveBeenCalledTimes(1)
  })

  it('asks Firebase again later when it could not make a token just now', async () => {
    firebase.token.mockRejectedValueOnce(new Error('no signal'))
    await expect(syncPush(true)).rejects.toThrow()
    await retryPush()
    expect(api.post).toHaveBeenCalledWith('/v1/me/push-devices', { token: TOKEN, platform: 'android' })
  })

  it('makes one change at a time, so alerts turned on and off quickly end up off', async () => {
    let answer!: () => void
    api.post.mockImplementationOnce(() => new Promise((resolve) => (answer = () => resolve({ deviceId: 'x' }))))
    const on = syncPush(true)
    const off = syncPush(false)
    await vi.waitFor(() => expect(api.post).toHaveBeenCalled())
    expect(api.delete).not.toHaveBeenCalled()
    answer()
    await Promise.all([on, off])
    expect(api.delete).toHaveBeenCalledTimes(1)
  })

  it('retries only the last change asked for, not an older one that failed', async () => {
    api.post.mockRejectedValueOnce(offline())
    const on = syncPush(true)
    const off = syncPush(false)
    await expect(on).rejects.toThrow()
    await off
    await retryPush()
    expect(api.post).toHaveBeenCalledTimes(1)
  })

  it('takes the old token off when Firebase has replaced it', async () => {
    await syncPush(true)
    firebase.token.mockResolvedValueOnce('a-newer-token-from-firebase')
    await syncPush(true)
    expect(api.delete).toHaveBeenCalledWith(`/v1/me/push-devices/${await deviceId(TOKEN)}`)
    expect(api.post).toHaveBeenLastCalledWith('/v1/me/push-devices', { token: 'a-newer-token-from-firebase', platform: 'android' })
  })

  it('signing out takes off a phone an earlier visit registered, without refreshing the session to ask', async () => {
    // Nothing registered: Firebase isn't asked for anything (no token made just to drop it).
    await dropPush(true)
    expect(firebase.token).not.toHaveBeenCalled()
    expect(firebase.forget).not.toHaveBeenCalled()
    localStorage.setItem('reroute:push-registered', TOKEN)
    await dropPush(true)
    expect(api.delete).toHaveBeenCalledWith(`/v1/me/push-devices/${await deviceId(TOKEN)}`, { noRefresh: true })
    expect(firebase.forget).toHaveBeenCalled()
  })

  it('signed out with no signal, drops the Firebase token once it can, so the last traveller gets nothing more here', async () => {
    await syncPush(true)
    api.delete.mockRejectedValueOnce(offline())
    firebase.forget.mockResolvedValueOnce(false)
    await expect(dropPush(true)).rejects.toThrow()
    // The next start, signed out: still no signal, then signal.
    firebase.forget.mockResolvedValueOnce(false)
    await expect(forgetPush()).rejects.toThrow()
    await forgetPush()
    expect(firebase.forget).toHaveBeenCalledTimes(3)
    // Done: nothing registered is left to forget.
    await forgetPush()
    expect(firebase.forget).toHaveBeenCalledTimes(3)
    expect(api.delete).toHaveBeenCalledTimes(1)
  })

  it('keeps the registration while the phone still keeps its sign-in (the server was only out of reach)', async () => {
    localStorage.setItem('reroute:push-registered', TOKEN)
    native.session = { load: async () => 'kept-refresh-token', save: async () => {}, clear: async () => {} }
    await forgetPush()
    expect(firebase.forget).not.toHaveBeenCalled()
    expect(localStorage.getItem('reroute:push-registered')).toBe(TOKEN)
  })
})

describe('the same alert from the live stream and from a push', () => {
  it('shows a pushed leave-by alert on screen as the live stream would, once', async () => {
    const alert = { kind: 'leave_now', body: 'Leave in 9 min. Metro.', tag: 'leave-71', tripId: 'trip-001', seq: '71' }
    await showPushed(alert)
    expect(getState().leaveNow).toMatchObject({ text: 'Leave in 9 min. Metro.', seq: 71 })
    // Dismissed, then the same alert again (from the live stream, or a late push): it stays dismissed.
    setState({ leaveNow: null })
    await showPushed(alert)
    expect(getState().leaveNow).toBeNull()
    expect(seenAlert('trip-001', 'leave-71', 'Leave in 9 min. Metro.')).toBe(true)
  })

  it('still shows "Leave now" after "Leave in 9 min": the two share a tag, not their words', async () => {
    await showPushed({ kind: 'leave_now', body: 'Leave in 9 min. Cab.', tag: 'leave-72', tripId: 'trip-001', seq: '72' })
    await showPushed({ kind: 'leave_now', body: 'Leave now. Cab.', tag: 'leave-72', tripId: 'trip-001', seq: '72' })
    expect(getState().leaveNow).toMatchObject({ text: 'Leave now. Cab.' })
  })

  it('counts two copies as one only for a while, and only within one trip', () => {
    const at = Date.now()
    expect(seenAlert('trip-001', 'leave-73', 'Leave now. Bus.', at)).toBe(false)
    expect(seenAlert('trip-002', 'leave-73', 'Leave now. Bus.', at)).toBe(false)
    expect(seenAlert('trip-001', 'leave-73', 'Leave now. Bus.', at + 60_000)).toBe(true)
    // A new plan's alert five minutes on (the server's next check), in the same words; or another day's.
    expect(seenAlert('trip-001', 'leave-73', 'Leave now. Bus.', at + 5 * 60_000)).toBe(false)
    expect(seenAlert('trip-001', 'leave-73', 'Leave now. Bus.', at + 24 * 3600_000)).toBe(false)
  })

  it("still shows the app's own phone notification: a server without Firebase sends no push", async () => {
    const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    setState({ leaveAlerts: true })
    await syncPush(true)
    raise({ key: 'morning-trip-001-9', title: 'Your day is planned.', tag: 'morning-trip-001-9' })
    expect(notify).toHaveBeenCalledWith('Reroute', expect.objectContaining({ body: 'Your day is planned.', tag: 'morning-trip-001-9' }))
    hidden.mockRestore()
  })
})
