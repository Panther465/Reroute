import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))

/** The folders and files src/index.css names for Tailwind with @source, from frontend/ (src/…). */
function sources() {
  const css = readFileSync(join(here, '../src/index.css'), 'utf8')
  return [...css.matchAll(/@source\s+['"]\.\/([^'"]+)['"]/g)].map((m) => `src/${m[1].replace(/\/$/, '')}`)
}

describe('Rico’s styles', () => {
  // His files are git-ignored, and Tailwind skips git-ignored files it isn't told about: every build from 23 November
  // 2026 drew his voice screen, chat, alerts and Welcome without their styles.
  it('names every file of his that draws something for Tailwind', () => {
    const drawn = readFileSync(join(here, 'files.txt'), 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('src/') && l.endsWith('.tsx') && !l.includes('.test.'))
    expect(drawn.length).toBeGreaterThan(0)
    const named = sources()
    const missed = drawn.filter((f) => !named.some((s) => f === s || f.startsWith(`${s}/`)))
    expect(missed).toEqual([])
  })
})
