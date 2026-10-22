import { describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { ApiError } from '@/api/client'
import { keyIsSpent, useSubmitKey } from './submitKey'

describe('idempotency keys per attempt', () => {
  it('treats an answer the server keeps as spent, and the rest as safe to retry', () => {
    expect(keyIsSpent(new ApiError(409, 'CONFLICT', "That ride isn't on offer any more."))).toBe(true)
    expect(keyIsSpent(new ApiError(422, 'VALIDATION_ERROR', 'Check the form.'))).toBe(true)
    expect(keyIsSpent(new ApiError(0, 'OFFLINE', 'offline'))).toBe(false)
    expect(keyIsSpent(new ApiError(500, 'INTERNAL', 'oops'))).toBe(false)
    expect(keyIsSpent(new ApiError(429, 'RATE_LIMITED', 'Wait'))).toBe(false)
    expect(keyIsSpent(new ApiError(401, 'UNAUTHENTICATED', 'Sign in'))).toBe(false)
    expect(keyIsSpent(new ApiError(409, 'IN_PROGRESS', 'Still working'))).toBe(false)
    expect(keyIsSpent(new Error('boom'))).toBe(false)
  })

  it('renews the key only after a refusal the server kept', () => {
    const { result } = renderHook(() => useSubmitKey('bkg'))
    const first = result.current.key
    expect(first).toMatch(/^bkg/)
    act(() => result.current.after(new ApiError(500, 'INTERNAL', 'oops')))
    expect(result.current.key).toBe(first)
    act(() => result.current.after(new ApiError(409, 'CONFLICT', 'gone')))
    expect(result.current.key).not.toBe(first)
  })
})
