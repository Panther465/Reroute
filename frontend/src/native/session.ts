// The Android app's refresh token, kept in the Android Keystore (AES, in the app's own storage). A browser
// keeps the same token in an httpOnly cookie, which never reaches the app's origin.
import { SecureStoragePlugin } from 'capacitor-secure-storage-plugin'

const KEY = 'reroute.refresh-token'

/** Whether a token is kept: asked first, since reading or removing a missing one is logged as an error. */
async function kept(): Promise<boolean> {
  return (await SecureStoragePlugin.keys()).value.includes(KEY)
}

export const session = {
  async load(): Promise<string | null> {
    try {
      if (!(await kept())) return null
      return (await SecureStoragePlugin.get({ key: KEY })).value || null
    } catch {
      // The Keystore can't read it any more (a restored phone): sign in again.
      return null
    }
  },
  async save(token: string): Promise<void> {
    await SecureStoragePlugin.set({ key: KEY, value: token })
  },
  async clear(): Promise<void> {
    try {
      if (await kept()) await SecureStoragePlugin.remove({ key: KEY })
    } catch {
      /* nothing to forget */
    }
  },
}
