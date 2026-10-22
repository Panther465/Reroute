// Check-ins made offline wait here with their idempotency keys and go out when the phone is back
// online. Idempotency makes the retry safe: the server answers a repeated key with the first result.
import { useSyncExternalStore } from 'react'
import { isSignedOutError } from '@/api/client'
import { keyIsSpent } from '@/lib/submitKey'

export interface QueuedCheckin {
  tripId: string
  taskId: string
  kind: 'done' | 'skipped' | 'delay'
  delayMin?: number
  idempotencyKey: string
  queuedAt: number
}

const KEY = 'reroute:checkin-queue'
const listeners = new Set<() => void>()
let cache: QueuedCheckin[] | null = null

function read(): QueuedCheckin[] {
  if (cache) return cache
  try {
    cache = JSON.parse(localStorage.getItem(KEY) ?? '[]') as QueuedCheckin[]
  } catch {
    cache = []
  }
  return cache
}

function write(items: QueuedCheckin[]) {
  cache = items
  try {
    localStorage.setItem(KEY, JSON.stringify(items))
  } catch {
    /* storage full: the item stays in memory for this session */
  }
  listeners.forEach((l) => l())
}

export function queued(): QueuedCheckin[] {
  return read()
}

export function enqueue(item: QueuedCheckin) {
  // The same key twice is the same action: keep one.
  write([...read().filter((q) => q.idempotencyKey !== item.idempotencyKey), item])
}

export function useQueued(tripId?: string) {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => read(),
  ).filter((q) => !tripId || q.tripId === tripId)
}

/**
 * Send queued check-ins in order. Stops at the first one that can't go yet and keeps the rest: no
 * connection, signed out, a rate limit, a 5xx, or "already being processed". A check-in the server
 * answered for good (a 4xx it keeps under the key, like a task that no longer exists) is dropped:
 * retrying it would never succeed. One flush at a time: a flapping connection can't send twice.
 */
export function flush(send: (item: QueuedCheckin) => Promise<unknown>): Promise<{ sent: number; dropped: number }> {
  running ??= sendAll(send).finally(() => {
    running = null
  })
  return running
}

let running: Promise<{ sent: number; dropped: number }> | null = null

async function sendAll(send: (item: QueuedCheckin) => Promise<unknown>) {
  let sent = 0
  let dropped = 0
  for (const item of [...read()]) {
    try {
      await send(item)
      sent++
    } catch (err) {
      if (isSignedOutError(err) || !keyIsSpent(err)) break
      dropped++
    }
    write(read().filter((q) => q.idempotencyKey !== item.idempotencyKey))
  }
  return { sent, dropped }
}

/** Forget every waiting check-in (sign-out). */
export function clearQueue() {
  cache = null
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l())
}

/** For tests. */
export const resetQueue = clearQueue
