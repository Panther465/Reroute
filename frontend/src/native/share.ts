// Sharing and saving in the Android app: Android's share sheet (the web view has no navigator.share), and
// a file saved to Documents (a web view can't download).
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'

export async function shareText(text: string, title?: string): Promise<'shared' | 'cancelled' | 'failed'> {
  try {
    await Share.share({ text, title, dialogTitle: title })
    return 'shared'
  } catch (err) {
    return /cancel/i.test(err instanceof Error ? err.message : String(err)) ? 'cancelled' : 'failed'
  }
}

/** Saves to Documents/Reroute. Where Android won't allow that (Android 10 and older), the share sheet offers Files or Drive. */
export async function saveText(name: string, text: string): Promise<string | null> {
  try {
    await Filesystem.writeFile({ path: `Reroute/${name}`, data: text, directory: Directory.Documents, encoding: Encoding.UTF8, recursive: true })
    return `Documents/Reroute/${name}`
  } catch {
    try {
      const { uri } = await Filesystem.writeFile({ path: name, data: text, directory: Directory.Cache, encoding: Encoding.UTF8 })
      await Share.share({ files: [uri], dialogTitle: 'Save the expense slip' })
      return 'the place you picked'
    } catch {
      return null
    }
  }
}
