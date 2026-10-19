// A share link's token is shown once, when the link is created. Keep it on this phone (by shareId)
// so the link can be shown again after a reload; drop it when the link is revoked or expires.
const PREFIX = 'reroute:share:'

export function saveShareToken(shareId: string, token: string) {
  try {
    localStorage.setItem(PREFIX + shareId, token)
  } catch {
    /* storage full or blocked: the link shows for this visit only */
  }
}

export function shareToken(shareId: string): string | undefined {
  try {
    return localStorage.getItem(PREFIX + shareId) ?? undefined
  } catch {
    return undefined
  }
}

export function forgetShareToken(shareId: string) {
  try {
    localStorage.removeItem(PREFIX + shareId)
  } catch {
    /* ignore */
  }
}

/** Forget every saved token (sign-out). */
export function clearShareTokens() {
  try {
    Object.keys(localStorage)
      .filter((k) => k.startsWith(PREFIX))
      .forEach((k) => localStorage.removeItem(k))
  } catch {
    /* ignore */
  }
}
