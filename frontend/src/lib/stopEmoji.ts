// A friendly marker for a stop, guessed from its title. Decorative: always render it aria-hidden.
const RULES: [RegExp, string][] = [
  [/\b(train|station|railway|rail)\b/i, '🚆'],
  [/\b(flight|airport)\b/i, '✈️'],
  [/\b(bank|atm|cash)\b/i, '🏦'],
  [/\b(meet|meeting|call|client|interview|presentation)\b/i, '💼'],
  [/\b(university|college|campus|class|lecture|exam)\b/i, '🎓'],
  [/\b(office|work|admin)\b/i, '🏢'],
  [/\b(lunch|dinner|breakfast|eat|restaurant|food)\b/i, '🍽️'],
  [/\b(coffee|cafe|café|tea|chai)\b/i, '☕'],
  [/\b(grocer(y|ies)|shop|shopping|market|mall|buy)\b/i, '🛍️'],
  [/\b(doctor|hospital|clinic|pharmacy|medicine)\b/i, '🏥'],
  [/\b(gym|workout|yoga)\b/i, '🏋️'],
  [/\b(temple|church|mosque|gurudwara)\b/i, '🛕'],
  [/\b(park|walk|garden)\b/i, '🌳'],
  [/\b(post|courier|parcel)\b/i, '📮'],
  [/\b(document|form|passport|visa|submit)\b/i, '📄'],
  [/\b(movie|cinema|film)\b/i, '🎬'],
  [/\b(salon|haircut|barber)\b/i, '💇'],
  [/\b(hotel|stay|hostel|home)\b/i, '🏨'],
]

export function stopEmoji(title: string, kind: 'start' | 'task' | 'end' = 'task') {
  if (kind !== 'task') return '🏨'
  return RULES.find(([re]) => re.test(title))?.[1] ?? '📍'
}
