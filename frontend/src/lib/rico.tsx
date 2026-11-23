// Rico's own code (his screens and chat, his 3D, his voice) is locked in frontend/rico/rico.pack and written back by
// `node rico/lock.mjs unlock` (rico/README.md). Without RICO_KEY those files aren't here and the app runs without
// him: everything of Rico's that the rest of the app uses comes through here (and ricoAlerts.ts, ricoSettings.ts,
// split so each piece loads with the same screen as before), with a plain stand-in when he's missing.
import { lazy, type ComponentType } from 'react'
import { Navigate } from 'react-router'

// Rico's components take what their callers give them; their own types stay with them.
type Props = Record<string, unknown>

// His face loads with the app, as its plain import did.
const face = import.meta.glob<Record<string, unknown>>('../components/roo3d/RooAvatar.tsx', { eager: true })
// The rest loads the first time it's shown.
const later = import.meta.glob<Record<string, unknown>>([
  '../components/Roo.tsx',
  '../components/roo/RooChat.tsx',
  '../components/roo/RicoVoice.tsx',
  '../components/roo/RicoPal.tsx',
  '../screens/Welcome.tsx',
  './roo/sounds.ts',
])

/** Whether this build has Rico (his files were unlocked before it was built). */
export const hasRico = Object.keys(face).length > 0

const Nothing = () => null

function shown(path: string, name: string): ComponentType<Props> {
  const load = later[path]
  if (!load) return Nothing
  return lazy(() => load().then((m) => ({ default: m[name] as ComponentType<Props> })))
}

export const RooAvatar = (Object.values(face)[0]?.RooAvatar ?? Nothing) as ComponentType<{
  mood: 'happy' | 'wave'
  size: number
  reduce: boolean
  quiet?: boolean
}>
export const Roo = shown('../components/Roo.tsx', 'Roo')
export const RooChat = shown('../components/roo/RooChat.tsx', 'RooChat')
export const RicoVoice = shown('../components/roo/RicoVoice.tsx', 'RicoVoice')
export const RicoPal = shown('../components/roo/RicoPal.tsx', 'RicoPal')

/** Meeting Rico after signing up; without him, the trip form on Plan. */
export const loadWelcome =
  (later['../screens/Welcome.tsx'] as (() => Promise<{ default: ComponentType }>) | undefined) ?? (async () => ({ default: SetItUpMyself }))

function SetItUpMyself() {
  return <Navigate to="/plan" state={{ newTrip: true }} replace />
}

export function ricoSound(kind: 'appear') {
  void later['./roo/sounds.ts']?.().then((m) => (m.ricoSound as (kind: 'appear') => void)(kind))
}
