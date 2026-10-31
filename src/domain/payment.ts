import { addDays, daysBetween, withinRange, type IsoDate } from '@/lib/dates'
import type { Attachment } from './attachment'

export type PaymentKind = 'deposit' | 'balance' | 'full' | 'extra' | 'refund' | 'payout'
export const PAYMENT_KINDS: readonly PaymentKind[] = ['deposit', 'balance', 'full', 'extra', 'refund', 'payout']
export const PAYMENT_KIND_LABEL: Record<PaymentKind, string> = { deposit: 'Deposit', balance: 'Balance', full: 'Full payment', extra: 'Extras', refund: 'Refund', payout: 'Airbnb payout' }

export type PaymentMethod = 'cash' | 'bank_transfer' | 'card' | 'qris' | 'virtual_account' | 'airbnb_payout'
export const PAYMENT_METHODS: readonly PaymentMethod[] = ['cash', 'bank_transfer', 'card', 'qris', 'virtual_account', 'airbnb_payout']
export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  cash: 'Cash',
  bank_transfer: 'Bank transfer',
  card: 'Card',
  qris: 'QRIS',
  virtual_account: 'Virtual account',
  airbnb_payout: 'Airbnb payout',
}
/** Methods the guest pays through a link on the payment gateway. */
export const GATEWAY_METHODS: readonly PaymentMethod[] = ['qris', 'virtual_account', 'card']
/** Methods the desk or finance records directly. */
export const DESK_METHODS: readonly PaymentMethod[] = ['cash', 'bank_transfer']
export const isGateway = (m: PaymentMethod) => GATEWAY_METHODS.includes(m)

export type PaymentStatus = 'pending' | 'paid' | 'failed' | 'expired' | 'refunded' | 'cancelled'
export const PAYMENT_STATUSES: readonly PaymentStatus[] = ['pending', 'paid', 'failed', 'expired', 'refunded', 'cancelled']
export const PAYMENT_STATUS_LABEL: Record<PaymentStatus, string> = { pending: 'Pending', paid: 'Paid', failed: 'Failed', expired: 'Expired', refunded: 'Refunded', cancelled: 'Cancelled' }

export interface PaymentEvent {
  kind: 'created' | 'link_sent' | 'proof' | 'paid' | 'failed' | 'expired' | 'refunded' | 'cancelled'
  by: string
  /** ISO date-time. */
  at: string
  note: string
}

export interface Payment {
  id: string
  number: string
  bookingId: string
  kind: PaymentKind
  method: PaymentMethod
  /** Always positive; a refund moves money out. */
  amount: number
  status: PaymentStatus
  dueOn: IsoDate | null
  paidOn: IsoDate | null
  reference: string
  payer: string
  note: string
  /** The finance entry the money landed in; null for money recorded before the console. */
  transactionId: string | null
  /** The cash-out entry for the gateway fee, when there is one. */
  feeTransactionId: string | null
  gatewayFee: number
  /** For a refund: the payment it gives money back from. */
  refundOf: string | null
  createdBy: string
  createdOn: IsoDate
  history: readonly PaymentEvent[]
}

export type LinkStatus = 'pending' | 'paid' | 'failed' | 'expired' | 'cancelled'

/** A checkout session on the payment gateway: what the guest opens at /pay/:token. */
export interface PaymentLink {
  token: string
  bookingId: string
  paymentId: string
  method: PaymentMethod
  amount: number
  /** ISO date-time. */
  createdAt: string
  expiresAt: string
  status: LinkStatus
  /** Bank and number for a virtual account; empty otherwise. */
  vaBank: string
  vaNumber: string
  /** The string a QRIS code would carry; drawn as a grid on the page. */
  qrPayload: string
  gatewayFee: number
  /** Transfer receipts the guest uploaded on the checkout page; they travel to the cash-in entry. */
  proofs: readonly Attachment[]
}

/** What the public checkout page shows; read without a session. */
export interface PublicCheckout {
  link: PaymentLink
  paymentNumber: string
  paymentStatus: PaymentStatus
  kind: PaymentKind
  guestName: string
  villaName: string
  locationName: string
  unitCode: string
  unitName: string
  checkIn: IsoDate
  checkOut: IsoDate
  nights: number
  bookingCode: string
  total: number
  paidBefore: number
  paidOn: IsoDate | null
  reference: string
}

