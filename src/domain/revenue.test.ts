import { describe, expect, it } from 'vitest'
import type { BookingStatus } from './booking'
import { budgetRoomRevenue, covers, dailyStats, EMPTY_BUDGET_MONTH, historyStart, onBooksAsOf, paceMonth, roomStats, segmentOf, spreadEvenly, validateBudget, variance, type Segment, type StayFact } from './revenue'

const stay = (segment: Segment, status: BookingStatus, checkIn: string, checkOut: string, rate: number, createdOn: string): StayFact => {
  const nights = Math.round((Date.parse(checkOut) - Date.parse(checkIn)) / 86_400_000)
  return { segment, status, checkIn, checkOut, createdOn, listRates: Array.from({ length: nights }, () => rate), rateOverride: null, discount: null }
}

/** Two units over 1 to 10 October, one unit blocked on the 5th and 6th. */
const STAYS: StayFact[] = [
  stay('airbnb', 'checked_out', '2026-10-01', '2026-10-04', 100, '2026-09-20'),
  stay('direct', 'checked_out', '2026-10-04', '2026-10-09', 200, '2026-10-01'),
  stay('corporate', 'confirmed', '2026-10-09', '2026-10-13', 150, '2026-10-02'),
  stay('direct', 'cancelled', '2026-10-06', '2026-10-08', 300, '2026-09-30'),
  stay('direct', 'no_show', '2026-10-10', '2026-10-12', 120, '2026-10-05'),
  stay('direct', 'draft', '2026-10-02', '2026-10-03', 500, '2026-10-01'),
  stay('airbnb', 'checked_out', '2026-09-28', '2026-10-02', 80, '2026-09-01'),
]
const BLOCKS = [{ from: '2026-10-05', to: '2026-10-07' }]

describe('revenue statistics', () => {
  const s = roomStats(STAYS, 2, BLOCKS, '2026-10-01', '2026-10-11')

  it('counts rooms available as unit nights less blocked nights', () => {
    expect(s.unitNights).toBe(20)
    expect(s.blockedNights).toBe(2)
    expect(s.available).toBe(18)
  })

  it('sells the nights of every stay that earns, no-shows included, drafts and cancellations not', () => {
    expect(s.sold).toBe(3 + 5 + 2 + 1 + 1)
    expect(s.revenue).toBe(300 + 1000 + 300 + 120 + 80)
  })

  it('derives occupancy, ADR and RevPAR', () => {
    expect(s.occupancy).toBeCloseTo(12 / 18)
    expect(s.adr).toBe(150)
    expect(s.revpar).toBe(100)
  })

  it('averages length of stay and lead time over the stays due in the range', () => {
    expect(s.arrivals).toBe(3)
    expect(s.alos).toBe((3 + 5 + 4) / 3)
    expect(s.leadTime).toBe((11 + 3 + 7 + 5) / 4)
  })

  it('rates cancellations over bookings due, no-shows over the arrivals still expected', () => {
    expect(s.cancellations).toBe(1)
    expect(s.cancellationRate).toBe(1 / 5)
    expect(s.noShows).toBe(1)
    expect(s.noShowRate).toBe(1 / 4)
  })

  it('splits nights and revenue by segment', () => {
    expect(s.mix).toEqual({ airbnb: { nights: 4, revenue: 380 }, direct: { nights: 6, revenue: 1120 }, corporate: { nights: 2, revenue: 300 } })
    expect(segmentOf({ source: 'direct' }, 'corporate')).toBe('corporate')
    expect(segmentOf({ source: 'direct' }, 'direct')).toBe('direct')
    expect(segmentOf({ source: 'airbnb' }, null)).toBe('airbnb')
  })

  it('gives one row per day', () => {
    const days = dailyStats(STAYS, 2, BLOCKS, '2026-10-01', '2026-10-11')
    expect(days).toHaveLength(10)
    const fifth = days.find((d) => d.date === '2026-10-05')
    expect(fifth?.available).toBe(1)
    expect(fifth?.sold).toBe(1)
    expect(fifth?.occupancy).toBe(1)
  })

  it('divides by nothing safely', () => {
    const empty = roomStats([], 0, [], '2026-10-01', '2026-10-02')
    expect([empty.occupancy, empty.adr, empty.revpar, empty.alos, empty.leadTime, empty.cancellationRate, empty.noShowRate]).toEqual([0, 0, 0, 0, 0, 0, 0])
  })

  it('knows how far the records reach back', () => {
    expect(historyStart(STAYS)).toBe('2026-09-28')
    expect(covers('2026-09-28', '2025-10-01')).toBe(false)
    expect(covers('2026-09-28', '2026-10-01')).toBe(true)
    expect(covers(null, '2026-10-01')).toBe(false)
  })
})

