// Small view types shared by components. API shapes come from src/api/types.ts (generated).
import type { Mode } from './timeline'

export type { Mode }

export interface Segment {
  mode: Mode
  minutes: number
}
