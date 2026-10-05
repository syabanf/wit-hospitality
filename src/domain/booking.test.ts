import { describe, expect, it } from 'vitest'
import {
  canTransition,
  filterBookings,
  findConflicts,
  lifecycleSteps,
  nextStep,
  nightState,
  occupancy,
  overlaps,
  revenueBetween,
  validateStay,
  type Booking,
  type UnitBlock,
} from './booking'
import type { Unit } from './property'

const unit: Unit = { id: 'u1', villaId: 'v1', groupId: null, code: 'SK-01', name: 'Saka 1', bedrooms: 1, nightlyRate: 1_000_000, status: 'active', amenities: [] }
const booking = (over: Partial<Booking> = {}): Booking => ({
  id: 'b1',
  code: 'BK-1',
  guestId: 'g1',
  unitId: 'u1',
  requestedUnitId: 'u1',
  source: 'direct',
  airbnbAccountId: null,
  airbnbCode: null,
  checkIn: '2026-10-05',
  checkOut: '2026-10-08',
  nightlyRate: 1_000_000,
  status: 'confirmed',
  notes: '',
  movements: [],
  createdOn: '2026-09-20',
  checkedInOn: null,
  checkedOutOn: null,
  arrival: null,
  departure: null,
  ...over,
})
const block: UnitBlock = { id: 'k1', unitId: 'u1', from: '2026-10-10', to: '2026-10-12', reason: 'maintenance', note: 'Pump' }

describe('booking rules', () => {
  it('treats a same-day check-out and check-in as free', () => {
    expect(overlaps('2026-10-01', '2026-10-05', '2026-10-05', '2026-10-08')).toBe(false)
    expect(overlaps('2026-10-01', '2026-10-06', '2026-10-05', '2026-10-08')).toBe(true)
  })

  it('finds held nights from live bookings and blocks, ignoring drafts and the booking itself', () => {
    const list = [booking(), booking({ id: 'b2', code: 'BK-2', status: 'draft', checkIn: '2026-10-09', checkOut: '2026-10-11' })]
    expect(findConflicts('u1', '2026-10-06', '2026-10-11', list, [block]).map((c) => c.label)).toEqual(['BK-1', 'Maintenance'])
    expect(findConflicts('u1', '2026-10-06', '2026-10-07', list, [block], 'b1')).toEqual([])
  })

  it('validates a stay', () => {
    expect(validateStay('2026-10-05', '2026-10-05')).toMatch(/after/)
    expect(validateStay('2026-10-05', '2027-02-05')).toMatch(/90/)
    expect(validateStay('2026-10-05', '2026-10-06')).toBeNull()
  })

  it('walks the lifecycle one step at a time', () => {
    expect(nextStep({ status: 'draft' })).toBe('confirmed')
    expect(nextStep({ status: 'checked_in' })).toBe('checked_out')
    expect(nextStep({ status: 'checked_out' })).toBeNull()
    expect(canTransition({ status: 'checked_in' }, 'cancelled')).toBe(false)
    expect(canTransition({ status: 'confirmed' }, 'cancelled')).toBe(true)
  })

  it('marks a missed arrival late', () => {
    const steps = lifecycleSteps(booking(), '2026-10-07', (d) => d)
    expect(steps.map((s) => s.state)).toEqual(['done', 'late', 'upcoming', 'upcoming'])
    expect(lifecycleSteps(booking({ status: 'cancelled' }), '2026-10-07', (d) => d).at(-1)?.label).toBe('Cancelled')
  })

  it('reads the night state and the occupancy', () => {
    const list = [booking()]
    expect(nightState(unit, '2026-10-06', list, [block])).toBe('occupied')
    expect(nightState(unit, '2026-10-10', list, [block])).toBe('blocked')
    expect(nightState(unit, '2026-10-09', list, [block])).toBe('free')
    const occ = occupancy([unit], list, [block], '2026-10-01', '2026-10-15')
    expect(occ).toEqual({ unitNights: 14, blockedNights: 2, occupiedNights: 3, rate: 3 / 12 })
    expect(revenueBetween(list, '2026-10-06', '2026-10-20')).toBe(2_000_000)
  })
})

describe('booking date filter', () => {
  const rows = [
    { ...booking(), guestName: 'A', unitCode: 'SK-01' },
    { ...booking({ id: 'b2', checkIn: '2026-10-20', checkOut: '2026-10-22' }), guestName: 'B', unitCode: 'SK-02' },
  ]
  it('keeps stays that touch the range and drops the rest', () => {
    expect(filterBookings(rows, { from: '2026-10-07', to: '2026-10-07' }).map((b) => b.id)).toEqual(['b1'])
    expect(filterBookings(rows, { from: '2026-10-08', to: '2026-10-19' })).toEqual([])
    expect(filterBookings(rows, { from: '2026-10-01' }).map((b) => b.id)).toEqual(['b1', 'b2'])
    expect(filterBookings(rows, { to: '2026-10-19' }).map((b) => b.id)).toEqual(['b1'])
  })
})
