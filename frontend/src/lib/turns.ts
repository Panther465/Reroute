// Turn-by-turn wording: a road step (OSRM's manoeuvres) or a ride's boarding and getting off, in plain
// English, with the arrow to show beside it.
import type { LegPath, PathSegment, PathStep } from '@/api/types'
import { lowerFirst } from './format'
import { distanceLabel } from './progress'

export type TurnIcon = 'depart' | 'straight' | 'left' | 'right' | 'slight-left' | 'slight-right' | 'sharp-left' | 'sharp-right' | 'uturn' | 'roundabout' | 'arrive' | 'board' | 'alight'

export interface Instruction {
  text: string
  icon: TurnIcon
}

const VEHICLE: Record<string, string> = { shared_auto: 'shared auto', e_rickshaw: 'e-rickshaw', tempo: 'tempo', cab: 'cab', metro: 'metro', walk: 'walk' }

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const onto = (name: string) => (name ? ` onto ${name}` : '')

function ordinal(n: number) {
  const tens = n % 100
  const suffix = tens >= 11 && tens <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'
  return `${n}${suffix}`
}

function turn(modifier: string): Instruction {
  switch (modifier) {
    case 'left':
      return { text: 'Turn left', icon: 'left' }
    case 'right':
      return { text: 'Turn right', icon: 'right' }
    case 'slight left':
      return { text: 'Bear left', icon: 'slight-left' }
    case 'slight right':
      return { text: 'Bear right', icon: 'slight-right' }
    case 'sharp left':
      return { text: 'Turn sharp left', icon: 'sharp-left' }
    case 'sharp right':
      return { text: 'Turn sharp right', icon: 'sharp-right' }
    case 'uturn':
      return { text: 'Make a U-turn', icon: 'uturn' }
    default:
      return { text: 'Go straight on', icon: 'straight' }
  }
}

/** One step in words. `to` names where its stretch ends, for "Arrive at…". */
export function instruction(step: PathStep, segment: PathSegment, to: string): Instruction {
  const name = step.name ?? ''
  const modifier = step.modifier ?? ''
  const t = turn(modifier)
  switch (step.kind) {
    case 'board':
      return segment.mode === 'metro'
        ? { text: `Take the ${step.line ?? 'metro'} from ${name} towards ${step.towards}, ${plural(step.stops ?? 0, 'stop')}`, icon: 'board' }
        : { text: `Board a ${VEHICLE[segment.mode] ?? 'ride'} at ${name} going towards ${step.towards}, ${plural(step.stops ?? 0, 'stop')}`, icon: 'board' }
    case 'alight':
      return { text: `Get off at ${name}`, icon: 'alight' }
    case 'depart':
      return { text: name ? `Head off along ${name}` : 'Head off', icon: 'depart' }
    case 'arrive':
      return { text: `Arrive at ${to}`, icon: 'arrive' }
    case 'turn':
      return { text: `${t.text}${onto(name)}`, icon: t.icon }
    case 'end of road':
      return { text: `At the end of the road, ${lowerFirst(t.text)}${onto(name)}`, icon: t.icon }
    case 'fork':
      return { text: `Keep ${modifier.includes('left') ? 'left' : 'right'} at the fork${onto(name)}`, icon: t.icon }
    case 'merge':
      return { text: `Merge${onto(name)}`, icon: t.icon }
    case 'on ramp':
      return { text: `Take the ramp${onto(name)}`, icon: t.icon }
    case 'off ramp':
      return { text: `Take the exit${onto(name)}`, icon: t.icon }
    case 'roundabout':
    case 'rotary':
      return { text: step.exit ? `At the roundabout, take the ${ordinal(step.exit)} exit${onto(name)}` : `Go round the roundabout${onto(name)}`, icon: 'roundabout' }
    case 'roundabout turn':
      return { text: `At the roundabout, ${lowerFirst(t.text)}${onto(name)}`, icon: 'roundabout' }
    case 'exit roundabout':
    case 'exit rotary':
      return { text: `Leave the roundabout${onto(name)}`, icon: 'roundabout' }
    case 'continue':
      // OSRM's "continue" with a bend in it is a gentle turn.
      if (modifier && modifier !== 'straight') return { text: `${t.text}${onto(name)}`, icon: t.icon }
      return { text: name ? `Carry on along ${name}` : 'Carry on straight', icon: 'straight' }
    default:
      return { text: name ? `Carry on along ${name}` : 'Carry on', icon: 'straight' }
  }
}

/** A stretch with no road known: one line that says so, rather than made-up turns. */
export function roughInstruction(segment: PathSegment, to: string): Instruction {
  const far = distanceLabel(segment.distanceM)
  return segment.mode === 'walk'
    ? { text: `Make your way to ${to}, about ${far}. There are no street directions for this stretch.`, icon: 'straight' }
    : { text: `Get to ${to}, about ${far}. There are no road directions for this stretch.`, icon: 'straight' }
}

/** Each stretch of a leg in a sentence (not every turn), for its written directions. */
export function legSummary(path: LegPath, to: string): string[] {
  return path.segments.map((s, i) => {
    const next = path.segments[i + 1]?.stops[0]?.name ?? to
    const far = distanceLabel(s.distanceM)
    const [board, alight] = [s.steps.find((x) => x.kind === 'board'), s.steps.find((x) => x.kind === 'alight')]
    if (board && alight && s.mode === 'metro')
      return `Take the ${board.line ?? 'metro'} from ${board.name} towards ${board.towards}, ${plural(board.stops ?? 0, 'stop')}, and get off at ${alight.name}.`
    if (board && alight) return `Board a ${VEHICLE[s.mode] ?? 'ride'} at ${board.name} going towards ${board.towards}, and get off at ${alight.name}, ${plural(board.stops ?? 0, 'stop')} on.`
    if (s.source === 'approximate') return `${s.mode === 'walk' ? 'Make your way' : 'Get'} to ${next}, about ${far}. There are no ${s.mode === 'walk' ? 'street' : 'road'} directions for this stretch.`
    if (s.mode === 'walk') return `Walk ${far} to ${next}.`
    return `Take a ${VEHICLE[s.mode] ?? 'ride'} to ${next}, about ${far}.`
  })
}
