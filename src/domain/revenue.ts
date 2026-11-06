import { addDays, addMonths, daysBetween, eachDay, type IsoDate } from '@/lib/dates'
import { chargedBetween, earns, overlapNights, type Booking, type UnitBlock } from './booking'
import { change } from './dashboard'
import { roomKpis } from './performance'

/**
 * Revenue management figures a hotel PMS reports: rooms available and sold, occupancy, ADR,
 * RevPAR, length of stay, lead time, cancellations, no-shows and the source mix, then booking
 * pace, a month-end forecast and budget against actual. Every range here is half-open, [from, to).
 */

/** Market segment: an Airbnb stay, a direct stay booked in a corporate group, or any other direct stay. */
export type Segment = 'direct' | 'airbnb' | 'corporate'
export const SEGMENTS: readonly Segment[] = ['direct', 'airbnb', 'corporate']
export const SEGMENT_LABEL: Record<Segment, string> = { direct: 'Direct', airbnb: 'Airbnb', corporate: 'Corporate' }

export const segmentOf = (b: Pick<Booking, 'source'>, groupSource?: string | null): Segment => (b.source === 'airbnb' ? 'airbnb' : groupSource === 'corporate' ? 'corporate' : 'direct')

/** What the statistics read off a stay. */
export type StayFact = Pick<Booking, 'status' | 'checkIn' | 'checkOut' | 'createdOn' | 'listRates' | 'rateOverride' | 'discount'> & { segment: Segment }

export interface SegmentFigures {
  nights: number
  revenue: number
}

export interface RoomStats {
  /** Active units times days. */
  unitNights: number
  blockedNights: number
  /** Unit nights less blocked nights (maintenance, owner stays, deep cleans). */
  available: number
  /** Nights of stays that earn: everything but drafts and cancellations, like the occupancy report. */
  sold: number
  revenue: number
  occupancy: number
  adr: number
  revpar: number
  /** Stays arriving in the range, cancellations and drafts left out. */
  arrivals: number
  /** Average nights per arriving stay, no-shows left out. */
  alos: number
  /** Average days from booking to arrival for arriving stays. */
  leadTime: number
  cancellations: number
  /** Cancelled over every booking (drafts left out) due to arrive in the range. */
  cancellationRate: number
  noShows: number
  /** No-shows over the arrivals still expected after cancellations. */
  noShowRate: number
  mix: Record<Segment, SegmentFigures>
}

const sum = (list: readonly number[]) => list.reduce((s, v) => s + v, 0)
const avg = (list: readonly number[]) => (list.length ? sum(list) / list.length : 0)

/** The core statistics for `units` active units over [from, to). Pass only the stays and blocks of those units. */
export function roomStats(stays: readonly StayFact[], units: number, blocks: readonly Pick<UnitBlock, 'from' | 'to'>[], from: IsoDate, to: IsoDate): RoomStats {
  const unitNights = units * Math.max(0, daysBetween(from, to))
  const blockedNights = Math.min(unitNights, sum(blocks.map((k) => overlapNights(k.from, k.to, from, to))))
  const available = unitNights - blockedNights
  const earning = stays.filter(earns)
  const nightsOf = (list: readonly StayFact[]) => sum(list.map((b) => overlapNights(b.checkIn, b.checkOut, from, to)))
  const revenueOf = (list: readonly StayFact[]) => sum(list.map((b) => chargedBetween(b, from, to)))
  const sold = nightsOf(earning)
  const revenue = revenueOf(earning)
  const due = stays.filter((b) => b.status !== 'draft' && b.checkIn >= from && b.checkIn < to)
  const cancellations = due.filter((b) => b.status === 'cancelled').length
  const expected = due.filter((b) => b.status !== 'cancelled')
  const noShows = expected.filter((b) => b.status === 'no_show').length
  const arrived = expected.filter((b) => b.status !== 'no_show')
  const mix = Object.fromEntries(SEGMENTS.map((s) => [s, { nights: nightsOf(earning.filter((b) => b.segment === s)), revenue: revenueOf(earning.filter((b) => b.segment === s)) }])) as Record<Segment, SegmentFigures>
  return {
    unitNights,
    blockedNights,
    available,
    sold,
    revenue,
    ...roomKpis(revenue, sold, available),
    arrivals: arrived.length,
    alos: avg(arrived.map((b) => daysBetween(b.checkIn, b.checkOut))),
    leadTime: avg(expected.map((b) => Math.max(0, daysBetween(b.createdOn, b.checkIn)))),
    cancellations,
    cancellationRate: due.length ? cancellations / due.length : 0,
    noShows,
    noShowRate: expected.length ? noShows / expected.length : 0,
    mix,
  }
}

