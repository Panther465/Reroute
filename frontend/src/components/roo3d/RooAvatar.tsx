import { lazy, Suspense, useState } from 'react'
import { RooArt, type Mood } from '@/components/roo/RooArt'
import { useResolvedTheme } from '@/lib/theme'
import type { Framing } from './engine'
import { roo3dFailed, roo3dSupported } from './support'

const Roo3DView = lazy(() => import('./Roo3DView'))

/** Whether Roo will be drawn in 3D here, so a wrapper can leave the hopping to it. */
export function useRoo3D(reduce: boolean): boolean {
  return !reduce && roo3dSupported()
}

/**
 * Roo, in 3D where the device does it well, flat everywhere else. The flat Roo shows at once and stays
 * until the 3D one has drawn its first frame, then they cross-fade (a CSS transition, so it settles at
 * exactly 0 or 1). If the 3D Roo ever fails, the flat one stays for the visit.
 */
export function RooAvatar({
  mood,
  look,
  size,
  reduce,
  hop = 0,
  framing = 'full',
  quiet = false,
}: {
  mood: Mood
  look?: { x: number; y: number }
  size: number
  reduce: boolean
  hop?: number
  framing?: Framing
  quiet?: boolean
}) {
  const theme = useResolvedTheme()
  const [failed, setFailed] = useState(false)
  const [ready, setReady] = useState(false)
  const want = useRoo3D(reduce) && !failed
  const shown3d = want && ready
  return (
    <span className="relative inline-block align-bottom" style={{ width: size, height: Math.round(size * 1.1) }} data-roo3d={shown3d ? 'ready' : want ? 'loading' : 'flat'}>
      <span className={`absolute inset-0 transition-opacity duration-[180ms] ${shown3d ? 'opacity-0' : 'opacity-100'}`}>
        <RooArt mood={mood} look={look} size={size} reduce={reduce} />
      </span>
      {want && (
        <Suspense fallback={null}>
          <Roo3DView
            mood={mood}
            hop={hop}
            theme={theme}
            framing={framing}
            quiet={quiet}
            className={`absolute inset-0 block transition-opacity duration-[180ms] ${shown3d ? 'opacity-100' : 'opacity-0'}`}
            onReady={() => setReady(true)}
            onFail={() => {
              roo3dFailed()
              setFailed(true)
            }}
          />
        </Suspense>
      )}
    </span>
  )
}
