import {
  Banknote,
  Briefcase,
  Building,
  Clapperboard,
  Coffee,
  Dumbbell,
  FileText,
  GraduationCap,
  Hospital,
  Hotel,
  Landmark,
  Mail,
  MapPin,
  Plane,
  Scissors,
  ShoppingBag,
  TrainFront,
  Trees,
  UtensilsCrossed,
  type LucideIcon,
} from 'lucide-react'

// A stop's icon, guessed from its title. Decorative: always render it aria-hidden (the title says it).
const RULES: [RegExp, LucideIcon][] = [
  [/\b(train|station|railway|rail)\b/i, TrainFront],
  [/\b(flight|airport)\b/i, Plane],
  [/\b(bank|atm|cash)\b/i, Banknote],
  // The meal says more than who it's with: "Dinner with a client" is a dinner.
  [/\b(lunch|dinner|breakfast|eat|restaurant|food)\b/i, UtensilsCrossed],
  [/\b(coffee|cafe|café|tea|chai)\b/i, Coffee],
  [/\b(meet|meeting|call|client|interview|presentation)\b/i, Briefcase],
  [/\b(university|college|campus|class|lecture|exam)\b/i, GraduationCap],
  [/\b(office|work|admin)\b/i, Building],
  [/\b(grocer(y|ies)|shop|shopping|market|mall|buy)\b/i, ShoppingBag],
  [/\b(doctor|hospital|clinic|pharmacy|medicine)\b/i, Hospital],
  [/\b(gym|workout|yoga)\b/i, Dumbbell],
  [/\b(temple|church|mosque|gurudwara)\b/i, Landmark],
  [/\b(park|walk|garden)\b/i, Trees],
  [/\b(post|courier|parcel)\b/i, Mail],
  [/\b(document|form|passport|visa|submit)\b/i, FileText],
  [/\b(movie|cinema|film)\b/i, Clapperboard],
  [/\b(salon|haircut|barber)\b/i, Scissors],
  [/\b(hotel|stay|hostel|home)\b/i, Hotel],
]

export function stopIcon(title: string, kind: 'start' | 'task' | 'end' = 'task'): LucideIcon {
  if (kind !== 'task') return Hotel
  return RULES.find(([re]) => re.test(title))?.[1] ?? MapPin
}

export function StopIcon({ title, kind = 'task', size = 20, className }: { title: string; kind?: 'start' | 'task' | 'end'; size?: number; className?: string }) {
  const Icon = stopIcon(title, kind)
  return <Icon size={size} strokeWidth={1.75} aria-hidden="true" className={className} />
}