export interface PaymentPolicy {
  /** Deposit asked of direct bookings, percent of the stay. */
  depositPct: number
  /** The balance falls due this many days before arrival. */
  balanceDueDays: number
  linkExpiryHours: number
  cardFeePct: number
  qrisFeePct: number
  /** Flat fee per virtual account payment. */
  vaFee: number
  /** Drafts whose deposit is still unpaid after this many days are flagged for cancellation. */
  autoCancelDays: number
  /** A cancellation at least this many days before arrival gets the deposit back; later, the villa keeps it. */
  freeCancelDays: number
  /** A direct stay priced further than this percent under the list needs someone who may approve bookings. */
  discountLimitPct: number
}

export const DEFAULT_PAYMENT_POLICY: PaymentPolicy = { depositPct: 30, balanceDueDays: 7, linkExpiryHours: 24, cardFeePct: 2.9, qrisFeePct: 0.7, vaFee: 4_000, autoCancelDays: 3, freeCancelDays: 14, discountLimitPct: 10 }

export function validatePolicy(p: PaymentPolicy): Partial<Record<keyof PaymentPolicy, string>> {
  const errors: Partial<Record<keyof PaymentPolicy, string>> = {}
  if (!(p.depositPct >= 0 && p.depositPct <= 100)) errors.depositPct = 'A percentage from 0 to 100.'
  if (!Number.isInteger(p.balanceDueDays) || p.balanceDueDays < 0 || p.balanceDueDays > 60) errors.balanceDueDays = '0 to 60 days.'
  if (!Number.isInteger(p.linkExpiryHours) || p.linkExpiryHours < 1 || p.linkExpiryHours > 168) errors.linkExpiryHours = '1 to 168 hours.'
  if (!(p.cardFeePct >= 0 && p.cardFeePct <= 10)) errors.cardFeePct = '0 to 10 percent.'
  if (!(p.qrisFeePct >= 0 && p.qrisFeePct <= 10)) errors.qrisFeePct = '0 to 10 percent.'
  if (!Number.isInteger(p.vaFee) || p.vaFee < 0) errors.vaFee = 'Whole rupiah, zero or more.'
  if (!Number.isInteger(p.autoCancelDays) || p.autoCancelDays < 1 || p.autoCancelDays > 30) errors.autoCancelDays = '1 to 30 days.'
  if (!Number.isInteger(p.freeCancelDays) || p.freeCancelDays < 0 || p.freeCancelDays > 90) errors.freeCancelDays = '0 to 90 days.'
  if (!(p.discountLimitPct >= 0 && p.discountLimitPct <= 100)) errors.discountLimitPct = 'A percentage from 0 to 100.'
  return errors
}

export const gatewayFee = (method: PaymentMethod, amount: number, p: PaymentPolicy) => {
  if (method === 'card') return Math.round((amount * p.cardFeePct) / 100)
  if (method === 'qris') return Math.round((amount * p.qrisFeePct) / 100)
  if (method === 'virtual_account') return p.vaFee
  return 0
}

/** Money in minus refunds out, for one booking. Payouts count at their gross: the fee is Airbnb's. */
export function netPaid(payments: readonly Pick<Payment, 'bookingId' | 'kind' | 'status' | 'amount'>[], bookingId: string): number {
  return payments
    .filter((p) => p.bookingId === bookingId && (p.status === 'paid' || p.status === 'refunded'))
    .reduce((s, p) => s + (p.kind === 'refund' ? -p.amount : p.amount), 0)
}

export type SettledStatus = 'unpaid' | 'partial' | 'paid'
export const settledStatus = (paid: number, total: number): SettledStatus => (paid <= 0 ? 'unpaid' : paid >= total ? 'paid' : 'partial')

export const depositAmount = (total: number, p: PaymentPolicy) => Math.round((total * p.depositPct) / 100 / 10_000) * 10_000

export const balanceDueOn = (checkIn: IsoDate, p: PaymentPolicy) => addDays(checkIn, -p.balanceDueDays)

export interface CancellationTerms {
  refund: number
  /** Money the villa keeps as room revenue. */
  retained: number
}

/**
 * What happens to the money when a stay ends early. A no-show keeps everything. A cancellation
 * refunds whatever was paid above the deposit, and the deposit too when it comes early enough.
 */
export function cancellationTerms(paid: number, total: number, checkIn: IsoDate, today: IsoDate, p: PaymentPolicy, outcome: 'cancelled' | 'no_show'): CancellationTerms {
  if (paid <= 0) return { refund: 0, retained: 0 }
  if (outcome === 'no_show') return { refund: 0, retained: paid }
  const keep = daysBetween(today, checkIn) >= p.freeCancelDays ? 0 : Math.min(paid, depositAmount(total, p))
  return { refund: paid - keep, retained: keep }
}

