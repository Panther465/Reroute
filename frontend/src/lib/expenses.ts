// The expense manager's pieces that aren't screens: names and icons of categories and ways to pay, money in
// paise, and shrinking a receipt's photo before it's sent.
import { Banknote, BedDouble, Building2, Bus, CircleEllipsis, CreditCard, Handshake, Printer, Smartphone, Ticket, UtensilsCrossed, Wallet, Wifi } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ExpenseCategory, Payment } from '@/api/types'

export const CATEGORIES: { value: ExpenseCategory; label: string; Icon: LucideIcon }[] = [
  { value: 'food', label: 'Food', Icon: UtensilsCrossed },
  { value: 'transport', label: 'Travel', Icon: Bus },
  { value: 'stay', label: 'Stay', Icon: BedDouble },
  { value: 'client', label: 'Client', Icon: Handshake },
  { value: 'tickets', label: 'Tickets', Icon: Ticket },
  { value: 'communication', label: 'Phone and internet', Icon: Wifi },
  { value: 'office', label: 'Office', Icon: Printer },
  { value: 'other', label: 'Other', Icon: CircleEllipsis },
]

export const PAYMENTS: { value: Payment; label: string; Icon: LucideIcon }[] = [
  { value: 'cash', label: 'Cash', Icon: Banknote },
  { value: 'upi', label: 'UPI', Icon: Smartphone },
  { value: 'card', label: 'Card', Icon: CreditCard },
  { value: 'company', label: 'Company paid', Icon: Building2 },
  { value: 'wallet', label: 'Reroute wallet', Icon: Wallet },
]

export const categoryOf = (c: ExpenseCategory) => CATEGORIES.find((x) => x.value === c) ?? CATEGORIES[CATEGORIES.length - 1]
export const paymentOf = (p: Payment) => PAYMENTS.find((x) => x.value === p) ?? PAYMENTS[0]

/** ₹1,24,050 or ₹612.50: Indian grouping, paise only when there are some. */
export function paise(n: number): string {
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  const rupees = Math.floor(abs / 100)
  const rest = abs % 100
  return `${sign}₹${rupees.toLocaleString('en-IN')}${rest ? `.${String(rest).padStart(2, '0')}` : ''}`
}

/** "612.50", "1,240" or "₹350" typed in a field, in paise; null when it isn't an amount. */
export function toPaise(text: string): number | null {
  const clean = text.replace(/[₹,\s]/g, '').replace(/^rs\.?/i, '')
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null
  const [whole, frac = ''] = clean.split('.')
  const value = Number(whole) * 100 + Number(frac.padEnd(2, '0'))
  return value > 0 && value <= 100_000_000 ? value : null
}

/** An amount in paise as the field shows it: "612.50", "350". */
export function paiseField(n: number | null | undefined): string {
  if (n == null) return ''
  return n % 100 ? (n / 100).toFixed(2) : String(n / 100)
}

const SENDABLE = ['image/jpeg', 'image/png', 'image/webp']
const LONGEST_SIDE = 1600

/**
 * A receipt's photo, made small enough to send: at most 1600 px on its longest side, as a JPEG. A receipt stays
 * readable, and a phone's 5 MB photo becomes a couple of hundred kilobytes. A photo the browser can't open (an
 * iPhone's HEIC, say) is sent as it is when its type and size allow, else refused.
 */
export async function shrinkPhoto(file: Blob): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, LONGEST_SIDE / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bitmap.width * scale)
    canvas.height = Math.round(bitmap.height * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no canvas')
    // A white page under a transparent PNG, not black.
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close?.()
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.78))
    if (blob && blob.size > 0) return blob
  } catch {
    /* fall through: send it as it is, if it can go */
  }
  if (SENDABLE.includes(file.type) && file.size <= 2_000_000) return file
  throw new Error("Couldn't open that photo. Take it again, or choose a JPEG or PNG.")
}