/** One row of statistics per day of [from, to). */
export const dailyStats = (stays: readonly StayFact[], units: number, blocks: readonly Pick<UnitBlock, 'from' | 'to'>[], from: IsoDate, to: IsoDate) =>
  eachDay(from, to).map((date) => ({ date, ...roomStats(stays, units, blocks, date, addDays(date, 1)) }))

/** The first arrival on record, or null with no stays: comparisons before it have no data. */
export const historyStart = (stays: readonly Pick<StayFact, 'status' | 'checkIn'>[]): IsoDate | null =>
  stays.filter((b) => b.status !== 'draft').reduce<IsoDate | null>((first, b) => (first === null || b.checkIn < first ? b.checkIn : first), null)

/** Whether the records reach back to `from`, so a comparison there means something. */
export const covers = (start: IsoDate | null, from: IsoDate) => start !== null && start <= from

/** Room nights and revenue in [from, to) of stays booked by `asOf` that still earn today. */
export function onBooksAsOf(stays: readonly StayFact[], from: IsoDate, to: IsoDate, asOf: IsoDate): SegmentFigures {
  const held = stays.filter((b) => earns(b) && b.createdOn <= asOf)
  return { nights: sum(held.map((b) => overlapNights(b.checkIn, b.checkOut, from, to))), revenue: sum(held.map((b) => chargedBetween(b, from, to))) }
}

export interface PaceMonth {
  month: string
  available: number
  /** What the month holds as of today: stays already had plus stays booked ahead. */
  onBooks: SegmentFigures
  /** What last month held the same number of days before it, for pace. */
  lastMonthSameLead: SegmentFigures
  /** Room nights against last month at the same lead; null when last month had none. */
  pace: number | null
  /** Room nights picked up per available night in the trailing months at this lead. */
  pickupRate: number
  forecast: SegmentFigures
  forecastOccupancy: number
}

export const FORECAST_METHOD =
  'Forecast: on the books today plus the room nights the last three complete months picked up from the same number of days before their month end, scaled to this month’s available nights, priced at the rate of those pickups and capped at the available nights.'

interface PaceInput {
  stays: readonly StayFact[]
  units: number
  blocks: readonly Pick<UnitBlock, 'from' | 'to'>[]
  today: IsoDate
  /** First arrival on record; trailing months before it are skipped. */
  start: IsoDate | null
}

