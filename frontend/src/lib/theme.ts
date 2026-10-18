import { useEffect } from 'react'
import { useMediaQuery } from './hooks'
import { useStore } from './store'

export function useResolvedTheme(): 'light' | 'dark' {
  const theme = useStore((s) => s.theme)
  const sysDark = useMediaQuery('(prefers-color-scheme: dark)')
  return theme === 'system' ? (sysDark ? 'dark' : 'light') : theme
}

/**
 * Applies the theme to <html>. The page language stays "en": Hindi strings carry lang="hi"
 * themselves, because most content (place names, plan text from the server) stays in English.
 */
export function useDocumentSettings() {
  const theme = useStore((s) => s.theme)
  const resolved = useResolvedTheme()
  useEffect(() => {
    const root = document.documentElement
    if (theme === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', theme)
    const meta = document.querySelector('meta[name="theme-color"]')
    meta?.setAttribute('content', resolved === 'dark' ? '#10161F' : '#EDF0EB')
  }, [theme, resolved])
}