describe('pace and forecast', () => {
  it('counts what was on the books on a given day', () => {
    expect(onBooksAsOf(STAYS, '2026-10-01', '2026-11-01', '2026-10-01')).toEqual({ nights: 3 + 5 + 1, revenue: 300 + 1000 + 80 })
  })

  it('compares with last month at the same lead and forecasts from the trailing pickup', () => {
    const stays = [
      stay('direct', 'checked_out', '2026-10-03', '2026-10-08', 100, '2026-09-01'),
      stay('direct', 'checked_out', '2026-10-20', '2026-10-26', 100, '2026-10-18'),
      stay('airbnb', 'checked_out', '2026-09-20', '2026-09-23', 100, '2026-09-19'),
      stay('direct', 'confirmed', '2026-11-20', '2026-11-24', 200, '2026-11-01'),
    ]
    const p = paceMonth({ stays, units: 1, blocks: [], today: '2026-11-16', start: '2026-08-01' }, '2026-11')
    expect(p.available).toBe(30)
    expect(p.onBooks).toEqual({ nights: 4, revenue: 800 })
    // October as of 16 October held the early stay only.
    expect(p.lastMonthSameLead).toEqual({ nights: 5, revenue: 500 })
    expect(p.pace).toBeCloseTo(-0.2)
    // 15 days before month end, October picked up 6 nights and September 3, over 92 available nights.
    expect(p.pickupRate).toBeCloseTo(9 / 92)
    expect(p.forecast).toEqual({ nights: 7, revenue: 800 + 3 * 100 })
    expect(p.forecastOccupancy).toBeCloseTo(7 / 30)
  })

  it('never forecasts past the available nights', () => {
    const full = [stay('direct', 'checked_out', '2026-10-01', '2026-11-01', 100, '2026-10-30'), stay('direct', 'confirmed', '2026-11-01', '2026-11-29', 100, '2026-11-01')]
    const p = paceMonth({ stays: full, units: 1, blocks: [], today: '2026-11-02', start: '2026-10-01' }, '2026-11')
    expect(p.forecast.nights).toBe(30)
  })
})

describe('budget', () => {
  it('spreads a total into whole months that add back to it', () => {
    const parts = spreadEvenly(100)
    expect(parts).toEqual([9, 9, 9, 9, 8, 8, 8, 8, 8, 8, 8, 8])
    expect(parts.reduce((a, b) => a + b, 0)).toBe(100)
  })

  it('prices room revenue from nights and ADR', () => {
    expect(budgetRoomRevenue({ ...EMPTY_BUDGET_MONTH, roomNights: 12, adr: 1_500_000 })).toBe(18_000_000)
  })

  it('refuses negative or fractional figures and a short year', () => {
    const months = Array.from({ length: 12 }, () => ({ ...EMPTY_BUDGET_MONTH }))
    expect(validateBudget({ villaId: 'vil-saka', year: 2026, months })).toEqual({})
    const bad = months.map((m, i) => (i === 2 ? { ...m, adr: -1, roomNights: 1.5 } : m))
    expect(validateBudget({ villaId: 'vil-saka', year: 2026, months: bad })).toEqual({ 'months.2.adr': 'ADR: a whole number, zero or more.', 'months.2.roomNights': 'Room nights: a whole number, zero or more.' })
    expect(validateBudget({ villaId: '', year: 2026, months: months.slice(1) })).toMatchObject({ villaId: 'Pick a villa.', months: 'A budget has twelve months.' })
  })

  it('signs the variance and says which way helps profit', () => {
    expect(variance(110, 100)).toEqual({ budget: 100, actual: 110, amount: 10, pct: 0.1, good: true })
    expect(variance(110, 100, true)).toMatchObject({ amount: 10, good: false })
    expect(variance(90, 100, true)).toMatchObject({ amount: -10, pct: -0.1, good: true })
    expect(variance(5, 0)).toMatchObject({ pct: null, good: true })
    expect(variance(100, 100).good).toBeNull()
  })
})
