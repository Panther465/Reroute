import {
  ArrowUp,
  ArrowUpLeft,
  ArrowUpRight,
  CornerLeftDown,
  CornerRightDown,
  CornerUpLeft,
  CornerUpRight,
  LogIn,
  LogOut,
  MapPin,
  Navigation,
  RotateCw,
  TrainFront,
  Undo2,
  type LucideIcon,
} from 'lucide-react'
import type { NavStep } from '@/lib/navigate'
import type { TurnIcon } from '@/lib/turns'

const ICONS: Record<TurnIcon, LucideIcon> = {
  depart: Navigation,
  straight: ArrowUp,
  left: CornerUpLeft,
  right: CornerUpRight,
  'slight-left': ArrowUpLeft,
  'slight-right': ArrowUpRight,
  'sharp-left': CornerLeftDown,
  'sharp-right': CornerRightDown,
  uturn: Undo2,
  // India drives on the left: roundabouts go clockwise.
  roundabout: RotateCw,
  arrive: MapPin,
  board: LogIn,
  alight: LogOut,
}

/** A turn-by-turn step's arrow: a turn, a roundabout, boarding a metro line, arriving. */
export function StepIcon({ step, size = 20 }: { step: NavStep; size?: number }) {
  const Icon = step.icon === 'board' && /\bLine\b/.test(step.text) ? TrainFront : ICONS[step.icon]
  return <Icon size={size} strokeWidth={2} aria-hidden="true" />
}
