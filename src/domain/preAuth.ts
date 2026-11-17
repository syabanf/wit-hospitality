import { addDays, type IsoDate } from '@/lib/dates'
import { BOOKING_STATUS_LABEL, type Booking } from './booking'
import { RuleError } from './errors'

/**
 * A card pre-authorization held as a stay's security deposit. Only the brand and the last four
 * digits of the card are kept; a hold moves no money, a capture is a card payment on the folio.
 * Contract: api/docs/contracts/front-office-controls-contract.md section 2.
 */

export type CardBrand = 'visa' | 'mastercard' | 'amex' | 'jcb' | 'unionpay'
export const CARD_BRANDS: readonly CardBrand[] = ['visa', 'mastercard', 'amex', 'jcb', 'unionpay']
export const CARD_BRAND_LABEL: Record<CardBrand, string> = { visa: 'Visa', mastercard: 'Mastercard', amex: 'American Express', jcb: 'JCB', unionpay: 'UnionPay' }

export type PreAuthStatus = 'active' | 'captured' | 'released'
export const PRE_AUTH_STATUS_LABEL: Record<PreAuthStatus, string> = { active: 'Active', captured: 'Captured', released: 'Released' }

export interface PreAuth {
  id: string
  number: string
  bookingId: string
  amount: number
  brand: CardBrand
  last4: string
  approvalCode: string
  /** The last day the hold stands. */
  expiresOn: IsoDate
  status: PreAuthStatus
  takenBy: string
  takenAt: string
  captured: number
  paymentId: string | null
  closedBy: string | null
  closedAt: string | null
}

export interface PreAuthInput {
  bookingId: string
  amount: number
  brand: CardBrand
  last4: string
  /** From the card terminal; blank takes the gateway's. */
  approvalCode: string
  expiresOn: IsoDate
}

export const MAX_HOLD_DAYS = 30
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/
const rupiah = (n: number) => n.toLocaleString('id-ID')

export function validatePreAuth(input: Omit<PreAuthInput, 'bookingId'>, today: IsoDate): Partial<Record<keyof PreAuthInput, string>> {
  const errors: Partial<Record<keyof PreAuthInput, string>> = {}
  if (!Number.isInteger(input.amount) || input.amount <= 0) errors.amount = 'Enter the hold in whole rupiah.'
  if (!CARD_BRANDS.includes(input.brand)) errors.brand = 'Pick the card brand.'
  if (!/^\d{4}$/.test(input.last4)) errors.last4 = 'Enter the last four digits of the card.'
  const code = input.approvalCode.trim()
  if (code && !/^[A-Za-z0-9]{4,12}$/.test(code)) errors.approvalCode = 'An approval code is 4 to 12 letters or digits.'
  if (!ISO_DAY.test(input.expiresOn) || input.expiresOn < today) errors.expiresOn = 'The hold must stand until today at least.'
  else if (input.expiresOn > addDays(today, MAX_HOLD_DAYS)) errors.expiresOn = 'A card hold stands at most 30 days.'
  return errors
}

/** The code the demo gateway gives a hold taken without one: n is the hold's sequence number. */
export const gatewayApprovalCode = (n: number) => `A${String((n * 7919) % 100000).padStart(5, '0')}`

/** The demo gateway declines a card ending 0000. */
export const gatewayDeclines = (last4: string) => last4 === '0000'

/** A hold is for a stay arriving or in house, one active hold at a time. */
export function holdProblem(b: Pick<Booking, 'id' | 'code' | 'status'>, holds: readonly Pick<PreAuth, 'bookingId' | 'status' | 'number'>[]): RuleError | null {
  if (b.status !== 'confirmed' && b.status !== 'checked_in') return new RuleError('PREAUTH_STAY', `${b.code} is ${BOOKING_STATUS_LABEL[b.status].toLowerCase()}; a card hold is for a stay arriving or in house.`)
  const active = holds.find((h) => h.bookingId === b.id && h.status === 'active')
  if (active) return new RuleError('PREAUTH_ACTIVE', `${b.code} already holds ${active.number}; capture or release it first.`)
  return null
}

/** An active hold past its last day; read, never stored. */
export const preAuthExpired = (h: Pick<PreAuth, 'status' | 'expiresOn'>, today: IsoDate) => h.status === 'active' && h.expiresOn < today

export function closedProblem(h: Pick<PreAuth, 'status' | 'number'>): RuleError | null {
  return h.status === 'active' ? null : new RuleError('PREAUTH_CLOSED', `${h.number} is ${h.status}.`)
}

/** Throws PREAUTH_CLOSED or PREAUTH_EXPIRED, else returns the amount's field error. */
export function captureProblem(h: PreAuth, amount: number, roomDue: number, today: IsoDate): { amount?: string } {
  const closed = closedProblem(h)
  if (closed) throw closed
  if (preAuthExpired(h, today)) throw new RuleError('PREAUTH_EXPIRED', `The hold on ${h.number} lapsed on ${h.expiresOn}; take the money another way.`)
  if (!Number.isInteger(amount) || amount <= 0) return { amount: 'Enter the amount to capture in whole rupiah.' }
  if (amount > h.amount) return { amount: `Only ${rupiah(h.amount)} is held.` }
  if (amount > roomDue) return { amount: `The room balance is ${rupiah(roomDue)}; capture at most that.` }
  return {}
}

export const cardLabel = (h: Pick<PreAuth, 'brand' | 'last4'>) => `${CARD_BRAND_LABEL[h.brand]} ending ${h.last4}`

/** How the guest leaves the security deposit at check-in. */
export type DepositMethod = 'cash' | 'bank_transfer' | 'preauth'
export const DEPOSIT_METHOD_LABEL: Record<DepositMethod, string> = { cash: 'Cash', bank_transfer: 'Bank transfer', preauth: 'Card hold' }
export interface DepositChoice {
  method: DepositMethod
  /** The card for a hold; the deposit amount is the hold. */
  card?: Omit<PreAuthInput, 'bookingId' | 'amount'>
}
