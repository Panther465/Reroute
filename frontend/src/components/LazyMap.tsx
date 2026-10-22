import { WifiOff } from 'lucide-react'
import { Component, lazy, Suspense, useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import { Skeleton } from '@/components/ui/States'
import { useOnline } from '@/lib/hooks'
import type MapCardImpl from './MapCard'

type MapProps = ComponentProps<typeof MapCardImpl>

// React.lazy keeps a failed import for good. MapLibre isn't precached (it is cached the first time a map
// opens), so offline before that the import fails: a failure makes a fresh lazy component for the next try.
const load = () => lazy(() => import('./MapCard'))
let MapCard = load()

/** What shows instead of a map: offline, or when the map's code couldn't load. */
export function MapUnavailable({ className = 'h-64' }: { className?: string }) {
  return (
    <div className={`flex flex-col justify-center rounded-card border border-line bg-surface p-5 ${className}`}>
      <WifiOff size={24} strokeWidth={1.75} aria-hidden="true" className="text-muted" />
      <p className="mt-3 t-title text-ink">The map needs a connection</p>
      <p className="mt-1 t-small text-ink-2">The written directions still work offline.</p>
    </div>
  )
}

class Boundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch() {
    MapCard = load()
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

/** A map that never takes its screen down: offline it shows a note, and a failed load retries once back online. */
export function LazyMap(props: MapProps) {
  const online = useOnline()
  const [attempt, setAttempt] = useState(0)
  const wasOnline = useRef(online)
  useEffect(() => {
    if (online && !wasOnline.current) setAttempt((a) => a + 1)
    wasOnline.current = online
  }, [online])
  const size = props.className ?? 'h-64'
  if (!online) return <MapUnavailable className={size} />
  return (
    <Boundary key={attempt} fallback={<MapUnavailable className={size} />}>
      <Suspense fallback={<Skeleton className={`w-full rounded-card ${size}`} />}>
        <MapCard {...props} />
      </Suspense>
    </Boundary>
  )
}
