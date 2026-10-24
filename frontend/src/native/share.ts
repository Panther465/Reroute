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

/** `slip.txt`, then `slip (1).txt`, `slip (2).txt`…, as a browser names downloads. */
export function nthName(name: string, n: number): string {
  if (n === 0) return name
  const dot = name.lastIndexOf('.')
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`
}

/**
 * Saves to Documents/Reroute. A file of that name the app may not overwrite (one an earlier install saved) gets the
 * next name, as a browser's downloads do. Where Android won't allow Documents at all (Android 10 and older), the share
 * sheet offers Files or Drive.
 */
export async function saveText(name: string, text: string): Promise<string | null> {
  for (let n = 0; n < 5; n++) {
    try {
      await Filesystem.writeFile({ path: `Reroute/${nthName(name, n)}`, data: text, directory: Directory.Documents, encoding: Encoding.UTF8, recursive: true })
      return `Documents/Reroute/${nthName(name, n)}`
    } catch {
      /* taken by an earlier install, or no Documents here: the next name */
    }
  }
  try {
    const { uri } = await Filesystem.writeFile({ path: name, data: text, directory: Directory.Cache, encoding: Encoding.UTF8 })
    await Share.share({ files: [uri], dialogTitle: 'Save the expense slip' })
    return 'the place you picked'
  } catch {
    return null
  }
}
