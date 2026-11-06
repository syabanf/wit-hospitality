import { describe, expect, it } from 'vitest'
import type { Booking } from './booking'
import { filterFolio, folioOwed, folioSide, guestFolio, rebateBeyondLimit, rebateTarget, refundable, validateCharge, validateRebate, type FolioPosting } from './folio'
import type { Payment } from './payment'
import type { ServiceOrder } from './serviceOrder'
import { DEFAULT_TRANSACTION_CODES } from './transactionCode'

const booking = (over: Partial<Booking> = {}): Booking => ({
  id: 'b1',
  code: 'BK-1',
  guestId: 'g1',
  unitId: 'u1',
  unitAssigned: true,
  requestedUnitId: 'u1',
  source: 'direct',
  airbnbAccountId: null,
  airbnbCode: null,
  checkIn: '2026-10-05',
  checkOut: '2026-10-08',
  listRates: [1_000_000, 1_200_000, 1_000_000],
  rateOverride: null,
  discount: null,
  priceSetBy: null,
  status: 'checked_in',
  notes: '',
  paymentStatus: 'partial',
  paidAmount: 0,
  airbnbFee: 0,
  movements: [],
  createdOn: '2026-09-20',
  checkedInOn: '2026-10-05',
  checkedOutOn: null,
  arrival: { idVerified: true, deposit: 500_000, keysHanded: true, rulesExplained: true, arrivalTime: '14:00', adults: 2, children: 0, notes: '' },
  departure: null,
  ...over,
})
const payment = (over: Partial<Payment>): Payment => ({
  id: 'p1',
  number: 'PAY-1',
  bookingId: 'b1',
  kind: 'deposit',
  method: 'cash',
  amount: 1_000_000,
  status: 'paid',
  dueOn: null,
  paidOn: '2026-09-20',
  reference: '',
  payer: '',
  note: '',
  transactionId: null,
  feeTransactionId: null,
  gatewayFee: 0,
  refundOf: null,
  createdBy: 'Dian',
  createdOn: '2026-09-20',
  history: [],
  ...over,
})
const order = (over: Partial<ServiceOrder>): ServiceOrder => ({
  id: 'so-1',
  number: 'SO-701',
  bookingId: 'b1',
  unitId: 'u1',
  villaId: 'v1',
  lines: [
    { itemId: 'mi-1', name: 'Nasi goreng', category: 'food', unit: 'item', price: 100_000, quantity: 2, costPrice: 0, partnerId: null, comp: false },
    { itemId: 'mi-2', name: 'Flowers', category: 'extras', unit: 'item', price: 50_000, quantity: 1, costPrice: 0, partnerId: null, comp: true },
  ],
  note: '',
  requestedOn: '2026-10-06',
  requestedAt: 12 * 60,
  priority: 'normal',
  status: 'delivered',
  assignee: 'Wayan',
  placedBy: 'staff',
  createdOn: '2026-10-06',
  deliveredOn: '2026-10-06',
  deliveredAt: 12 * 60 + 15,
  discountPct: 10,
  discountReason: 'Returning guest',
  compReason: 'Anniversary',
  paymentId: null,
  costTransactionIds: [],
  history: [],
  ...over,
})
const posting = (over: Partial<FolioPosting>): FolioPosting => ({
  id: 'fp-1',
  bookingId: 'b1',
  kind: 'charge',
  code: 'MINI',
  description: '2 × Bintang',
  amount: 150_000,
  date: '2026-10-06',
  part: 'charges',
  lineId: null,
  orderId: null,
  postedBy: 'Wayan',
  postedById: 'usr-wayan',
  postedAt: '2026-10-06T21:00:00',
  approvedBy: null,
  transactionId: null,
  ...over,
})

