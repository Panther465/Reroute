import { useCallback, useState } from 'react'
import { ApiError, newKey } from '@/api/client'

/**
 * Whether the server kept its answer under the request's idempotency key. It keeps every answer below
 * 500, so retrying a corrected request with the same key would get "this key was already used" (409).
 * Not kept: no connection, a 5xx, a rate limit, a sign-in problem, or IN_PROGRESS (the first try is
 * still running, so a new key could do the work twice).
 */
export function keyIsSpent(err: unknown): boolean {
  if (!(err instanceof ApiError) || err.offline) return false
  if (err.status < 400 || err.status >= 500) return false
  return err.status !== 401 && err.status !== 429 && err.code !== 'IN_PROGRESS'
}

/** One idempotency key per attempt: a retry of the same request reuses it, a refused one gets a new one. */
export function useSubmitKey(prefix: string) {
  const [key, setKey] = useState(() => newKey(prefix))
  const renew = useCallback(() => setKey(newKey(prefix)), [prefix])
  const after = useCallback(
    (err: unknown) => {
      if (keyIsSpent(err)) renew()
    },
    [renew],
  )
  return { key, renew, after }
}
