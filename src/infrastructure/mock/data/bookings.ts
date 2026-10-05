import type { BlockReason, BookingSource, BookingStatus, UnitMovement } from '@/domain/booking'

/**
 * Each unit's stays, written as a plan around today. Tokens: `a4` an Airbnb stay of 4 nights,
 * `d3` a direct stay of 3 nights, `-2` two empty nights. `before` ends at today (or at the
 * start of `now`), `now` is the stay in progress as [daysAgo, nights], `after` starts where
 * `now` ends (or today). So a unit whose `after` opens with a stay has an arrival today, and one
 * whose `before` closes with a stay has a departure today.
 */
export interface UnitPlan {
  unit: string
  before: string
  now?: readonly [daysAgo: number, nights: number]
  after: string
}

export const UNIT_PLANS: readonly UnitPlan[] = [
  { unit: 'SK-01', before: 'a4 -1 d3 -2 a5 -1 a2 -3 d4 -1 a3 -2 a6 -1 d2 -2 a4 -1 a3 -3 d5 -1 a4 -2 a3 -1 d4 -2 a3 -1 a5 -2 a4 -1', after: 'a4 -1 d3 -2 a5 -1 a2 -3 d4' },
  { unit: 'SK-02', before: '-2 a3 -1 a5 -2 d4 -1 a3 -3 a6 -1 d2 -2 a4 -2 a3 -1 d5 -1 a4 -2 a2 -1 d4 -3 a5 -1 a4 -2 d3 -1 a3', after: '-2 a4 -1 d3 -2 a5 -1 a3' },
  { unit: 'SK-03', before: '-1 a5 -2 d3 -1 a4 -2 a3 -1 d6 -2 a4 -1 a2 -3 a5 -1 d3 -2 a4 -1 a3 -2 d4 -1 a5 -3 a2 -1 d4 -2 a4', after: '-7 a3 -1 d4 -2 a3 -1 a5' },
  { unit: 'SK-04', before: 'a3 -2 d4 -1 a5 -2 a3 -1 d2 -3 a4 -1 a6 -2 d3 -1 a4 -2 a3 -1 d5 -2 a4 -1 a2 -3 d4 -1 a5 -2 a3 -1', now: [2, 5], after: '-1 a3 -2 d4 -1 a4 -2 a3' },
  { unit: 'SK-05', before: '-3 a4 -1 d3 -2 a5 -1 a3 -3 d4 -1 a6 -2 a3 -1 d2 -2 a4 -1 a5 -3 d3 -1 a4 -2 a3 -1 d4 -2 a5 -1 a3 -2', after: '-6 a3 -2 d5 -1 a4' },
  { unit: 'SK-06', before: '-2 d4 -1 a5 -2 a3 -1 d6 -2 a4 -1 a2 -3 d5 -1 a4 -2 a3 -1 d4 -2 a5 -1 a3 -3 d2 -1 a4 -2 a5 -1 d3', after: '-6 a5 -2 a3 -1 d4 -2 a3' },
  { unit: 'SK-07', before: 'a5 -1 d3 -2 a4 -1 a3 -3 d5 -1 a4 -2 a6 -1 d2 -2 a3 -1 a4 -3 d4 -1 a5 -2 a3 -1 d4 -2 a3 -1 a4 -2', now: [5, 8], after: '-2 a4 -1 a3 -2 d5' },
  { unit: 'SK-08', before: '-1 a4 -2 d5 -1 a3 -2 a4 -1 d3 -3 a5 -1 a2 -2 d4 -1 a6 -2 a3 -1 d5 -2 a4 -1 a3 -3 d4 -1 a5 -2 a3 -1', now: [1, 4], after: '-1 a3 -1 a5 -2 d3 -1 a4' },
  { unit: 'TR-01', before: 'a6 -2 d4 -1 a5 -3 a3 -1 d7 -2 a4 -1 a5 -2 d3 -3 a6 -1 a4 -2 d5 -1 a3 -2 a6 -1 d4 -3 a5 -1', after: 'a5 -1 d3 -2 a4 -1 a6' },
  { unit: 'TR-02', before: '-1 a5 -2 d6 -1 a4 -3 a7 -1 d3 -2 a5 -1 a4 -3 d6 -2 a3 -1 a5 -2 d4 -1 a6 -3 a4 -1 d5 -2 a4', after: '-1 a4 -2 a3 -1 d5 -2 a4' },
  { unit: 'TR-03', before: '-2 d3 -1 a4 -2 a2 -3 d5 -1 a3 -2 a4 -1 d2 -3 a5 -2 a3 -1 d4 -2 a3 -3 a4 -1 d3 -2 a5 -1 a2 -2 d4 -1', now: [3, 6], after: '-3 a3 -7 a4 -1 d5' },
  { unit: 'TR-04', before: 'a3 -2 d4 -1 a2 -3 a5 -1 d3 -2 a4 -1 a3 -3 d5 -2 a2 -1 a4 -2 d3 -1 a5 -3 a3 -1 d4 -2 a4 -1 d6 -1', after: '-1 d3 -2 a4 -1 a3 -2 d4' },
  { unit: 'LB-01', before: '-1 a4 -2 d3 -1 a5 -2 a3 -3 d4 -1 a6 -1 a2 -2 d5 -1 a4 -2 a3 -3 d4 -1 a5 -2 a4 -1 d3 -2 a5 -1 a3 -2', now: [2, 3], after: '-2 a4 -1 d3 -2 a5' },
  { unit: 'LB-02', before: 'a5 -1 d4 -2 a3 -1 a6 -3 d2 -1 a4 -2 a5 -1 d3 -2 a4 -3 a3 -1 d5 -2 a4 -1 a2 -2 d6 -1 a3 -3 a4 -1', now: [1, 6], after: '-9 a3 -1 d4 -2 a3' },
  { unit: 'LB-03', before: '-2 a3 -1 d5 -2 a4 -1 a6 -3 d3 -1 a4 -2 a5 -1 d2 -2 a4 -3 a3 -1 d5 -2 a4 -1 a3 -2 d4 -1 a5 -3 a2 -1', after: 'd3 -1 a4 -2 a5 -1 a3 -2 d4' },
  { unit: 'LB-04', before: '-1 d4 -2 a5 -1 a3 -3 d6 -1 a4 -2 a2 -1 d5 -2 a4 -3 a3 -1 d4 -2 a5 -1 a4 -2 d3 -3 a5 -1 a3 -2 d4', after: '-1 a4 -1 a3 -2 d5 -1 a4' },
  { unit: 'KR-01', before: '-3 a6 -2 d5 -1 a7 -3 a4 -2 d6 -1 a5 -3 a6 -2 d4 -1 a7 -3 a5 -2 d6 -1 a4 -2 a6 -3 d5 -2 a5', after: '-2 a5 -1 d4 -2 a6' },
  { unit: 'KR-02', before: 'a7 -2 d5 -3 a6 -1 a4 -2 d7 -3 a5 -1 a6 -2 d4 -3 a7 -1 a5 -2 d6 -3 a4 -1 a6 -2 d5 -3 a6 -2', after: 'a6 -2 a4 -1 d5 -2 a4' },
  { unit: 'KR-03', before: '-2 d6 -1 d5 -3 d7 -2 d4 -1 d6 -3 d5 -2 d7 -1 d4 -3 d6 -2 d5 -1 d7 -3 d4 -2 d6 -1', now: [4, 7], after: '-2 d5 -1 d4 -2 d6' },
  { unit: 'PD-01', before: 'd5 -4 d6 -3 d7 -41', after: '' },
]

