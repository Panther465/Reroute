import { lazy, Suspense, useState } from 'react'
import type { Mood } from '@/components/roo/mood'
import { useResolvedTheme } from '@/lib/theme'
import type { Framing } from './frame'
import { StillPicture } from './RooStill'
import { roo3dFailed, roo3dSupported } from './support'

const Roo3DView = lazy(() => import('./Roo3DView'))

/** Whether Roo will be drawn live here, so a wrapper can leave the hopping to it. */
export function useRoo3D(reduce: boolean): boolean {
  return !reduce && roo3dSupported()
}

/**
 * Roo in 3D: drawn live where the device does it well, and everywhere else its still (the same 3D Roo, drawn by
 * the same engine, standing still in this mood). The still shows at once and stays until the live Roo has drawn
 * its first frame, then they cross-fade (a CSS transition, so it settles at exactly 0 or 1). If the live Roo ever
 * fails, the still stays for the visit.
 */
export function RooAvatar({
  mood,
  size,
  reduce,
  hop = 0,
  framing = 'full',
  quiet = false,
}: {
  mood: Mood
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
  const live = want && ready
  return (
    <span className="relative inline-block align-bottom" style={{ width: size, height: Math.round(size * 1.1) }} data-roo3d={live ? 'ready' : want ? 'loading' : 'still'}>
      <StillPicture mood={mood} size={size} framing={framing} className={`transition-opacity duration-[180ms] ${live ? 'opacity-0' : 'opacity-100'}`} />
      {want && (
        <Suspense fallback={null}>
          <Roo3DView
            mood={mood}
            hop={hop}
            theme={theme}
            framing={framing}
            quiet={quiet}
            className={`absolute inset-0 block transition-opacity duration-[180ms] ${live ? 'opacity-100' : 'opacity-0'}`}
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
