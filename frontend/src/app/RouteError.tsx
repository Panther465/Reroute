import { TriangleAlert } from 'lucide-react'
import { useEffect } from 'react'
import { useRouteError } from 'react-router'
import { RouteMark } from '@/components/icons'
import { T } from '@/lib/i18n'
import { isChunkError, reloadOnce } from '@/lib/reload'

/**
 * What a screen shows when it crashes: a calm line and a way out. `full` is the page-level version
 * (outside the app shell). Details stay out of production; in development they help debugging.
 */
export function RouteError({ full = false }: { full?: boolean }) {
  const error = useRouteError()
  const stale = isChunkError(error)
  useEffect(() => {
    document.title = 'Something went wrong, Reroute'
    // A chunk from an older deploy: reload once to get the new one.
    if (stale) reloadOnce()
  }, [stale])

  const body = (
    <div role="alert" className="mx-auto max-w-[560px] px-5 pt-10">
      <TriangleAlert size={24} strokeWidth={1.75} aria-hidden="true" className="text-red-ink" />
      <h1 tabIndex={-1} className="mt-3 t-display-2 text-ink">
        <T k="Something went wrong on this screen." />
      </h1>
      <p className="measure mt-2 t-body text-ink-2">Reload to try again. Your plan is saved on this phone.</p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="mt-6 inline-flex min-h-[52px] items-center justify-center rounded-control bg-green px-5 t-title text-on-green [@media(hover:hover)]:hover:bg-green-ink"
      >
        <T k="Reload" />
      </button>
      {import.meta.env.DEV && error instanceof Error && <pre className="mt-6 overflow-x-auto whitespace-pre-wrap t-small text-muted">{error.stack ?? error.message}</pre>}
    </div>
  )

  if (!full) return body
  return (
    <div className="min-h-dvh bg-ground text-ink">
      <p className="mx-auto flex max-w-[560px] items-center gap-2 px-5 pt-6 t-small text-muted">
        <RouteMark size={20} />
        Reroute
      </p>
      {body}
    </div>
  )
}
