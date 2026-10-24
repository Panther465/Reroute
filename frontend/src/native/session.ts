// The Android app's refresh token, kept in the Android Keystore (AES, in the app's own storage). A browser
// keeps the same token in an httpOnly cookie, which never reaches the app's origin.
import { SecureStoragePlugin } from 'capacitor-secure-storage-plugin'

const KEY = 'reroute.refresh-token'

export const session = {
  async load(): Promise<string | null> {
    try {
      return (await SecureStoragePlugin.get({ key: KEY })).value || null
    } catch {
      // Nothing kept (never signed in here), or the Keystore can't read it any more: sign in again.
      return null
    }
  },
  async save(token: string): Promise<void> {
    await SecureStoragePlugin.set({ key: KEY, value: token })
  },
  async clear(): Promise<void> {
    try {
      await SecureStoragePlugin.remove({ key: KEY })
    } catch {
      /* nothing was kept */
    }
  },
}
