import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The natural voice without a server: each line is a clip of a known length with two timed words.
vi.mock('./clips', () => ({
  prepare: vi.fn(async (text: string) => ({ url: `blob:${text}`, words: [{ text: 'Time', offsetMs: 0, durationMs: 300 }, { text: 'map', offsetMs: 320, durationMs: 300 }], durationMs: 800, env: null })),
}))

/** An <audio> element that "plays" for as long as the fake clock runs. */
class FakeAudio extends EventTarget {
  static refuse = false
  static last: FakeAudio | null = null
  src = ''
  volume = 1
  currentTime = 0
  paused = true
  private timer: ReturnType<typeof setInterval> | null = null
  constructor() {
    super()
    FakeAudio.last = this
  }
  play() {
    if (FakeAudio.refuse) return Promise.reject(new DOMException('no tap yet', 'NotAllowedError'))
    this.paused = false
    this.currentTime = 0
    this.timer = setInterval(() => {
      this.currentTime += 0.05
      if (this.currentTime >= 0.8) {
        this.stopClock()
        this.dispatchEvent(new Event('ended'))
      }
    }, 50)
    return Promise.resolve()
  }
  pause() {
    this.stopClock()
    this.dispatchEvent(new Event('pause'))
  }
  private stopClock() {
    this.paused = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}

type Channel = typeof import('./channel')
let ch: Channel

beforeEach(async () => {
  vi.useFakeTimers()
  FakeAudio.refuse = false
  vi.stubGlobal('Audio', FakeAudio)
  vi.resetModules()
  ch = await import('./channel')
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const flush = () => vi.advanceTimersByTimeAsync(0)

describe('Roo’s one voice', () => {
  it('never makes a quiet chat line wait behind an alert being read out', async () => {
    const alert = ch.enqueue('Time to leave for the bank', { priority: 'alert' })
    const chat = ch.enqueue('Hi Arjun', { silent: true, durationMs: 300 })
    let chatStarted = false
    void chat.started.then(() => (chatStarted = true))
    await vi.advanceTimersByTimeAsync(20)
    expect(chatStarted).toBe(true)
    let alertDone = false
    void alert.done.then(() => (alertDone = true))
    expect(alertDone).toBe(false)
  })

  it('says lines in order, the next only after the last has finished', async () => {
    const order: string[] = []
    const a = ch.enqueue('first', { silent: true, durationMs: 1000 })
    const b = ch.enqueue('second', { silent: true, durationMs: 500 })
    void a.started.then(() => order.push('a starts'))
    void a.done.then(() => order.push('a ends'))
    void b.started.then(() => order.push('b starts'))
    await flush()
    expect(order).toEqual(['a starts'])
    await vi.advanceTimersByTimeAsync(999)
    expect(order).toEqual(['a starts'])
    await vi.advanceTimersByTimeAsync(200)
    expect(order).toEqual(['a starts', 'a ends', 'b starts'])
  })

  it('is "talking" exactly while a line plays', async () => {
    const line = ch.enqueue('hello', { silent: true, durationMs: 600 })
    await flush()
    expect(ch.speakingNow()).toMatchObject({ id: line.id, priority: 'chat' })
    expect(ch.mouthNow()).not.toBeNull()
    await vi.advanceTimersByTimeAsync(700)
    expect(ch.speakingNow()).toBeNull()
    expect(ch.mouthNow()).toBeNull()
  })

  it('plays the natural voice to its end, with the mouth following the timed words', async () => {
    const line = ch.enqueue('Time map')
    await flush()
    expect(ch.speakingNow()).toMatchObject({ id: line.id, voiced: true })
    // At 400 ms the voice is in "map": the lips are shut for the m.
    await vi.advanceTimersByTimeAsync(350)
    expect(ch.progressOf(line.id)).toBeGreaterThan(0.3)
    let ended = false
    void line.done.then(() => (ended = true))
    await vi.advanceTimersByTimeAsync(600)
    expect(ended).toBe(true)
    expect(ch.progressOf(line.id)).toBe(1)
  })

  it('lets an alert cut in: the chat line stops and its promises settle', async () => {
    const chat = ch.enqueue('a long chat line', { silent: true, durationMs: 5000 })
    const waiting = ch.enqueue('still waiting', { silent: true, durationMs: 1000 })
    await flush()
    const alert = ch.enqueue('Time to leave', { priority: 'alert', interrupt: true })
    let chatDone = false
    let waitingDone = false
    void chat.done.then(() => (chatDone = true))
    void waiting.done.then(() => (waitingDone = true))
    await vi.advanceTimersByTimeAsync(10)
    expect(chatDone && waitingDone).toBe(true)
    expect(ch.speakingNow()).toMatchObject({ id: alert.id, priority: 'alert' })
  })

  it('cancelling chat lines settles them, so a conversation never waits forever', async () => {
    const a = ch.enqueue('one', { silent: true, durationMs: 3000 })
    const b = ch.enqueue('two', { silent: true, durationMs: 3000 })
    await flush()
    ch.cancel('chat')
    await vi.advanceTimersByTimeAsync(1)
    await expect(Promise.all([a.done, b.done])).resolves.toBeDefined()
    expect(ch.speakingNow()).toBeNull()
  })

  it('goes quiet instead of stalling when the browser refuses to play before a tap', async () => {
    FakeAudio.refuse = true
    const line = ch.enqueue('blocked', { durationMs: 400 })
    let ended = false
    void line.done.then(() => (ended = true))
    await vi.advanceTimersByTimeAsync(10)
    // It runs as a quiet line: the mouth murmurs and the words still appear on time.
    expect(ch.speakingNow()).toMatchObject({ id: line.id, voiced: false })
    await vi.advanceTimersByTimeAsync(500)
    expect(ended).toBe(true)
  })
})
