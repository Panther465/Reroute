// Crash and error reports to Sentry, only in a build with VITE_SENTRY_DSN (docs/data-and-privacy.md says what goes).
// Without it nothing loads and nothing is sent. A report keeps the error, its stack, the screen's path and the
// browser or phone model: never a query string, the part after #, a share link's secret, or anything typed.
import type { Breadcrumb, ErrorEvent } from '@sentry/react'

const DSN = import.meta.env.VITE_SENTRY_DSN as string | undefined

let sentry: Promise<typeof import('@sentry/react')> | null = null

/** A URL without its query, its fragment (where an emailed link's token travels) or a share link's secret. */
export function cleanUrl(url: string): string {
  return url.split(/[?#]/, 1)[0].replace(/(\/(?:v1\/)?shared\/)[^/]+/, '$1***')
}

export function scrubEvent(event: ErrorEvent): ErrorEvent {
  if (event.request) {
    const { url } = event.request
    event.request = url ? { url: cleanUrl(url) } : {}
  }
  delete event.user
  return event
}

export function scrubCrumb(crumb: Breadcrumb): Breadcrumb | null {
  // What was typed, and what the app logged, can hold anything.
  if (crumb.category === 'console' || crumb.category === 'ui.input') return null
  const data = crumb.data
  if (data) for (const key of ['url', 'from', 'to'] as const) if (typeof data[key] === 'string') data[key] = cleanUrl(data[key])
  return crumb
}

/** Start reporting, once, when this build has a DSN. */
export function startMonitoring() {
  if (!DSN || sentry) return
  sentry = import('@sentry/react').then((Sentry) => {
    Sentry.init({
      dsn: DSN,
      environment: import.meta.env.MODE,
      release: import.meta.env.VITE_APP_VERSION as string | undefined,
      sendDefaultPii: false,
      tracesSampleRate: 0,
      beforeSend: scrubEvent,
      beforeBreadcrumb: scrubCrumb,
    })
    return Sentry
  })
}

/** Report an error a screen caught itself (the router's error view): uncaught ones are reported on their own. */
export function reportError(error: unknown) {
  void sentry?.then((Sentry) => Sentry.captureException(error))
}
