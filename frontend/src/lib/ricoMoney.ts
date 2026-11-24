// Rico about the trip's money, from the Expenses tab: he pops up when the budget or one of the office's limits is
// crossed, and "Ask Rico" opens his chat with the question. His own code is locked (rico/README.md): a build
// without him has neither, and the tab works the same.
import { useEffect } from 'react'
import type { ExpenseBook } from '@/api/types'
import { hasRico } from './rico'
import { getState, setState } from './store'

type Money = typeof import('./roo/money')
const money = Object.values(import.meta.glob<Money>('./roo/money.ts', { eager: true }))[0] as Money | undefined

/** Rico can talk about money in this build. */
export const ricoKeepsMoney = hasRico && !!money

const SEEN = 'reroute:rico-money-seen'

function seen(): Set<string> {
  try {
    return new Set(JSON.parse(sessionStorage.getItem(SEEN) ?? '[]') as string[])
  } catch {
    return new Set()
  }
}

function remember(key: string) {
  try {
    sessionStorage.setItem(SEEN, JSON.stringify([...seen(), key].slice(-50)))
  } catch {
    /* private mode: he may speak up again next time */
  }
}

/** Rico speaks up, once a session for each, when the trip goes over its budget or a daily limit. */
export function useRicoMoneyNudge(book: ExpenseBook | undefined) {
  useEffect(() => {
    if (!ricoKeepsMoney || !book || !money) return
    const s = getState()
    // Not over something he's already saying, and not when he's put away.
    if (s.ricoBubble || s.rooChat || !s.ricoRoams) return
    const nudge = money.moneyNudge(book, seen())
    if (!nudge) return
    remember(nudge.key)
    setState({ ricoBubble: nudge.bubble })
  }, [book])
}

/** Open Rico's chat and ask him this, as the traveller. */
export function askRico(question: string) {
  setState({ rooChat: true, rooChatAsk: question })
}
