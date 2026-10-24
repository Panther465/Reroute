import { beforeEach, describe, expect, it, vi } from 'vitest'

const plugin = vi.hoisted(() => ({
  checkPermissions: vi.fn(),
  requestPermissions: vi.fn(),
  createChannel: vi.fn(async () => {}),
  schedule: vi.fn(async () => ({ notifications: [] })),
}))
vi.mock('@capacitor/local-notifications', () => ({ LocalNotifications: plugin }))

import { notificationId, notifications, startNotifications } from './notifications'

type Scheduled = { notifications: Record<string, unknown>[] }

beforeEach(() => {
  vi.clearAllMocks()
  plugin.checkPermissions.mockResolvedValue({ display: 'granted' })
  plugin.requestPermissions.mockResolvedValue({ display: 'granted' })
})

describe('phone notifications in the app', () => {
  it('gives each tag one notification number, so a newer one replaces the older', () => {
    expect(notificationId('leave-3')).toBe(notificationId('leave-3'))
    expect(notificationId('leave-3')).not.toBe(notificationId('leave-4'))
    for (const tag of ['leave-1', 'arrive-2', 'x', '']) {
      const id = notificationId(tag)
      expect(Number.isInteger(id) && id > 0 && id <= 0x7fffffff).toBe(true)
    }
  })

  it('makes its channels and reads the permission when the app starts', async () => {
    await startNotifications()
    expect(plugin.createChannel).toHaveBeenCalledWith(expect.objectContaining({ id: 'alerts', importance: 4 }))
    expect(plugin.createChannel).toHaveBeenCalledWith(expect.objectContaining({ id: 'alerts-quiet', importance: 2 }))
    expect(notifications.granted()).toBe(true)
  })

  it('shows an alert, quietly when Rico already says it', async () => {
    await startNotifications()
    await notifications.show('Reroute', { body: 'Leave now. Cab to the bank.', tag: 'leave-2' })
    await notifications.show('Reroute', { body: 'You have arrived.', tag: 'arrive-2', silent: true })
    const [first, second] = plugin.schedule.mock.calls.map((c) => (c as unknown as [Scheduled])[0].notifications[0])
    expect(first).toMatchObject({ id: notificationId('leave-2'), title: 'Reroute', body: 'Leave now. Cab to the bank.', channelId: 'alerts' })
    expect(second).toMatchObject({ channelId: 'alerts-quiet' })
  })

  it('shows nothing without permission, and asks Android for it', async () => {
    plugin.checkPermissions.mockResolvedValue({ display: 'denied' })
    await startNotifications()
    await notifications.show('Reroute', { body: 'Leave now.' })
    expect(plugin.schedule).not.toHaveBeenCalled()
    plugin.requestPermissions.mockResolvedValue({ display: 'denied' })
    await expect(notifications.request()).resolves.toBe(false)
    plugin.requestPermissions.mockResolvedValue({ display: 'granted' })
    await expect(notifications.request()).resolves.toBe(true)
    expect(notifications.granted()).toBe(true)
  })
})
