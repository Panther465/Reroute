// Test environment gaps in jsdom: matchMedia (the desktop and reduced-motion checks) and React Testing Library cleanup.
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList
}

afterEach(() => cleanup())
