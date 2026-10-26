import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findKey, listed, open, seal } from './lock.mjs'

const KEY = 'a1'.repeat(32)
const OTHER = 'b2'.repeat(32)

describe('Rico’s locked art', () => {
  it('opens with its key, file for file and byte for byte', () => {
    const files = new Map([
      ['roo3d/roo.blend', Buffer.from('a model')],
      ['src/components/roo3d/stills/roo-happy-192.webp', Buffer.alloc(3000, 7)],
    ])
    const back = open(seal(files, KEY), KEY)
    expect([...back.keys()]).toEqual([...files.keys()])
    for (const [name, data] of files) expect(back.get(name).equals(data)).toBe(true)
  })

  it('shows nothing to anyone without the key, and notices a pack that was changed', () => {
    const pack = seal(new Map([['roo3d/roo.blend', Buffer.from('a model of Rico')]]), KEY)
    expect(pack.includes(Buffer.from('Rico'))).toBe(false)
    expect(() => open(pack, OTHER)).toThrow(/doesn't open/)
    const changed = Buffer.from(pack)
    changed[changed.length - 1] ^= 1
    expect(() => open(changed, KEY)).toThrow(/doesn't open/)
  })

  it('locks the files its list names that are here, a star matching within one folder', () => {
    const root = mkdtempSync(join(tmpdir(), 'rico-'))
    mkdirSync(join(root, 'a'))
    mkdirSync(join(root, 'b'))
    for (const f of ['a/roo-x.webp', 'a/roo-y.webp', 'a/other.png', 'b/roo.blend']) writeFileSync(join(root, f), 'x')
    // A file not here (a fresh download has none of them) isn't listed, so it isn't taken for unlocked art.
    expect(listed(root, '# Rico\na/roo-*.webp\n\nb/roo.blend\nb/missing.py\nc/*.webp\n')).toEqual(['a/roo-x.webp', 'a/roo-y.webp', 'b/roo.blend'])
  })

  it('takes the key from the environment, else the nearest .env above; set but empty means none', () => {
    const root = mkdtempSync(join(tmpdir(), 'rico-'))
    const deep = join(root, 'worktree', 'frontend')
    mkdirSync(deep, { recursive: true })
    writeFileSync(join(root, '.env'), `GEMINI_API_KEY=x\nRICO_KEY=${OTHER}\n`)
    expect(findKey({}, deep)).toBe(OTHER)
    expect(findKey({ RICO_KEY: KEY }, deep)).toBe(KEY)
    expect(findKey({ RICO_KEY: '' }, deep)).toBeNull()
  })
})