describe('guest folio', () => {
  it('takes the side of every line from its kind', () => {
    expect(folioSide('room')).toBe('debit')
    expect(folioSide('refund')).toBe('debit')
    expect(folioSide('rebate')).toBe('credit')
    expect(folioSide('payment')).toBe('credit')
    expect(folioSide('deposit')).toBe('memo')
  })

  it('posts one line per night, the discount, room service with its free items, charges and payments, and keeps the deposit out of the balance', () => {
    const b = booking({ discount: { kind: 'amount', value: 200_000, per: 'stay', reason: 'Long weekend' } })
    const f = guestFolio({
      booking: b,
      payments: [payment({}), payment({ id: 'p2', number: 'PAY-2', status: 'pending', amount: 2_000_000 })],
      orders: [order({})],
      postings: [posting({}), posting({ id: 'fp-2', kind: 'rebate', lineId: 'fp-1', description: 'Fridge was warm', amount: 50_000, postedAt: '2026-10-06T22:00:00' })],
    })
    expect(f.lines.filter((l) => l.kind === 'room').map((l) => l.debit)).toEqual([1_000_000, 1_200_000, 1_000_000])
    expect(f.lines.find((l) => l.kind === 'discount' && l.part === 'room')?.credit).toBe(200_000)
    // One line per transaction code: the food on FNB, the flowers on XTRA and on the house.
    expect(f.lines.filter((l) => l.kind === 'room_service').map((l) => [l.code, l.debit])).toEqual([['FNB', 200_000], ['XTRA', 50_000]])
    expect(f.lines.find((l) => l.kind === 'comp')).toMatchObject({ code: 'XTRA', credit: 50_000 })
    expect(f.lines.find((l) => l.kind === 'discount' && l.part === 'orders')).toMatchObject({ code: 'FNB', credit: 20_000 })
    expect(f.lines.filter((l) => l.kind === 'room').every((l) => l.code === 'ROOM')).toBe(true)
    expect(f.lines.find((l) => l.kind === 'payment')?.code).toBe('CASH')
    expect(f.lines.find((l) => l.kind === 'deposit')).toMatchObject({ debit: 0, credit: 0, memo: 500_000 })
    expect(f.depositHeld).toBe(500_000)
    // A pending payment is no money yet.
    expect(f.lines.filter((l) => l.kind === 'payment')).toHaveLength(1)
    expect(f.due).toEqual({ room: 2_000_000, orders: [{ orderId: 'so-1', amount: 180_000 }], charges: 100_000 })
    expect(f.balance).toBe(f.debits - f.credits)
    expect(f.balance).toBe(folioOwed(f))
    expect(f.lines.at(-1)?.balance).toBe(f.balance)
    expect(filterFolio(f.lines, 'charge')).toHaveLength(1)
  })

  it('credits each paid order, nets refunds against the room and shows charges taken at check-out', () => {
    const b = booking({ status: 'checked_out', checkedOutOn: '2026-10-08', departure: { depositReturned: 500_000, extraCharges: 75_000, roomInspected: true, keysReturned: true, notes: 'Late check-out' } })
    const f = guestFolio({
      booking: b,
      payments: [payment({ amount: 3_200_000 }), payment({ id: 'p3', number: 'PAY-3', kind: 'refund', amount: 100_000, paidOn: '2026-10-07' }), payment({ id: 'p4', number: 'PAY-4', kind: 'extra', amount: 180_000, orderIds: ['so-1'], paidOn: '2026-10-06' })],
      orders: [order({ paymentId: 'p4' })],
      postings: [posting({ transactionId: 'tx-9' })],
    })
    expect(f.due).toEqual({ room: 100_000, orders: [], charges: 0 })
    expect(f.lines.filter((l) => l.kind === 'payment' && l.part === 'charges').map((l) => l.credit).sort()).toEqual([150_000, 75_000])
    expect(f.lines.find((l) => l.memo < 0)?.memo).toBe(-500_000)
  })

  it('bills the room of an Airbnb stay to Airbnb and keeps the payout off the guest’s folio', () => {
    const f = guestFolio({ booking: booking({ source: 'airbnb', airbnbFee: 90_000 }), payments: [payment({ kind: 'payout', method: 'airbnb_payout', amount: 3_110_000 })], orders: [], postings: [posting({})] })
    expect(f.lines.find((l) => l.kind === 'channel')?.credit).toBe(3_200_000)
    expect(f.lines.some((l) => l.ref.type === 'payment')).toBe(false)
    expect(f.due).toEqual({ room: 0, orders: [], charges: 150_000 })
  })

  it('leaves nothing owed on a cancelled stay: what was kept balances what was paid', () => {
    const f = guestFolio({ booking: booking({ status: 'cancelled' }), payments: [payment({ status: 'refunded' }), payment({ id: 'p2', kind: 'refund', amount: 700_000 })], orders: [], postings: [] })
    expect(f.lines.find((l) => l.kind === 'room')?.debit).toBe(300_000)
    expect(f.balance).toBe(0)
  })

  it('checks charges and rebates, and holds rebates past the discount limit share of the line for approval', () => {
    expect(validateCharge({ code: 'ROOM', description: '', amount: 0 }, DEFAULT_TRANSACTION_CODES)).toMatchObject({ code: expect.any(String), description: expect.any(String), amount: expect.any(String) })
    const f = guestFolio({ booking: booking({}), payments: [], orders: [order({})], postings: [posting({ amount: 500_000 })] })
    const charge = rebateTarget(f.lines, 'fp-1')
    expect(charge).toMatchObject({ net: 500_000, open: 500_000 })
    expect(validateRebate({ lineId: 'fp-1', amount: 600_000, reason: 'Noise' }, charge)).toMatchObject({ amount: expect.any(String) })
    expect(validateRebate({ lineId: 'fp-1', amount: 50_000, reason: '' }, charge)).toMatchObject({ reason: expect.any(String) })
    expect(validateRebate({ lineId: 'so-1-FNB-comp', amount: 50_000, reason: 'Noise' }, rebateTarget(f.lines, 'so-1-FNB-comp'))).toMatchObject({ lineId: expect.any(String) })
    if (!charge) throw new Error('no target')
    expect(rebateBeyondLimit(charge, 50_000, 10)).toBe(false)
    expect(rebateBeyondLimit(charge, 60_000, 10)).toBe(true)
    // Room service on FNB is net of its 10% discount: 180,000 is what a rebate can take off.
    expect(rebateTarget(f.lines, 'so-1-FNB')).toMatchObject({ net: 180_000, open: 180_000 })
  })

  it('posts a rebate on the line’s code and part, and owes a refund once it falls after the payment', () => {
    const paid = payment({ id: 'p4', number: 'PAY-4', kind: 'extra', amount: 180_000, orderIds: ['so-1'], paidOn: '2026-10-06' })
    const rebate = posting({ id: 'fp-2', kind: 'rebate', code: 'FNB', part: 'orders', lineId: 'so-1-FNB', orderId: 'so-1', amount: 60_000, description: 'Cold food' })
    const f = guestFolio({ booking: booking({}), payments: [paid], orders: [order({ paymentId: 'p4' })], postings: [rebate] })
    expect(f.lines.find((l) => l.id === 'fp-2')).toMatchObject({ kind: 'rebate', code: 'FNB', part: 'orders', orderId: 'so-1', of: 'so-1-FNB', credit: 60_000 })
    expect(rebateTarget(f.lines, 'so-1-FNB')).toMatchObject({ rebated: 60_000, open: 120_000 })
    expect(f.refundDue).toBe(60_000)
    expect(refundable(f, paid, 0)).toBe(60_000)
    const back = payment({ id: 'p5', number: 'PAY-5', kind: 'refund', amount: 60_000, orderIds: ['so-1'], refundOf: 'p4' })
    const after = guestFolio({ booking: booking({}), payments: [paid, back], orders: [order({ paymentId: 'p4' })], postings: [rebate] })
    expect(after.lines.find((l) => l.kind === 'refund')).toMatchObject({ part: 'orders', orderId: 'so-1', debit: 60_000 })
    expect(after.refundDue).toBe(0)
  })
})
