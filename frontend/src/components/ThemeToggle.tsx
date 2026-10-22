import { Moon, Sun } from 'lucide-react'
import { switchTheme, useResolvedTheme } from '@/lib/theme'

const ICON = 'absolute transition-[opacity,rotate,scale] duration-[var(--dur-base)] ease-[var(--ease-out)] motion-reduce:transition-none'

/** Light or dark in one tap. The icon shows the theme in use; Me → Theme also offers System. */
export function ThemeToggle({ className = '' }: { className?: string }) {
  const dark = useResolvedTheme() === 'dark'
  return (
    <button
      type="button"
      aria-label="Dark mode"
      aria-pressed={dark}
      onClick={() => switchTheme(dark ? 'light' : 'dark')}
      className={`relative flex size-12 shrink-0 items-center justify-center rounded-control text-ink-2 transition-colors duration-[var(--dur-quick)] [@media(hover:hover)]:hover:bg-sunken [@media(hover:hover)]:hover:text-ink ${className}`}
    >
      <Sun size={22} strokeWidth={1.75} aria-hidden="true" className={`${ICON} ${dark ? '-rotate-90 scale-50 opacity-0' : 'rotate-0 scale-100 opacity-100'}`} />
      <Moon size={22} strokeWidth={1.75} aria-hidden="true" className={`${ICON} ${dark ? 'rotate-0 scale-100 opacity-100' : 'rotate-90 scale-50 opacity-0'}`} />
    </button>
  )
}
