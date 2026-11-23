// "Hey Rico" in Me (lib/rico.tsx says why it comes through here); nothing without him.
import type { ComponentType } from 'react'

const settings = Object.values(import.meta.glob<Record<string, unknown>>('../components/roo/HeyRicoSettings.tsx', { eager: true }))[0]

export const HeyRicoSettings = (settings?.HeyRicoSettings ?? (() => null)) as ComponentType
