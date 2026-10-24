import { beforeEach, describe, expect, it, vi } from 'vitest'

const plugin = vi.hoisted(() => ({
  checkPermissions: vi.fn(),
  requestPermissions: vi.fn(),
  createChannel: vi.fn(async () => {}),
  schedule: vi.fn(async () => ({ notifications: [] })),
}))
vi.mock('@capacitor/local-notifications', () => ({ LocalNotifications: plugin }))
const showAlert = vi.hoisted(() => vi.fn(async (_title: string, _body: string, _tag: string) => {}))
vi.mock('./push', () => ({ showAlert }))

import { notificationId, notifications, startNotifications } from './notifications'

type Scheduled = { notifications: Record<string, unknown>[] }

beforeEach(() => {
  vi.clearAllMocks()
  plugin.checkPermissions.mockResolvedValue({ display: 'granted' })
  plugin.requestPermissions.mockResolvedValue({ display: 'granted' })
  showAlert.mockResolvedValue(undefined)
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

  it('makes its channel and reads the permission when the app starts', async () => {
    await startNotifications()
    expect(plugin.createChannel).toHaveBeenCalledWith(expect.objectContaining({ id: 'alerts', importance: 4 }))
    expect(notifications.granted()).toBe(true)
  })

  it('shows each alert through the app’s own Alerts, as a push is shown, so the two copies show once', async () => {
    await startNotifications()
    await notifications.show('Reroute', { body: 'Leave now. Cab to the bank.', tag: 'leave-2' })
    await notifications.show('Reroute', { body: 'You have arrived.', silent: true })
    expect(showAlert).toHaveBeenNthCalledWith(1, 'Reroute', 'Leave now. Cab to the bank.', 'leave-2')
    // No tag: the words make one, as notificationId() does.
    expect(showAlert).toHaveBeenNthCalledWith(2, 'Reroute', 'You have arrived.', 'Reroute\nYou have arrived.')
    expect(plugin.schedule).not.toHaveBeenCalled()
  })

  it("falls back to the plugin, at once and never as an exact alarm (it would open Android's Alarms & reminders screen first)", async () => {
    await startNotifications()
    showAlert.mockRejectedValue(new Error('not implemented'))
    await notifications.show('Reroute', { body: 'Leave in 9 min.', tag: 'leave-1' })
    const [shown] = (plugin.schedule.mock.calls[0] as unknown as [Scheduled])[0].notifications
    expect(shown).toMatchObject({ id: notificationId('leave-1'), title: 'Reroute', body: 'Leave in 9 min.', channelId: 'alerts', isExactNotification: false })
    expect(shown).not.toHaveProperty('schedule')
  })

  it('shows nothing without permission, and asks Android for it', async () => {
    plugin.checkPermissions.mockResolvedValue({ display: 'denied' })
    await startNotifications()
    await notifications.show('Reroute', { body: 'Leave now.' })
    expect(showAlert).not.toHaveBeenCalled()
    expect(plugin.schedule).not.toHaveBeenCalled()
    plugin.requestPermissions.mockResolvedValue({ display: 'denied' })
    await expect(notifications.request()).resolves.toBe(false)
    plugin.requestPermissions.mockResolvedValue({ display: 'granted' })
    await expect(notifications.request()).resolves.toBe(true)
    expect(notifications.granted()).toBe(true)
  })
})
