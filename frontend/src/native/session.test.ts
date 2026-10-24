import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => {
  const kept = new Map<string, string>()
  return {
    kept,
    plugin: {
      get: vi.fn(async ({ key }: { key: string }) => {
        if (!kept.has(key)) throw new Error('Item with given key does not exist')
        return { value: kept.get(key)! }
      }),
      set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
        kept.set(key, value)
        return { value: true }
      }),
      remove: vi.fn(async ({ key }: { key: string }) => {
        if (!kept.delete(key)) throw new Error('Item with given key does not exist')
        return { value: true }
      }),
      keys: vi.fn(async () => ({ value: [...kept.keys()] })),
    },
  }
})
vi.mock('capacitor-secure-storage-plugin', () => ({ SecureStoragePlugin: store.plugin }))

import { session } from './session'

beforeEach(() => store.kept.clear())

describe("the app's refresh token", () => {
  it('is kept in the Keystore-backed storage, and forgotten', async () => {
    await expect(session.load()).resolves.toBeNull()
    await session.save('app-refresh-0000000000000001')
    await expect(session.load()).resolves.toBe('app-refresh-0000000000000001')
    await session.clear()
    await expect(session.load()).resolves.toBeNull()
    await expect(session.clear()).resolves.toBeUndefined()
  })

  it("reads as none when the Keystore can't decrypt it (a restored phone): sign in again", async () => {
    await session.save('app-refresh-0000000000000001')
    store.plugin.get.mockRejectedValueOnce(new Error('javax.crypto.AEADBadTagException'))
    await expect(session.load()).resolves.toBeNull()
  })

  it('never asks Android for a token it does not keep, since that is logged as an error', async () => {
    store.plugin.get.mockClear()
    store.plugin.remove.mockClear()
    await session.load()
    await session.clear()
    expect(store.plugin.get).not.toHaveBeenCalled()
    expect(store.plugin.remove).not.toHaveBeenCalled()
  })
})
