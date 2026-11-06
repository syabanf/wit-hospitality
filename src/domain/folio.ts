import { addDays, type IsoDate } from '@/lib/dates'
import { isChannel, type Booking } from './booking'
import { forOrders, netPaid, type Payment, type PaymentMethod } from './payment'
import { stayPrice } from './pricing'
import { codeSplit, lineAmount, orderSummary, type ServiceOrder } from './serviceOrder'
import { chargeCodes, MENU_CATEGORY_CODE, OTHER_CODE, PAYMENT_METHOD_CODE, ROOM_CODE, type TransactionCode } from './transactionCode'

/**
 * The guest folio: every debit and credit on one stay, read from the records that already exist
 * (the stay's price, payments, refunds, delivered room service, departure charges) plus the manual
 * postings the desk adds. Its balance is what the guest still owes; check-out reads it.
 */

export type FolioKind = 'room' | 'discount' | 'channel' | 'room_service' | 'comp' | 'charge' | 'departure' | 'allowance' | 'payment' | 'refund' | 'deposit'
export const FOLIO_KINDS: readonly FolioKind[] = ['room', 'discount', 'channel', 'room_service', 'comp', 'charge', 'departure', 'allowance', 'payment', 'refund', 'deposit']
export const FOLIO_KIND_LABEL: Record<FolioKind, string> = {
  room: 'Room night',
  discount: 'Discount',
  channel: 'Paid through Airbnb',
  room_service: 'Room service',
  comp: 'On the house',
  charge: 'Charge',
  departure: 'Departure charges',
  allowance: 'Allowance',
  payment: 'Payment',
  refund: 'Refund',
  deposit: 'Deposit',
}

const DEBITS: ReadonlySet<FolioKind> = new Set(['room', 'room_service', 'charge', 'departure', 'refund'])
/** The deposit is the guest's money held for them; it shows on the folio and stays out of the balance. */
export const folioSide = (kind: FolioKind): 'debit' | 'credit' | 'memo' => (kind === 'deposit' ? 'memo' : DEBITS.has(kind) ? 'debit' : 'credit')

/** Which part of the check-out bill a line settles in. */
export type FolioPart = 'room' | 'orders' | 'charges'

export interface FolioRef {
  type: 'booking' | 'payment' | 'order' | 'posting'
  id: string
  label: string
}

export interface FolioLine {
  id: string
  date: IsoDate
  kind: FolioKind
  description: string
  debit: number
  credit: number
  /** For a deposit: rupiah held (positive) or handed back (negative). */
  memo: number
  ref: FolioRef
  postedBy: string
  /** ISO date-time. */
  postedAt: string
  part: FolioPart
  /** The room service order a line belongs to, so each order settles on its own. */
  orderId: string | null
  /** The transaction code: the charge code a debit books to, the method code of a payment. */
  code: string
}

/** A line the desk posts by hand. A charge adds to what the guest owes; an allowance takes some of it off. */
export interface FolioPosting {
  id: string
  bookingId: string
  kind: 'charge' | 'allowance'
  /** The transaction code it posts on; its account takes the revenue. */
  code: string
  /** What was charged, or why the guest gets the allowance. */
  description: string
  amount: number
  date: IsoDate
  postedBy: string
  postedById: string
  postedAt: string
  /** Who allowed an allowance past the limit; null otherwise. */
  approvedBy: string | null
  /** The cash-in that took the money at check-out; null while it is owed. */
  transactionId: string | null
  /** How the guest paid it at check-out; null while it is owed. */
  paidBy?: PaymentMethod | null
}

export interface ChargeInput {
  /** An active charge code other than the room night. */
  code: string
  description: string
  amount: number
}

export interface AllowanceInput {
  amount: number
  reason: string
}

export function validateCharge(input: ChargeInput, codes: readonly TransactionCode[]): Partial<Record<keyof ChargeInput, string>> {
  const errors: Partial<Record<keyof ChargeInput, string>> = {}
  if (!chargeCodes(codes).some((c) => c.code === input.code)) errors.code = 'Pick the transaction code the charge posts on.'
  if (input.description.trim().length < 3) errors.description = 'Say what was charged.'
  if (!Number.isInteger(input.amount) || input.amount <= 0) errors.amount = 'Enter the charge in whole rupiah.'
  return errors
}

