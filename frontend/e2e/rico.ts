// Rico's code is locked in the repository (rico/README.md): a checkout without RICO_KEY builds the app without him,
// and the checks of Rico himself skip.
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const ricoHere = existsSync(fileURLToPath(new URL('../src/components/Roo.tsx', import.meta.url)))
export const ricoLocked = 'Rico is locked (no RICO_KEY): this build has no Rico'
