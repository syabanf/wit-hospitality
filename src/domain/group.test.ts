import { describe, expect, it } from 'vitest'
import type { Booking } from './booking'
import { guestFolio } from './folio'
import { allocate, closesGroup, groupClashes, groupStatus, masterFolio, stayPriceChange, validateGroup, type GroupStayInput } from './group'
import type { Payment } from './payment'
import { buildCatalog, type Unit } from './property'

const unit = (code: string, groupId: string | null): Unit => ({ id: `unit-${code}`, villaId: 'vil-a', groupId, code, name: code, bedrooms: 1, nightlyRate: 1_000_000, status: 'active', amenities: [] })
const catalog = buildCatalog(
  [{ id: 'loc-a', name: 'A', area: 'A' }],
  [{ id: 'vil-a', locationId: 'loc-a', code: 'VA', name: 'Villa A', description: '', facilities: [] }],
  [unit('A-01', 'grp-type'), unit('A-02', 'grp-type'), unit('B-01', null)],
  [{ id: 'grp-type', villaId: 'vil-a', name: 'Garden rooms', interchangeable: true, operatorAssigns: true }],
)
const stay = (unitId: string | null, roomTypeId: string | null = null): GroupStayInput => ({ unitId, roomTypeId, checkIn: '2026-11-10', checkOut: '2026-11-13', adults: 2, children: 0, price: null })

const booking = (id: string, fields: Partial<Booking> = {}): Booking => ({
  id,
  code: id.toUpperCase(),
  guestId: 'g-1',
  unitId: 'unit-A-01',
  unitAssigned: true,
  requestedUnitId: 'unit-A-01',
  source: 'direct',
  airbnbAccountId: null,
  airbnbCode: null,
  checkIn: '2026-11-10',
  checkOut: '2026-11-12',
  listRates: [1_000_000, 1_000_000],
  rateOverride: null,
  discount: null,
  priceSetBy: null,
  status: 'checked_in',
  notes: '',
  paymentStatus: 'partial',
  paidAmount: 0,
  airbnbFee: 0,
  movements: [],
  createdOn: '2026-11-01',
  checkedInOn: '2026-11-10',
  nightsPosted: ['2026-11-10'],
  checkedOutOn: null,
  arrival: null,
  departure: null,
  ...fields,
})
const share = (id: string, bookingId: string, amount: number): Payment => ({ id, number: id.toUpperCase(), bookingId, kind: 'deposit', method: 'bank_transfer', amount, status: 'paid', dueOn: null, paidOn: '2026-11-01', reference: 'TRF', payer: '', note: '', transactionId: 'tx-1', feeTransactionId: null, gatewayFee: 0, refundOf: null, groupId: 'bg-1', batch: 'GP-2001', createdBy: 'Kadek', createdOn: '2026-11-01', history: [] })