/** `open` is what the folio's charges still come to; an allowance never takes off more. */
export function validateAllowance(input: AllowanceInput, open: number): Partial<Record<keyof AllowanceInput, string>> {
  const errors: Partial<Record<keyof AllowanceInput, string>> = {}
  if (!Number.isInteger(input.amount) || input.amount <= 0) errors.amount = 'Enter the allowance in whole rupiah.'
  else if (input.amount > open) errors.amount = open > 0 ? `Only ${open} of charges is open on the folio.` : 'No open charge on the folio to take it off.'
  if (input.reason.trim().length < 3) errors.reason = 'Say why the guest gets the allowance.'
  return errors
}

/**
 * The discount-limit rule applied to allowances: allowed past `limitPct` of the charges posted on
 * the stay, an allowance needs someone who may approve bookings.
 */
export function allowanceBeyondLimit(postings: readonly Pick<FolioPosting, 'kind' | 'amount'>[], amount: number, limitPct: number) {
  const charged = postings.filter((p) => p.kind === 'charge').reduce((s, p) => s + p.amount, 0)
  const allowed = postings.filter((p) => p.kind === 'allowance').reduce((s, p) => s + p.amount, 0)
  return (allowed + amount) * 100 > charged * limitPct + 1e-9
}

export interface FolioSources {
  booking: Booking
  payments: readonly Payment[]
  orders: readonly ServiceOrder[]
  postings: readonly FolioPosting[]
  /** Set for a stay of a master-billed group: its room lines move to the group's master folio. */
  roomOnMaster?: boolean
}

/** The lines a master-billed group carries for its stays: room nights, discounts and room payments. The security deposit stays with the guest. */
export const folioOnMaster = (l: Pick<FolioLine, 'part' | 'kind'>) => l.part === 'room' && l.kind !== 'deposit'

export interface FolioDue {
  /** What is left on the room; nothing on a channel stay, whose room the channel collects. */
  room: number
  /** Delivered room service still unpaid, per order. */
  orders: Array<{ orderId: string; amount: number }>
  /** Manual charges less allowances, not yet taken. */
  charges: number
}

export interface GuestFolio {
  /** Oldest first, each with the balance after it. */
  lines: Array<FolioLine & { balance: number }>
  debits: number
  credits: number
  /** Debits less credits: above zero the guest owes, below zero the guest is in credit. */
  balance: number
  due: FolioDue
  depositHeld: number
}