/** On the books, pace against last month at the same lead, and the month-end forecast, for one month. */
export function paceMonth(input: PaceInput, month: string): PaceMonth {
  const { stays, units, blocks, today, start } = input
  const from = `${month}-01`
  const to = addMonths(from, 1)
  const lead = Math.max(0, daysBetween(today, to))
  const available = roomStats([], units, blocks, from, to).available
  const onBooks = onBooksAsOf(stays, from, to, today)
  const lastFrom = addMonths(from, -1)
  const lastMonthSameLead = onBooksAsOf(stays, lastFrom, from, addMonths(today, -1))
  const thisMonth = `${today.slice(0, 7)}-01`
  const trailing = [1, 2, 3].map((n) => addMonths(thisMonth, -n)).filter((m) => covers(start, m))
  const picked = trailing.map((m) => {
    const end = addMonths(m, 1)
    const final = onBooksAsOf(stays, m, end, end)
    const then = onBooksAsOf(stays, m, end, addDays(end, -lead))
    return { nights: final.nights - then.nights, revenue: final.revenue - then.revenue, available: roomStats([], units, blocks, m, end).available }
  })
  const pickupNights = sum(picked.map((p) => p.nights))
  const pickupAvailable = sum(picked.map((p) => p.available))
  const pickupRate = pickupAvailable ? pickupNights / pickupAvailable : 0
  const pickupAdr = pickupNights ? sum(picked.map((p) => p.revenue)) / pickupNights : onBooks.nights ? onBooks.revenue / onBooks.nights : 0
  const nights = Math.max(onBooks.nights, Math.min(available, onBooks.nights + Math.round(pickupRate * available)))
  const forecast = { nights, revenue: Math.round(onBooks.revenue + (nights - onBooks.nights) * pickupAdr) }
  return { month, available, onBooks, lastMonthSameLead, pace: change(onBooks.nights, lastMonthSameLead.nights), pickupRate, forecast, forecastOccupancy: available ? nights / available : 0 }
}

/** One budget month for one villa. Room revenue is room nights times ADR. */
export interface BudgetMonth {
  roomNights: number
  adr: number
  otherRevenue: number
  expenses: number
}

export interface Budget {
  villaId: string
  year: number
  /** January to December. */
  months: readonly BudgetMonth[]
  updatedBy: string
  updatedOn: IsoDate
}

export interface BudgetInput {
  villaId: string
  year: number
  months: readonly BudgetMonth[]
}

export const BUDGET_FIELDS: ReadonlyArray<{ key: keyof BudgetMonth; label: string }> = [
  { key: 'roomNights', label: 'Room nights' },
  { key: 'adr', label: 'ADR' },
  { key: 'otherRevenue', label: 'Other revenue' },
  { key: 'expenses', label: 'Expenses' },
]

export const EMPTY_BUDGET_MONTH: BudgetMonth = { roomNights: 0, adr: 0, otherRevenue: 0, expenses: 0 }
export const budgetRoomRevenue = (m: BudgetMonth) => Math.round(m.roomNights * m.adr)

/** Field errors keyed the way the form names them: `months.2.adr`. */
export function validateBudget(input: BudgetInput): Record<string, string> {
  const errors: Record<string, string> = {}
  if (!input.villaId) errors.villaId = 'Pick a villa.'
  if (!Number.isInteger(input.year) || input.year < 2000 || input.year > 2100) errors.year = 'Pick a year.'
  if (input.months.length !== 12) errors.months = 'A budget has twelve months.'
  input.months.forEach((m, i) => {
    for (const f of BUDGET_FIELDS) {
      const v = m[f.key]
      if (!Number.isInteger(v) || v < 0) errors[`months.${i}.${f.key}`] = `${f.label}: a whole number, zero or more.`
    }
  })
  return errors
}

/** Splits a whole-number total into `parts` whole numbers that add back to it; the first months take the remainder. */
export function spreadEvenly(total: number, parts = 12): number[] {
  const whole = Math.max(0, Math.round(total))
  const base = Math.floor(whole / parts)
  return Array.from({ length: parts }, (_, i) => base + (i < whole - base * parts ? 1 : 0))
}

export interface Variance {
  budget: number
  actual: number
  amount: number
  /** Against the budget; null when nothing was budgeted. */
  pct: number | null
  /** True when the gap helps profit: revenue above budget, costs under it. Null when on budget. */
  good: boolean | null
}

export function variance(actual: number, budget: number, cost = false): Variance {
  const amount = actual - budget
  return { budget, actual, amount, pct: budget ? amount / budget : null, good: amount === 0 ? null : cost ? amount < 0 : amount > 0 }
}