export interface Token {
  source: BookingSource | 'gap'
  nights: number
}

export function parsePlan(plan: string): Token[] {
  return plan
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => {
      const m = /^([ad-])(\d+)$/.exec(token)
      if (!m) throw new Error(`Bad plan token "${token}"`)
      return { source: m[1] === 'a' ? 'airbnb' : m[1] === 'd' ? 'direct' : 'gap', nights: Number(m[2]) }
    })
}

export interface PlannedStay {
  unitCode: string
  /** Days from today; negative is the past. */
  startOffset: number
  nights: number
  source: BookingSource
  /** Position of the unit in UNIT_PLANS and of the stay in the unit, for guest rotation. */
  unitIndex: number
  stayIndex: number
}

const walk = (tokens: Token[], start: number) => {
  const stays: Array<{ startOffset: number; nights: number; source: BookingSource }> = []
  let cursor = start
  for (const t of tokens) {
    if (t.source !== 'gap') stays.push({ startOffset: cursor, nights: t.nights, source: t.source })
    cursor += t.nights
  }
  return stays
}

/** Turns every plan into concrete stays with day offsets. Stays never overlap inside a unit. */
export function expandPlans(plans: readonly UnitPlan[]): PlannedStay[] {
  return plans.flatMap((plan, unitIndex) => {
    const before = parsePlan(plan.before)
    const anchor = plan.now ? -plan.now[0] : 0
    const length = before.reduce((s, t) => s + t.nights, 0)
    const stays = walk(before, anchor - length)
    if (plan.now) stays.push({ startOffset: -plan.now[0], nights: plan.now[1], source: 'airbnb' })
    const afterStart = plan.now ? -plan.now[0] + plan.now[1] : 0
    stays.push(...walk(parsePlan(plan.after), afterStart))
    return stays.map((s, stayIndex) => ({ unitCode: plan.unit, unitIndex, stayIndex, ...s }))
  })
}

