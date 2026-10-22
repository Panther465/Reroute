import { beforeEach, describe, expect, it } from 'vitest'
import { ApiError } from '@/api/client'
import { enqueue, flush, queued, resetQueue, type QueuedCheckin } from './offlineQueue'

const item = (key: string, extra: Partial<QueuedCheckin> = {}): QueuedCheckin => ({ tripId: 'trip-001', taskId: 'task-meet', kind: 'done', idempotencyKey: key, queuedAt: 1, ...extra })

beforeEach(() => resetQueue())

describe('offline check-in queue', () => {
  it('keeps queued check-ins across reloads (localStorage)', () => {
    enqueue(item('k1'))
    expect(JSON.parse(localStorage.getItem('reroute:checkin-queue')!)).toHaveLength(1)
    expect(queued().map((q) => q.idempotencyKey)).toEqual(['k1'])
  })

  it('keeps one entry per idempotency key', () => {
    enqueue(item('k1'))
    enqueue(item('k1', { queuedAt: 2 }))
    expect(queued()).toHaveLength(1)
  })

  it('sends in order with the original keys and empties the queue', async () => {
    enqueue(item('k1'))
    enqueue(item('k2', { taskId: 'task-bank' }))
    const sent: string[] = []
    const res = await flush(async (q) => {
      sent.push(q.idempotencyKey)
    })
    expect(sent).toEqual(['k1', 'k2'])
    expect(res).toEqual({ sent: 2, dropped: 0 })
    expect(queued()).toEqual([])
  })

  it('stops at the first network failure and keeps the rest', async () => {
    enqueue(item('k1'))
    enqueue(item('k2'))
    let n = 0
    const res = await flush(async () => {
      n++
      if (n === 2) throw new ApiError(0, 'OFFLINE', 'offline')
    })
    expect(res.sent).toBe(1)
    expect(queued().map((q) => q.idempotencyKey)).toEqual(['k2'])
  })

  it('drops a check-in the server refuses, so it never blocks the queue', async () => {
    enqueue(item('k1'))
    enqueue(item('k2'))
    let n = 0
    const res = await flush(async () => {
      n++
      if (n === 1) throw new ApiError(409, 'CONFLICT', 'This task is already marked done.')
    })
    expect(res).toEqual({ sent: 1, dropped: 1 })
    expect(queued()).toEqual([])
  })

  it('keeps a check-in that was rate limited or is still being processed', async () => {
    enqueue(item('k1'))
    await flush(async () => {
      throw new ApiError(429, 'RATE_LIMITED', 'Too many requests.')
    })
    expect(queued()).toHaveLength(1)
    await flush(async () => {
      throw new ApiError(409, 'IN_PROGRESS', 'The same request is already being processed.')
    })
    expect(queued()).toHaveLength(1)
  })

  it('sends each check-in once when two flushes overlap', async () => {
    enqueue(item('k1'))
    enqueue(item('k2'))
    const sent: string[] = []
    const send = async (q: QueuedCheckin) => {
      await new Promise((r) => setTimeout(r, 5))
      sent.push(q.idempotencyKey)
    }
    const [a, b] = await Promise.all([flush(send), flush(send)])
    expect(sent).toEqual(['k1', 'k2'])
    expect(a).toBe(b)
    expect(queued()).toEqual([])
  })

  it('keeps everything on a server error, to retry later', async () => {
    enqueue(item('k1'))
    await flush(async () => {
      throw new ApiError(500, 'INTERNAL', 'oops')
    })
    expect(queued()).toHaveLength(1)
  })
})
