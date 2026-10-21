import { Ban, Route, TriangleAlert, WifiOff } from 'lucide-react'
import type { ReactNode } from 'react'
import { T } from '@/lib/i18n'
import { Button } from './Button'

export function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden="true" data-skeleton="" className={`rounded-tag bg-line ${className}`} />
}

export function LoadingRegion({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">{label}</span>
      {children}
    </div>
  )
}

export function EmptyState({ title, body, action, illustration }: { title: string; body: string; action?: ReactNode; illustration?: ReactNode }) {
  return (
    <div className="py-10">
      {illustration && <div className="mb-5">{illustration}</div>}
      <h2 className="t-display-2 text-ink">{title}</h2>
      <p className="measure mt-2 t-body text-ink-2">{body}</p>
      {action && <div className="mt-6">{action}</div>}
    </div>
  )
}

export function ErrorState({ message, onRetry }: { message: ReactNode; onRetry: () => void }) {
  return (
    <div role="alert" className="rounded-card border border-line bg-surface p-5">
      <p className="flex items-start gap-3 t-body text-ink">
        <TriangleAlert size={20} strokeWidth={1.75} aria-hidden="true" className="mt-0.5 shrink-0 text-red-ink" />
        <span>{message}</span>
      </p>
      <Button variant="secondary" size="md" className="mt-4" onClick={onRetry}>
        <T k="Try again" />
      </Button>
    </div>
  )
}

export function Banner({ tone, children, action }: { tone: 'offline' | 'auto' | 'blocked' | 'info'; children: ReactNode; action?: ReactNode }) {
  const map = {
    offline: { cls: 'bg-sunken text-ink', Icon: WifiOff },
    auto: { cls: 'bg-green-tint text-green-ink', Icon: Route },
    blocked: { cls: 'bg-red-tint text-red-ink', Icon: Ban },
    info: { cls: 'bg-sunken text-ink', Icon: TriangleAlert },
  }[tone]
  const { Icon } = map
  return (
    <div role={tone === 'blocked' ? 'alert' : 'status'} className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-card px-4 py-3 ${map.cls}`}>
      <Icon size={20} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
      <p className="min-w-0 flex-1 t-small font-bold">{children}</p>
      {action}
    </div>
  )
}
