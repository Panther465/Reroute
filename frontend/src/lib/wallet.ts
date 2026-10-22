// The wallet: simulated money that pays for simulated bookings. Nothing real is charged.
import { useEffect, useRef, useState } from 'react'
import { api, newKey } from '@/api/client'
import { keys, queryClient } from '@/api/queries'
import type { Wallet } from '@/api/types'

export async function topUp(amountInr: number): Promise<Wallet> {
  const wallet = await api.post<Wallet>('/v1/wallet/topups', { amountInr }, { idempotencyKey: newKey('top') })
  queryClient.setQueryData(keys.wallet, wallet)
  return wallet
}

/** A number that counts up (or down) to `value` over `ms`, with a strong ease-out. Instantly with reduced motion. */
export function useCountUp(value: number, ms = 700) {
  const [shown, setShown] = useState(value)
  const from = useRef(value)
  useEffect(() => {
    const start = from.current
    if (start === value || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      from.current = value
      setShown(value)
      return
    }
    let frame = 0
    const t0 = performance.now()
    const tick = (now: number) => {
      const t = Math.min(1, (now - t0) / ms)
      const eased = 1 - Math.pow(1 - t, 4)
      setShown(Math.round(start + (value - start) * eased))
      if (t < 1) frame = requestAnimationFrame(tick)
      else from.current = value
    }
    frame = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(frame)
      from.current = value
    }
  }, [value, ms])
  return shown
}
