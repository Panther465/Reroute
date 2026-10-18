import type { ReactNode } from 'react'

export type TagTone = 'ink' | 'green-outline' | 'grey-outline' | 'green' | 'blue' | 'red' | 'yellow' | 'sunken'

const tones: Record<TagTone, string> = {
  ink: 'bg-ink text-on-ink',
  'green-outline': 'border border-green text-green-ink',
  'grey-outline': 'border border-line-strong text-ink-2',
  green: 'bg-green-tint text-green-ink',
  blue: 'bg-blue-tint text-blue',
  red: 'bg-red-tint text-red-ink',
  yellow: 'bg-yellow text-on-yellow',
  sunken: 'bg-sunken text-ink-2',
}

export function Tag({ tone = 'grey-outline', icon, children, className = '' }: { tone?: TagTone; icon?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <span className={`inline-flex min-h-6 items-center gap-1 rounded-tag px-2 py-0.5 t-caption ${tones[tone]} ${className}`}>
      {icon}
      {children}
    </span>
  )
}