describe('group', () => {
  it('asks for a name, a lead guest, two stays and a reasoned discount', () => {
    expect(validateGroup({ name: 'Wedding', hasGuest: true, stays: [stay('unit-A-01'), stay('unit-B-01')], discount: null })).toEqual({})
    const errors = validateGroup({ name: 'W', hasGuest: false, stays: [{ ...stay(null), adults: 0 }], discount: { pct: 0, reason: '' } })
    expect(Object.keys(errors).sort()).toEqual(['discount.pct', 'discount.reason', 'guestId', 'name', 'stays', 'stays.0.adults', 'stays.0.unitId'])
  })

  it('gives every stay without a discount of its own the group discount, keeping a staff rate', () => {
    const discount = { pct: 10, reason: 'Wedding party' }
    expect(stayPriceChange(null, discount)?.discount).toMatchObject({ kind: 'percent', value: 10, per: 'stay', reason: 'Group discount: Wedding party' })
    expect(stayPriceChange({ rateOverride: 900_000, discount: null, reason: 'Long stay' }, discount)).toMatchObject({ rateOverride: 900_000, reason: 'Long stay' })
    const own = { rateOverride: null, discount: { kind: 'amount' as const, value: 100_000, per: 'night' as const, reason: 'Honeymoon' }, reason: '' }
    expect(stayPriceChange(own, discount)).toBe(own)
    expect(stayPriceChange(null, null)).toBeNull()
  })

  it('names every unit that clashes, with the seed and inside the group', () => {
    const held = [booking('bk-1', { unitId: 'unit-B-01', status: 'confirmed', checkIn: '2026-11-11', checkOut: '2026-11-14' })]
    expect(groupClashes(catalog, [stay('unit-A-01'), stay('unit-A-02')], held, [])).toEqual([])
    const clashes = groupClashes(catalog, [stay('unit-B-01'), stay('unit-A-01'), stay('unit-A-01')], held, [])
    expect(clashes.map((c) => [c.index, c.label])).toEqual([
      [0, 'B-01'],
      [2, 'A-01'],
    ])
    expect(clashes[1]?.detail).toContain('stay 2 of this group')
  })

  it('counts the room type against the units the group already holds', () => {
    expect(groupClashes(catalog, [stay(null, 'grp-type'), stay(null, 'grp-type')], [], [])).toEqual([])
    const full = groupClashes(catalog, [stay('unit-A-01'), stay(null, 'grp-type'), stay(null, 'grp-type')], [], [])
    expect(full.map((c) => [c.index, c.label])).toEqual([[2, 'Garden rooms']])
  })

  it('splits one payment over the stays in order, each up to what it owes', () => {
    expect(allocate(5_000_000, [{ bookingId: 'a', due: 2_000_000 }, { bookingId: 'b', due: 0 }, { bookingId: 'c', due: 4_000_000 }])).toEqual([
      { bookingId: 'a', amount: 2_000_000 },
      { bookingId: 'c', amount: 3_000_000 },
    ])
  })

  it('reads its status from the stays and knows the last one to leave', () => {
    const stays = [booking('a', { status: 'checked_out' }), booking('b'), booking('c', { status: 'cancelled' })]
    expect(groupStatus(stays)).toBe('in_house')
    expect(closesGroup(stays, 'b')).toBe(true)
    expect(closesGroup(stays, 'a')).toBe(false)
    expect(groupStatus([booking('a', { status: 'cancelled' })])).toBe('cancelled')
    expect(groupStatus([booking('a', { status: 'checked_out' }), booking('b', { status: 'no_show' })])).toBe('checked_out')
  })

  it('moves room lines to the master folio and keeps the bill whole', () => {
    const stays = [booking('a'), booking('b', { unitId: 'unit-A-02', listRates: [1_500_000, 1_500_000] })]
    const payments = [share('p1', 'a', 600_000), share('p2', 'b', 900_000)]
    const orders = [] as const
    const postings = [{ id: 'fp-1', bookingId: 'b', kind: 'charge' as const, code: 'MINI' as const, description: 'Two beers', amount: 120_000, date: '2026-11-11', part: 'charges' as const, lineId: null, orderId: null, postedBy: 'Wayan', postedById: 'usr-wayan', postedAt: '2026-11-11T20:00:00', approvedBy: null, transactionId: null }]
    const whole = stays.map((b) => guestFolio({ booking: b, payments, orders, postings }))
    const own = stays.map((b) => guestFolio({ booking: b, payments, orders, postings, roomOnMaster: true }))
    const master = masterFolio(stays.map((b, i) => ({ booking: b, folio: whole[i] ?? { lines: [] } })), payments)

    expect(own.map((f) => f.due.room)).toEqual([0, 0])
    expect(own[1]?.due.charges).toBe(120_000)
    // The first night of each stay is posted; the second is a forecast that still counts in what the group owes.
    expect([master.debits, master.forecast]).toEqual([2_500_000, 2_500_000])
    // The two shares read as the one payment the group made.
    expect(master.lines.filter((l) => l.kind === 'payment')).toEqual([expect.objectContaining({ credit: 1_500_000, stays: ['A', 'B'] })])
    expect(master.due).toBe(3_500_000)
    // Folio equals bill: the master and the stays' own folios add up to the stays' whole folios.
    const sum = (list: readonly number[]) => list.reduce((s, v) => s + v, 0)
    expect(master.balance + sum(own.map((f) => f.balance))).toBe(sum(whole.map((f) => f.balance)))
  })
})
