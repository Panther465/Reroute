import { useSyncExternalStore } from 'react'
import { speakingNow, subscribe, type Speaking } from './channel'

/** What Roo is saying right now (null when quiet), for faces and "Talking…". */
export function useSpeaking(): Speaking | null {
  return useSyncExternalStore(subscribe, speakingNow, () => null)
}
