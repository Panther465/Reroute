// After a deploy, an open tab may ask for a code chunk that no longer exists. Reload once to pick up
// the new build; the timestamp guard stops a reload loop if the chunk is missing for another reason.
const KEY = 'reroute:chunk-reload'
const WINDOW_MS = 60_000

/** Reload the page unless this tab already did so in the last minute. Returns whether it reloads. */
export function reloadOnce(): boolean {
  try {
    const last = Number(sessionStorage.getItem(KEY) ?? 0)
    if (Date.now() - last < WINDOW_MS) return false
    sessionStorage.setItem(KEY, String(Date.now()))
  } catch {
    return false
  }
  window.location.reload()
  return true
}

/** A failed dynamic import: the chunk is gone (new deploy) or the network dropped mid-load. */
export function isChunkError(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err ?? '')
  return /dynamically imported module|Importing a module script failed|error loading dynamically imported|Unable to preload CSS|Failed to fetch dynamically/i.test(msg)
}

/** Vite fires vite:preloadError when a chunk fails to load. */
export function handleStaleChunks() {
  window.addEventListener('vite:preloadError', (event) => {
    if (reloadOnce()) event.preventDefault()
  })
}
