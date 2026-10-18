import { useQuery } from '@tanstack/react-query'
import { Copy, Eye } from 'lucide-react'
import { useState } from 'react'
import { api, ApiError, newKey } from '@/api/client'
import type { ShareLink, Trip } from '@/api/types'
import { Button } from '@/components/ui/Button'
import { Switch } from '@/components/ui/Choice'
import { inputClass } from '@/components/ui/Field'
import { Sheet } from '@/components/ui/Sheet'
import { Banner } from '@/components/ui/States'
import { useOnline } from '@/lib/hooks'
import { showToast } from '@/lib/store'

export function shareUrl(token: string) {
  return `${location.origin}/shared/${token}`
}

// The token is shown once, when the link is created. Keep it for this session so the link can be copied again.
const tokens = new Map<string, string>()

export function ShareSheet({ trip, open, onOpenChange }: { trip: Trip; open: boolean; onOpenChange: (o: boolean) => void }) {
  const online = useOnline()
  const [busy, setBusy] = useState(false)
  const links = useQuery({ queryKey: ['share-links', trip.tripId], queryFn: () => api.get<ShareLink[]>(`/v1/trips/${trip.tripId}/share-links`), enabled: open && online })
  const live = links.data?.find((l) => !l.revokedAt && Date.parse(l.expiresAt) > Date.now())
  const token = live ? tokens.get(live.shareId) : undefined
  const url = token ? shareUrl(token) : null

  const start = async () => {
    setBusy(true)
    try {
      const link = await api.post<ShareLink>(`/v1/trips/${trip.tripId}/share-links`, {}, { idempotencyKey: newKey('share') })
      if (link.token) tokens.set(link.shareId, link.token)
      await links.refetch()
    } catch (err) {
      showToast({ title: err instanceof ApiError ? err.message : "Couldn't start sharing. Try again." })
    } finally {
      setBusy(false)
    }
  }

  const stop = async () => {
    if (!links.data) return
    setBusy(true)
    try {
      await Promise.all(links.data.filter((l) => !l.revokedAt).map((l) => api.delete(`/v1/share-links/${l.shareId}`)))
      await links.refetch()
      showToast({ title: 'Sharing stopped. The link no longer works.' })
    } catch (err) {
      showToast({ title: err instanceof ApiError ? err.message : "Couldn't stop sharing. Try again." })
    } finally {
      setBusy(false)
    }
  }

  const copy = async () => {
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      showToast({ title: 'Link copied.' })
    } catch {
      showToast({ title: "Couldn't copy. Select the link and copy it yourself." })
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Share your trip" description="Family will see your stops and your progress through the day. They won't see your exact location.">
      <div className="flex flex-col gap-4">
        {!online && <Banner tone="offline">You're offline. You can change sharing once you're back.</Banner>}
        <Switch label="Share live trip" description={live ? `On until ${new Date(live.expiresAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}. Anyone with the link can follow your day.` : 'Off'} checked={!!live} disabled={!online || busy || links.isPending} onChange={(on) => void (on ? start() : stop())} />
        {live && url && (
          <>
            <div>
              <label htmlFor="share-link" className="mb-2 block t-title text-ink">
                Link
              </label>
              <div className="flex gap-2">
                <input id="share-link" readOnly value={url} className={`${inputClass} min-w-0 flex-1 t-small`} onFocus={(e) => e.target.select()} />
                <Button variant="secondary" size="md" onClick={copy} icon={<Copy size={20} strokeWidth={1.75} aria-hidden="true" />}>
                  Copy
                </Button>
              </div>
            </div>
            <a href={url} target="_blank" rel="noreferrer" className="inline-flex min-h-12 items-center gap-2 self-start rounded-control px-2 t-title text-ink underline decoration-2 underline-offset-4">
              <Eye size={20} strokeWidth={1.75} aria-hidden="true" />
              See what family sees
            </a>
          </>
        )}
        {live && !url && <p className="t-small text-ink-2">A link is already live. For safety its address is shown only once; stop sharing and start again for a new link.</p>}
        {live && (
          <Button variant="destructive" onClick={stop} disabled={!online || busy}>
            Stop sharing
          </Button>
        )}
      </div>
    </Sheet>
  )
}
