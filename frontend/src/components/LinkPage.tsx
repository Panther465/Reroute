import { useEffect, useRef, type ReactNode } from 'react'
import { Link } from 'react-router'
import { RouteMark } from '@/components/icons'
import { ThemeToggle } from '@/components/ThemeToggle'
import { useDocumentTitle } from '@/lib/hooks'

/** The token from a link we emailed (`/reset-password#token=…`): it travels after the #, which browsers never
 *  send to a server or pass on as a Referer. Taken out of the address bar once read. */
export function useLinkToken(): string | null {
  const token = useRef<string | null>(null)
  if (token.current === null && typeof window !== 'undefined') {
    const match = /(?:^|[#&])token=([A-Za-z0-9_-]{20,128})/.exec(window.location.hash)
    token.current = match ? match[1] : ''
  }
  useEffect(() => {
    if (window.location.hash) window.history.replaceState(window.history.state, '', window.location.pathname)
  }, [])
  return token.current || null
}

/** A page opened from an email: the mark, one heading and a card, signed in or not. */
export function LinkPage({ title, children }: { title: string; children: ReactNode }) {
  useDocumentTitle(title)
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => heading.current?.focus(), [])
  return (
    <div className="flex min-h-dvh flex-col bg-ground text-ink">
      <header className="mx-auto flex w-full max-w-[28rem] items-center justify-between px-5 py-2">
        <Link to="/" aria-label="Reroute, home" className="-ml-1 flex min-h-12 items-center gap-2 rounded-control px-1">
          <RouteMark size={28} />
          <span className="font-display text-[length:calc(1.5rem*var(--grow-display))] font-extrabold leading-none text-ink [font-stretch:75%]">Reroute</span>
        </Link>
        <ThemeToggle />
      </header>
      <main className="mx-auto w-full max-w-[28rem] flex-1 px-5 pb-12 pt-6">
        <h1 ref={heading} tabIndex={-1} className="t-display-1 text-ink focus:outline-none">
          {title}
        </h1>
        <div className="mt-5 rounded-card border border-line bg-surface p-5">{children}</div>
      </main>
    </div>
  )
}