/** Bookings the plans cannot express: a swap, a late arrival, a draft and a cancellation. */
export interface ExtraBooking {
  id: string
  code: string
  guestId: string
  unitCode: string
  requestedUnitCode: string
  source: BookingSource
  airbnbAccountId: string | null
  airbnbCode: string | null
  startOffset: number
  nights: number
  status: BookingStatus
  notes: string
  movements: ReadonlyArray<Omit<UnitMovement, 'on' | 'fromUnitId' | 'toUnitId'> & { fromUnitCode: string; toUnitCode: string; onOffset: number }>
}

export const EXTRA_BOOKINGS: readonly ExtraBooking[] = [
  {
    id: 'bk-2001',
    code: 'BK-2001',
    guestId: 'g-05',
    unitCode: 'SK-05',
    requestedUnitCode: 'SK-03',
    source: 'airbnb',
    airbnbAccountId: 'acc-saka-stays',
    airbnbCode: 'HMK3T7Q2',
    startOffset: 2,
    nights: 3,
    status: 'confirmed',
    notes: 'Guest booked SK-03; moved before arrival because the pool pump is being replaced.',
    movements: [{ fromUnitCode: 'SK-03', toUnitCode: 'SK-05', onOffset: -1, reason: 'Pool pump replacement in SK-03' }],
  },
  {
    id: 'bk-2002',
    code: 'BK-2002',
    guestId: 'g-19',
    unitCode: 'SK-05',
    requestedUnitCode: 'SK-05',
    source: 'direct',
    airbnbAccountId: null,
    airbnbCode: null,
    startOffset: -1,
    nights: 2,
    status: 'confirmed',
    notes: 'Flight from Singapore delayed; guest arrives tonight.',
    movements: [],
  },
  {
    id: 'bk-2003',
    code: 'BK-2003',
    guestId: 'g-11',
    unitCode: 'TR-03',
    requestedUnitCode: 'TR-03',
    source: 'direct',
    airbnbAccountId: null,
    airbnbCode: null,
    startOffset: 12,
    nights: 4,
    status: 'draft',
    notes: 'Waiting for the deposit transfer before confirming.',
    movements: [],
  },
  {
    id: 'bk-2004',
    code: 'BK-2004',
    guestId: 'g-16',
    unitCode: 'LB-01',
    requestedUnitCode: 'LB-01',
    source: 'airbnb',
    airbnbAccountId: 'acc-bali-escapes',
    airbnbCode: 'HMZ8R1P4',
    startOffset: 3,
    nights: 3,
    status: 'cancelled',
    notes: 'Cancelled by the guest 9 days before arrival; Airbnb refunded in full.',
    movements: [],
  },
]

export interface BlockSeed {
  id: string
  unitCode: string
  fromOffset: number
  toOffset: number
  reason: BlockReason
  note: string
}

export const BLOCKS: readonly BlockSeed[] = [
  { id: 'blk-1', unitCode: 'SK-03', fromOffset: 1, toOffset: 6, reason: 'maintenance', note: 'Pool pump replacement' },
  { id: 'blk-2', unitCode: 'LB-02', fromOffset: 10, toOffset: 14, reason: 'owner', note: 'Owner family stay' },
  { id: 'blk-3', unitCode: 'TR-04', fromOffset: -1, toOffset: 1, reason: 'cleaning', note: 'Deep clean after a six-night stay' },
]
