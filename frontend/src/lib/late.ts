import { createContext, useContext } from 'react'

/** Open the Running late sheet: with a delay already picked, or to choose from options the server offered. */
type OpenLate = (delay?: number | null, mode?: 'late' | 'options') => void
export const LateContext = createContext<OpenLate>(() => {})
export const useOpenLate = () => useContext(LateContext)