const at = (date: IsoDate, time: string) => `${date}T${time}`
const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:00`
const ORDER: Record<FolioKind, number> = { room: 0, discount: 1, channel: 2, room_service: 3, comp: 4, charge: 5, departure: 6, allowance: 7, deposit: 8, refund: 9, payment: 10 }
/** Posting order: by time, then debits before the credits that settle them. */
export const byPosting = (x: FolioLine, y: FolioLine) => x.postedAt.localeCompare(y.postedAt) || ORDER[x.kind] - ORDER[y.kind] || x.id.localeCompare(y.id)

type Draft = Omit<FolioLine, 'debit' | 'credit' | 'memo' | 'orderId'> & { amount: number; orderId?: string }

/** The side of the amount comes from the kind, never from the caller. */
function post(d: Draft): FolioLine {
  const { amount, ...rest } = d
  const side = folioSide(d.kind)
  return { ...rest, orderId: d.orderId ?? null, debit: side === 'debit' ? amount : 0, credit: side === 'credit' ? amount : 0, memo: side === 'memo' ? amount : 0 }
}

const methodCode = (method: PaymentMethod | null | undefined) => PAYMENT_METHOD_CODE[method ?? 'cash']

function roomLines(b: Booking, payments: readonly Payment[]): FolioLine[] {
  const ref: FolioRef = { type: 'booking', id: b.id, label: b.code }
  const by = b.priceSetBy?.by ?? 'Console'
  const room = { ref, part: 'room' as const, code: ROOM_CODE }
  if (b.status === 'cancelled' || b.status === 'no_show') {
    // What the villa keeps after the refunds; the payments and refunds themselves follow below.
    const kept = isChannel(b) ? 0 : netPaid(payments, b.id)
    return kept > 0 ? [post({ ...room, id: `${b.id}-kept`, date: b.checkIn, kind: 'room', description: b.status === 'no_show' ? 'Kept on the no-show' : 'Kept on the cancellation', amount: kept, postedBy: 'Console', postedAt: at(b.checkIn, '00:00:00') })] : []
  }
  const price = stayPrice(b)
  const nights = b.listRates.map((rate, i) => {
    const date = addDays(b.checkIn, i)
    return post({ ...room, id: `${b.id}-night-${i + 1}`, date, kind: 'room', description: `Night ${i + 1} of ${b.listRates.length}${b.rateOverride !== null ? ', staff rate' : ''}`, amount: b.rateOverride ?? rate, postedBy: by, postedAt: at(date, '23:00:00') })
  })
  const extra: FolioLine[] = []
  if (price.discount > 0) extra.push(post({ ...room, id: `${b.id}-discount`, date: b.checkIn, kind: 'discount', description: b.discount?.reason || 'Discount on the stay', amount: price.discount, postedBy: by, postedAt: at(b.checkIn, '23:00:01') }))
  if (isChannel(b)) extra.push(post({ ...room, code: PAYMENT_METHOD_CODE.airbnb_payout, id: `${b.id}-channel`, date: b.checkIn, kind: 'channel', description: 'The guest paid the room to Airbnb; the payout settles with the villa', amount: price.total, postedBy: 'Console', postedAt: at(b.checkIn, '23:00:01') }))
  return [...nights, ...extra]
}

function paymentLines(b: Booking, payments: readonly Payment[], orders: readonly ServiceOrder[]): FolioLine[] {
  return payments
    .filter((p) => p.bookingId === b.id && (p.status === 'paid' || p.status === 'refunded'))
    .flatMap((p) => {
      const date = p.paidOn ?? p.createdOn
      const postedAt = p.history.findLast((e) => e.kind === 'paid')?.at ?? at(date, '12:00:00')
      const base = { date, ref: { type: 'payment' as const, id: p.id, label: p.number }, postedBy: p.createdBy, postedAt, code: methodCode(p.method) }
      if (forOrders(p) && p.kind !== 'refund') {
        // An order payment covers whole orders, so it credits each order its own charge.
        return (p.orderIds ?? []).map((orderId) => {
          const o = orders.find((x) => x.id === orderId)
          return post({ ...base, id: `${p.id}-${orderId}`, kind: 'payment', description: `${p.number} for ${o?.number ?? 'room service'}`, amount: o ? codeSplit(o).reduce((s, r) => s + r.amount, 0) : p.amount, part: 'orders', orderId })
        })
      }
      // Airbnb collects the room; its payouts and refunds settle with the villa, not on the guest's folio.
      if (isChannel(b)) return []
      return [post({ ...base, id: p.id, kind: p.kind === 'refund' ? 'refund' : 'payment', description: `${p.number}${p.note ? `, ${p.note}` : ''}`, amount: p.amount, part: 'room' })]
    })
}

/** A delivered order posts one line per transaction code, each with its items on the house and its share of the discount. */
function orderLines(b: Booking, orders: readonly ServiceOrder[]): FolioLine[] {
  return orders
    .filter((o) => o.bookingId === b.id && o.status === 'delivered')
    .flatMap((o) => {
      const date = o.deliveredOn ?? o.requestedOn
      const postedAt = at(date, clock(o.deliveredAt ?? o.requestedAt))
      const postedBy = o.history.findLast((e) => e.kind === 'delivered')?.by ?? o.assignee
      const base = { date, ref: { type: 'order' as const, id: o.id, label: o.number }, postedBy, postedAt, part: 'orders' as const, orderId: o.id }
      const net = codeSplit(o)
      return [...new Set(o.lines.map((l) => MENU_CATEGORY_CODE[l.category]))].flatMap((code) => {
        const mine = o.lines.filter((l) => MENU_CATEGORY_CODE[l.category] === code)
        const gross = mine.reduce((s, l) => s + lineAmount(l), 0)
        const comp = mine.filter((l) => l.comp).reduce((s, l) => s + lineAmount(l), 0)
        const discount = gross - comp - (net.find((r) => r.code === code)?.amount ?? 0)
        const id = `${o.id}-${code}`
        const lines = [post({ ...base, code, id, kind: 'room_service', description: `${o.number}: ${orderSummary({ lines: mine })}`, amount: gross })]
        if (comp > 0) lines.push(post({ ...base, code, id: `${id}-comp`, kind: 'comp', description: o.compReason || 'Items on the house', amount: comp }))
        if (discount > 0) lines.push(post({ ...base, code, id: `${id}-discount`, kind: 'discount', description: `${o.discountPct}% off ${o.number}${o.discountReason ? `: ${o.discountReason}` : ''}`, amount: discount }))
        return gross > 0 ? lines : []
      })
    })
}

function postingLines(b: Booking, postings: readonly FolioPosting[]): FolioLine[] {
  const mine = postings.filter((p) => p.bookingId === b.id)
  const lines = mine.map((p) => post({ id: p.id, date: p.date, kind: p.kind, code: p.code, description: p.description, amount: p.amount, ref: { type: 'posting', id: p.id, label: p.kind === 'charge' ? p.code : 'Allowance' }, postedBy: p.postedBy, postedAt: p.postedAt, part: 'charges' }))
  // Charges taken at check-out: one credit per cash-in, for the charges less the allowances it covered.
  for (const txId of new Set(mine.flatMap((p) => (p.transactionId ? [p.transactionId] : [])))) {
    const covered = mine.filter((p) => p.transactionId === txId)
    const amount = covered.reduce((s, p) => s + (p.kind === 'charge' ? p.amount : -p.amount), 0)
    const last = covered.reduce((a, p) => (p.postedAt > a.postedAt ? p : a))
    const date = b.checkedOutOn ?? last.date
    if (amount > 0) lines.push(post({ id: `${txId}-charges`, date, kind: 'payment', code: methodCode(last.paidBy), description: 'Charges paid at check-out', amount, ref: { type: 'booking', id: b.id, label: b.code }, postedBy: 'Front desk', postedAt: at(date, '11:00:00'), part: 'charges' }))
  }
  return lines
}

function deskLines(b: Booking): FolioLine[] {
  const ref: FolioRef = { type: 'booking', id: b.id, label: b.code }
  const lines: FolioLine[] = []
  const inOn = b.checkedInOn ?? b.checkIn
  const outOn = b.checkedOutOn ?? b.checkOut
  const held = { ref, postedBy: 'Front desk', part: 'room' as const, code: PAYMENT_METHOD_CODE.cash }
  if (b.arrival && b.arrival.deposit > 0) lines.push(post({ ...held, id: `${b.id}-deposit`, date: inOn, kind: 'deposit', description: 'Security deposit held', amount: b.arrival.deposit, postedAt: at(inOn, '14:00:00') }))
  if (b.departure && b.departure.depositReturned > 0) lines.push(post({ ...held, id: `${b.id}-deposit-back`, date: outOn, kind: 'deposit', description: 'Security deposit returned', amount: -b.departure.depositReturned, postedAt: at(outOn, '11:00:00') }))
  if (b.departure && b.departure.extraCharges > 0) {
    // Departure charges are typed at check-out and taken in the same step.
    const base = { date: outOn, amount: b.departure.extraCharges, ref, postedBy: 'Front desk', postedAt: at(outOn, '10:59:00'), part: 'charges' as const }
    lines.push(post({ ...base, code: OTHER_CODE, id: `${b.id}-departure`, kind: 'departure', description: b.departure.notes || 'Charged at check-out' }), post({ ...base, code: PAYMENT_METHOD_CODE.cash, id: `${b.id}-departure-paid`, kind: 'payment', description: 'Departure charges paid at check-out' }))
  }
  return lines
}

/** Lines in posting order with the balance after each, and their sums. */
export function runningBalance<T extends FolioLine>(sorted: readonly T[]) {
  let running = 0
  const lines = sorted.map((l) => ({ ...l, balance: (running += l.debit - l.credit) }))
  return { lines, debits: lines.reduce((s, l) => s + l.debit, 0), credits: lines.reduce((s, l) => s + l.credit, 0) }
}

const partBalance = (lines: readonly FolioLine[], part: FolioPart) => lines.filter((l) => l.part === part).reduce((s, l) => s + l.debit - l.credit, 0)

export function guestFolio({ booking: b, payments, orders, postings, roomOnMaster = false }: FolioSources): GuestFolio {
  const all = [...roomLines(b, payments), ...orderLines(b, orders), ...postingLines(b, postings), ...deskLines(b), ...paymentLines(b, payments, orders)]
  const sorted = all.filter((l) => !(roomOnMaster && folioOnMaster(l))).sort(byPosting)
  const { lines, debits, credits } = runningBalance(sorted)
  const orderIds = [...new Set(lines.flatMap((l) => (l.orderId ? [l.orderId] : [])))]
  return {
    lines,
    debits,
    credits,
    balance: debits - credits,
    due: {
      room: Math.max(0, partBalance(lines, 'room')),
      orders: orderIds.map((orderId) => ({ orderId, amount: lines.filter((l) => l.orderId === orderId).reduce((s, l) => s + l.debit - l.credit, 0) })).filter((o) => o.amount > 0),
      charges: Math.max(0, partBalance(lines, 'charges')),
    },
    depositHeld: lines.reduce((s, l) => s + l.memo, 0),
  }
}

/** Everything the guest still owes: the room balance, each unpaid order and the open charges. A credit on one part never pays another. */
export const folioOwed = (f: Pick<GuestFolio, 'due'>) => f.due.room + f.due.orders.reduce((s, o) => s + o.amount, 0) + f.due.charges

export const filterFolio = <T extends FolioLine>(lines: readonly T[], kind: FolioKind | '') => (kind ? lines.filter((l) => l.kind === kind) : [...lines])
