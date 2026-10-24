// Makes Roo's stills (src/components/roo3d/stills/roo-<mood>-<size>.webp): the pictures of the 3D Roo shown
// wherever a live one isn't drawn (beside each line in the chat, on devices that don't draw 3D well or with
// reduced motion, and while the live one loads). The 3D engine draws them itself (stills.html), standing still in
// each mood, so they match the live Roo. Run it again after re-rendering the pieces (render_roo.py):
//   cd frontend && node roo3d/stills.mjs

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { createServer } from 'vite'

const frontend = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(frontend, 'src/components/roo3d/stills')
/** Small for the little Roos (sharp up to about 50 CSS pixels wide on a 3x phone), large for the big ones. */
const SIZES = [192, 640]
const QUALITY = 0.9

const server = await createServer({ root: frontend, logLevel: 'error', server: { host: '127.0.0.1', port: 5199 } })
await server.listen()
// Software WebGL, as in CI: the same pixels on any machine.
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
try {
  const page = await browser.newPage()
  page.on('pageerror', (e) => console.error(e))
  await page.goto(new URL('roo3d/stills.html', server.resolvedUrls.local[0]).href)
  const stills = await page.evaluate(([sizes, quality]) => window.stills(sizes, quality), [SIZES, QUALITY])
  mkdirSync(out, { recursive: true })
  for (const [name, url] of Object.entries(stills)) {
    const bytes = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64')
    writeFileSync(join(out, `roo-${name}.webp`), bytes)
    console.log(`roo-${name}.webp  ${(bytes.length / 1024).toFixed(1)} KB`)
  }
} finally {
  await browser.close()
  await server.close()
}
