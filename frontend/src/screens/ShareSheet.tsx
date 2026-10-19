import { useQuery } from '@tanstack/react-query'
import { Copy, Eye } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api, ApiError, newKey } from '@/api/client'
import type { ShareLink, Trip } from '@/api/types'
import { Button } from '@/components/ui/Button'
import { Switch } from '@/components/ui/Choice'
import { inputClass } from '@/components/ui/Field'
import { Sheet } from '@/components/ui/Sheet'
import { Banner, ErrorState } from '@/components/ui/States'
import { useOnline } from '@/lib/hooks'
import { T, useTl } from '@/lib/i18n'
import { forgetShareToken, saveShareToken, shareToken } from '@/lib/shareTokens'
import { showToast } from '@/lib/store'

export function shareUrl(token: string) {
  return `${location.origin}/shared/${token}`
}

export function ShareSheet({ trip, open, onOpenChange }: { trip: Trip; open: boolean; onOpenChange: (o: boolean) => void }) {
  const tl = useTl()
  const online = useOnline()
  const [busy, setBusy] = useState(false)
  // Bumped when a token is saved, so the link shows without waiting for the list.
  const [, setSaved] = useState(0)
  const links = useQuery({ queryKey: ['share-links', trip.tripId], queryFn: () => api.get<ShareLink[]>(`/v1/trips/${trip.tripId}/share-links`), enabled: open && online })
  const live = links.data?.find((l) => !l.revokedAt && Date.parse(l.expiresAt) > Date.now())
  // The token is shown once, when the link is created; it is kept on this phone so the link shows again after a reload.
  const token = live ? shareToken(live.shareId) : undefined
  const url = token ? shareUrl(token) : null

  // Tokens of links that were revoked or have expired are no use: forget them.
  useEffect(() => {
    links.data?.filter((l) => l.revokedAt || Date.parse(l.expiresAt) <= Date.now()).forEach((l) => forgetShareToken(l.shareId))
  }, [links.data])

  const start = async () => {
    setBusy(true)
    try {
      const link = await api.post<ShareLink>(`/v1/trips/${trip.tripId}/share-links`, {}, { idempotencyKey: newKey('share') })
      if (link.token) {
        saveShareToken(link.shareId, link.token)
        setSaved((n) => n + 1)
      }
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
      await Promise.all(
        links.data
          .filter((l) => !l.revokedAt)
          .map(async (l) => {
            await api.delete(`/v1/share-links/${l.shareId}`)
            forgetShareToken(l.shareId)
          }),
      )
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

  const title = tl('Share your trip')
  const label = tl('Share live trip')
  // A failed check must not read as "Off": we don't know whether a link is live.
  const unknown = links.isError && !links.data

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={title.text} titleLang={title.lang} description="Family will see your stops and your progress through the day. They won't see your exact location.">
      <div className="flex flex-col gap-4">
        {!online && <Banner tone="offline">You're offline. You can change sharing once you're back.</Banner>}
        {online && unknown ? (
          <ErrorState message="Couldn't check whether your trip is shared. Check your connection and try again." onRetry={() => void links.refetch()} />
        ) : (
          <Switch
            label={label.text}
            lang={label.lang}
            description={live ? `On until ${new Date(live.expiresAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}. Anyone with the link can follow your day.` : links.isPending ? 'Checking…' : 'Off'}
            checked={!!live}
            disabled={!online || busy || links.isPending}
            onChange={(on) => void (on ? start() : stop())}
          />
        )}
        {live && url && (
          <>
            <div>
              <label htmlFor="share-link" className="mb-2 block t-title text-ink">
                Link
              </label>
              <div className="flex gap-2">
                <input id="share-link" readOnly value={url} className={`${inputClass} min-w-0 flex-1 t-small`} onFocus={(e) => e.target.select()} />
                <Button variant="secondary" size="md" onClick={copy} icon={<Copy size={20} strokeWidth={1.75} aria-hidden="true" />}>
                  <T k="Copy" />
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
            <T k="Stop sharing" />
          </Button>
        )}
      </div>
    </Sheet>
  )
}