export interface PaymentInput {
  bookingId: string
  kind: PaymentKind
  method: PaymentMethod
  amount: number
  reference: string
  payer: string
  note: string
  /** Transfer slip or receipt; lands on the cash-in entry. */
  attachments?: readonly Attachment[]
}

/** `outstanding` is what the booking still owes; a refund checks against `paid` instead. */
export function validatePayment(input: PaymentInput, outstanding: number, paid: number): Partial<Record<keyof PaymentInput, string>> {
  const errors: Partial<Record<keyof PaymentInput, string>> = {}
  if (!input.bookingId) errors.bookingId = 'Pick the booking.'
  if (!PAYMENT_METHODS.includes(input.method)) errors.method = 'Pick the method.'
  if (!Number.isInteger(input.amount) || input.amount <= 0) errors.amount = 'Enter a whole rupiah amount above zero.'
  else if (input.kind === 'refund' && input.amount > paid) errors.amount = `Only ${paid} has been paid on this booking.`
  else if (input.kind !== 'refund' && input.amount > outstanding) errors.amount = outstanding > 0 ? `Only ${outstanding} is still owed.` : 'Nothing is owed on this booking.'
  if (input.method === 'bank_transfer' && input.reference.trim().length < 3) errors.reference = 'Enter the bank reference.'
  if (input.kind === 'refund' && input.note.trim().length < 3) errors.note = 'Say why the money goes back.'
  return errors
}

/** Deterministic, believable gateway artefacts from a token. */
function hash(text: string): number {
  let h = 2166136261
  for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
  return h >>> 0
}
export const vaNumberFor = (token: string) => `8808${String(hash(token)).padStart(10, '0').slice(0, 10)}`
export const qrPayloadFor = (token: string, amount: number) => `00020101021226580016ID.CO.BALIVILLA${token.toUpperCase()}5204701153033605406${amount}5802ID6304${(hash(token) % 65536).toString(16).toUpperCase().padStart(4, '0')}`
/** A 21 by 21 boolean grid that looks like a QR code, with the three finder squares. */
export function qrGrid(payload: string, size = 21): boolean[][] {
  let seed = hash(payload)
  const next = () => {
    seed = Math.imul(seed ^ (seed >>> 15), 2246822507) >>> 0
    seed = Math.imul(seed ^ (seed >>> 13), 3266489909) >>> 0
    return (seed ^= seed >>> 16) >>> 0
  }
  const finder = (r: number, c: number) => {
    for (const [fr, fc] of [[0, 0], [0, size - 7], [size - 7, 0]] as const) {
      const y = r - fr
      const x = c - fc
      if (y >= 0 && y < 7 && x >= 0 && x < 7) return y === 0 || y === 6 || x === 0 || x === 6 || (y >= 2 && y <= 4 && x >= 2 && x <= 4) ? 1 : 0
    }
    return -1
  }
  return Array.from({ length: size }, (_, r) => Array.from({ length: size }, (_, c) => {
    const f = finder(r, c)
    return f === -1 ? next() % 2 === 0 : f === 1
  }))
}

export type AgingBucket = 'not_due' | 'd0_7' | 'd8_30' | 'd30'
export const AGING_BUCKETS: readonly AgingBucket[] = ['not_due', 'd0_7', 'd8_30', 'd30']
export const AGING_LABEL: Record<AgingBucket, string> = { not_due: 'Not due', d0_7: '0 to 7 days', d8_30: '8 to 30 days', d30: 'Over 30 days' }
export function agingBucket(dueOn: IsoDate, today: IsoDate): AgingBucket {
  const late = daysBetween(dueOn, today)
  if (late < 0) return 'not_due'
  if (late <= 7) return 'd0_7'
  if (late <= 30) return 'd8_30'
  return 'd30'
}

export interface PaymentFilter {
  status?: PaymentStatus | 'all'
  method?: PaymentMethod | ''
  kind?: PaymentKind | ''
  query?: string
  from?: string
  to?: string
}

export function filterPayments<T extends Payment & { bookingCode: string; guestName: string }>(list: readonly T[], f: PaymentFilter): T[] {
  const q = (f.query ?? '').trim().toLowerCase()
  return list.filter((p) => {
    if (f.status && f.status !== 'all' && p.status !== f.status) return false
    if (f.method && p.method !== f.method) return false
    if (f.kind && p.kind !== f.kind) return false
    if (!withinRange(p.paidOn ?? p.createdOn, f.from, f.to)) return false
    if (q && ![p.number, p.bookingCode, p.guestName, p.reference, p.payer].some((v) => v.toLowerCase().includes(q))) return false
    return true
  })
}
