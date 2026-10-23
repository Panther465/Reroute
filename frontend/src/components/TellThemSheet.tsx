import { MessageCircle, Send } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button, buttonClass } from '@/components/ui/Button'
import { Sheet } from '@/components/ui/Sheet'
import { showToast } from '@/lib/store'
import { shareText, smsLink, whatsappLink } from '@/lib/tellLate'

/**
 * "Tell them I'm late": a ready message with the real arrival time, to send however the traveller
 * likes. Nothing is sent by Reroute itself, and the words can be changed first.
 */
export function TellThemSheet({ open, onOpenChange, message, title = 'Tell them you’re late' }: { open: boolean; onOpenChange: (o: boolean) => void; message: string; title?: string }) {
  const [text, setText] = useState(message)
  // A new arrival time writes a new message; what the traveller typed stays while the sheet is open.
  useEffect(() => {
    if (!open) setText(message)
  }, [message, open])

  const share = async () => {
    const how = await shareText(text.trim())
    if (how === 'copied') showToast({ title: 'Message copied. Paste it into WhatsApp, SMS or email.' })
    if (how === 'failed') showToast({ title: 'Couldn’t share it here. Copy the message from the box.' })
    if (how === 'shared' || how === 'copied') onOpenChange(false)
  }

  const footer = (
    <div className="flex flex-col gap-2">
      <Button full icon={<Send size={20} strokeWidth={1.75} aria-hidden="true" />} onClick={() => void share()} disabled={!text.trim()}>
        Share the message
      </Button>
      <div className="grid grid-cols-2 gap-3">
        <a href={whatsappLink(text.trim())} target="_blank" rel="noopener noreferrer" className={buttonClass('secondary', 'md', true)}>
          <MessageCircle size={20} strokeWidth={1.75} aria-hidden="true" />
          WhatsApp
        </a>
        <a href={smsLink(text.trim())} className={buttonClass('secondary', 'md', true)}>
          Text message
        </a>
      </div>
    </div>
  )

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={title} description="It isn’t yours to move, so tell them early, with when you’ll really get there." footer={footer}>
      <label htmlFor="tell-them" className="mb-1 block t-title text-ink">
        Your message
      </label>
      <textarea
        id="tell-them"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        maxLength={600}
        className="w-full resize-none rounded-control border-2 border-line bg-surface px-4 py-3 t-body text-ink placeholder:text-muted focus:border-green focus:outline-none"
      />
      <p className="mt-2 t-small text-ink-2">Reroute sends nothing itself: you choose who gets it, and how.</p>
    </Sheet>
  )
}
