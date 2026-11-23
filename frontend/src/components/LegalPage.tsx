import { ArrowUpRight } from 'lucide-react'
import { useEffect, useRef, type ReactNode } from 'react'
import { Link, useLocation, useNavigationType } from 'react-router'
import { RouteMark } from '@/components/icons'
import { ThemeToggle } from '@/components/ThemeToggle'
import { useDocumentTitle } from '@/lib/hooks'

const SOURCE = 'https://github.com/Panther465/Reroute'
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

export interface LegalSection {
  /** The section's anchor: the contents and other pages link to `#id`. */
  id: string
  title: string
  body: ReactNode
}

/** "2026-11-23" as "23 November 2026", the same in every locale. */
function longDate(iso: string) {
  const [y, m, d] = iso.split('-').map(Number)
  return `${d} ${MONTHS[m - 1]} ${y}`
}

/**
 * A public page of the rules (the privacy policy, the terms of use): one readable column with its contents at the
 * top, the sections as h2s, and a footer to the other page and the source. It works signed out.
 */
export function LegalPage({
  title,
  effective,
  lead,
  sections,
  other,
}: {
  title: string
  /** The day this version applies from, as YYYY-MM-DD. */
  effective: string
  lead: ReactNode
  sections: LegalSection[]
  /** The other legal page, for the footer. */
  other: { to: string; label: string }
}) {
  useDocumentTitle(title)
  const heading = useRef<HTMLHeadingElement>(null)
  const { pathname, hash } = useLocation()
  const navigation = useNavigationType()

  // These pages sit outside the app's shell, which scrolls and moves focus for its own screens. Arriving from
  // another page (a link, not a reload or Back) starts at the top with focus on the title; a link to one section
  // (/privacy#your-data) opens at that section, which a lazy page draws only after the browser has looked for it.
  useEffect(() => {
    const target = hash ? document.getElementById(decodeURIComponent(hash.slice(1))) : null
    if (target) target.scrollIntoView?.()
    else if (navigation !== 'POP') {
      if (window.scrollY > 0) window.scrollTo(0, 0)
      heading.current?.focus({ preventScroll: true })
    }
  }, [pathname, hash, navigation])

  return (
    <div className="flex min-h-dvh flex-col bg-ground text-ink">
      <header className="mx-auto flex w-full max-w-[42rem] items-center justify-between px-5 py-2">
        <Link to="/" aria-label="Reroute, home" className="-ml-1 flex min-h-12 items-center gap-2 rounded-control px-1">
          <RouteMark size={28} />
          <span className="font-display text-[length:calc(1.5rem*var(--grow-display))] font-extrabold leading-none text-ink [font-stretch:75%]">Reroute</span>
        </Link>
        <ThemeToggle />
      </header>

      <main id="main" className="mx-auto w-full max-w-[42rem] flex-1 break-words px-5 pb-16 pt-4">
        <h1 ref={heading} tabIndex={-1} className="t-display-1 text-ink">
          {title}
        </h1>
        <p className="mt-2 t-small text-muted">
          Effective <time dateTime={effective}>{longDate(effective)}</time>
        </p>
        <div className="mt-4 flex flex-col gap-3 t-body text-ink-2">{lead}</div>

        <nav aria-labelledby="contents-h" className="mt-8 rounded-card border border-line bg-surface px-2 pb-2 pt-4">
          <h2 id="contents-h" className="px-3 t-title text-ink">
            On this page
          </h2>
          <ul className="mt-1 sm:columns-2 sm:gap-x-2">
            {sections.map((s) => (
              <li key={s.id} className="break-inside-avoid">
                <a
                  href={`#${s.id}`}
                  className="flex min-h-12 items-center rounded-control px-3 py-1 t-body text-ink underline decoration-line-strong underline-offset-4 [@media(hover:hover)]:hover:bg-sunken [@media(hover:hover)]:hover:decoration-ink"
                >
                  {s.title}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        {sections.map((s) => (
          <section key={s.id} id={s.id} className="mt-12 scroll-mt-4">
            <h2 className="t-display-2 text-ink">{s.title}</h2>
            <div className="mt-3 flex flex-col gap-3 t-body text-ink-2">{s.body}</div>
          </section>
        ))}
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto max-w-[42rem] px-5 pb-8 pt-4">
          <nav aria-label="More about Reroute">
            <ul className="flex flex-wrap gap-x-6">
              <li>
                <Link to={other.to} className="inline-flex min-h-12 items-center t-body font-bold text-ink-2 underline decoration-line-strong decoration-2 underline-offset-4 [@media(hover:hover)]:hover:text-ink">
                  {other.label}
                </Link>
              </li>
              <li>
                <a href={SOURCE} className="inline-flex min-h-12 items-center gap-1 t-body font-bold text-ink-2 underline decoration-line-strong decoration-2 underline-offset-4 [@media(hover:hover)]:hover:text-ink">
                  Source code
                  <ArrowUpRight size={16} strokeWidth={2} aria-hidden="true" />
                </a>
              </li>
            </ul>
          </nav>
          <p className="mt-2 t-small text-muted">Reroute is a work-trip planner for Indian cities, made by the Reroute team as a student project.</p>
        </div>
      </footer>
    </div>
  )
}

/** A link inside the text: a section of this page (#id), another page of the app (/terms) or a website. */
export function TextLink({ to, children }: { to: string; children: ReactNode }) {
  const className = 'font-bold text-ink underline underline-offset-4'
  return to.startsWith('/') ? (
    <Link to={to} className={className}>
      {children}
    </Link>
  ) : (
    <a href={to} className={className}>
      {children}
    </a>
  )
}

/** A sub-heading inside a section. */
export function SubHeading({ children }: { children: ReactNode }) {
  return <h3 className="mt-4 t-title text-ink">{children}</h3>
}

/** A bulleted list in the body text. */
export function Bullets({ items }: { items: ReactNode[] }) {
  return (
    <ul className="flex list-disc flex-col gap-2 pl-5 marker:text-muted">
      {items.map((item, i) => (
        // The lists are fixed text: their order never changes.
        <li key={i}>{item}</li>
      ))}
    </ul>
  )
}

/** The words a bullet or paragraph starts with, in bold. */
export function Lead({ children }: { children: ReactNode }) {
  return <strong className="font-bold text-ink">{children}</strong>
}

/**
 * A table of the rules (what we keep, who sees what). The first cell of each row names it. On a narrow phone the
 * table scrolls sideways inside its own box, never the page; the box takes focus so a keyboard can scroll it too.
 */
export function LegalTable({ label, columns, widths, rows }: { label: string; columns: string[]; widths: string[]; rows: ReactNode[][] }) {
  return (
    <div>
      <p aria-hidden="true" className="mb-2 t-small text-muted sm:hidden">
        The table scrolls sideways.
      </p>
      <div role="region" aria-label={label} tabIndex={0} className="overflow-x-auto rounded-card border border-line bg-surface">
        <table className={`w-full table-fixed border-collapse text-left ${columns.length > 3 ? 'min-w-[38rem]' : 'min-w-[34rem]'}`}>
          <caption className="sr-only">{label}</caption>
          <colgroup>
            {widths.map((w, i) => (
              <col key={i} style={{ width: w }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c} scope="col" className="px-3 pb-2 pt-3 align-bottom t-caption text-ink-2">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(([name, ...cells], r) => (
              <tr key={r} className="border-t border-line">
                <th scope="row" className="px-3 py-3 align-top t-small font-bold text-ink">
                  {name}
                </th>
                {cells.map((cell, c) => (
                  <td key={c} className="px-3 py-3 align-top t-small text-ink-2">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** How to reach the team: the same on both pages. */
export function ContactUs() {
  return (
    <>
      <p>
        Reach the Reroute team through the project’s page on GitHub: <TextLink to={SOURCE}>github.com/Panther465/Reroute</TextLink>.
      </p>
      <p>Anything posted there is public, so please don’t include your email address or other personal details.</p>
    </>
  )
}
