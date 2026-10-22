// What a long first message says about a trip: "I'm new to bengluru, staying at the Ramson hotel, I reach
// at 9 am, then my college, and a quick meeting at 5 pm". Plain patterns, no server. The city is found by
// the server, which forgives spelling; this picks out the rest, so Roo asks only for what's missing.

export interface TaskHint {
  title: string
  /** HH:MM, when the message gave the task a time. */
  fixed?: string
}

export interface PlanHints {
  start?: 'today' | 'tomorrow'
  /** What to search for where they stay: "ramson hotel". */
  stay?: string
  tasks: TaskHint[]
}

const KINDS: [string, string][] = [
  ['meeting', 'Meeting'],
  ['interview', 'Interview'],
  ['college', 'College'],
  ['university', 'University'],
  ['school', 'School'],
  ['class', 'Class'],
  ['lecture', 'Lecture'],
  ['exam', 'Exam'],
  ['office', 'Office'],
  ['bank', 'Bank'],
  ['hospital', 'Hospital'],
  ['doctor', 'Doctor'],
  ['appointment', 'Appointment'],
  ['lunch', 'Lunch'],
  ['dinner', 'Dinner'],
  ['presentation', 'Presentation'],
  ['workshop', 'Workshop'],
  ['conference', 'Conference'],
  ['passport', 'Passport office'],
  ['shopping', 'Shopping'],
  ['temple', 'Temple'],
  ['gym', 'Gym'],
]

/** Edits between two words (swapping neighbours counts once). */
function edits(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)))
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
    }
  return d[a.length][b.length]
}

/** The kind of task a word names, forgiving slips: "meethinga" is a meeting. Short words must be exact. */
function kindOf(word: string): string | undefined {
  for (const [k, title] of KINDS) {
    if (word === k || word === `${k}s`) return title
    const n = Math.max(k.length, word.length)
    const limit = n <= 4 ? 0 : n <= 7 ? 1 : 2
    if (limit && word[0] === k[0] && Math.abs(word.length - k.length) <= limit && edits(word, k) <= limit) return title
  }
  return undefined
}

/** A time with am or pm, or with minutes: "5 pm", "9:30am", "17:00". "At 5" alone is too vague to fix. */
function timeIn(text: string): string | undefined {
  const m = /\b(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?=\W|$)/i.exec(text) ?? /\b(\d{1,2})[:.](\d{2})\b/.exec(text)
  if (!m) return undefined
  let h = Number(m[1])
  const min = Number(m[2] ?? 0)
  const ap = m[3]?.toLowerCase()[0]
  if (ap === 'p' && h < 12) h += 12
  if (ap === 'a' && h === 12) h = 0
  if (h > 23 || min > 59) return undefined
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
}

const STAY =
  /\b(?:stay(?:ing)?|liv(?:e|ing)|put(?:ting)? up|check(?:ing)? in(?:to)?|booked)\s+(?:in|at|into)\s+(?:the\s+|a\s+)?([a-z0-9'&.\- ]+?)(?=\s+(?:and|then|so|but|i|i'll|i'm|which|where|for|from|till|until|today|tomorrow|near|with|after)\b|[,;!?]|\.(?:\s|$)|$)/i

/** What a message says beyond the city: when, where they stay, and the tasks with any times. */
export function understandPlan(text: string): PlanHints {
  const t = text.toLowerCase()
  const hints: PlanHints = { tasks: [] }
  if (/\btomorrow\b/.test(t)) hints.start = 'tomorrow'
  else if (/\b(today|tonight|this (morning|afternoon|evening))\b/.test(t)) hints.start = 'today'
  const stay = STAY.exec(t)?.[1]?.trim()
  if (stay && stay.split(/\s+/).length <= 5) hints.stay = stay
  // One clause at a time, so a time belongs to the task it was said with.
  for (const clause of t.split(/[,;!?]|\.(?:\s|$)|\b(?:and then|then|also|and|after that|but|plus)\b/)) {
    const words = clause.match(/[a-z]+/g) ?? []
    const title = words.map(kindOf).find(Boolean)
    if (!title || hints.tasks.some((x) => x.title === title)) continue
    // "I reach at 9 am" is when they arrive, not a task's time.
    const time = /\b(reach|arrive|land|get there|check in)\b/.test(clause) ? undefined : timeIn(clause)
    hints.tasks.push(time ? { title, fixed: time } : { title })
  }
  return hints
}
