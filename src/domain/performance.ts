import { addDays, addMonths, daysBetween, startOfMonth, type IsoDate } from '@/lib/dates'
import { chargedBetween, overlapNights, type Booking } from './booking'
import { change } from './dashboard'

/** Owner reporting periods. Ranges are inclusive dates, like the report filters. */
export type OwnerPeriod = 'month' | 'last-month' | 'quarter' | 'ytd' | 'custom'
export const OWNER_PERIODS: ReadonlyArray<{ value: OwnerPeriod; label: string }> = [
  { value: 'month', label: 'This month' },
  { value: 'last-month', label: 'Last month' },
  { value: 'quarter', label: 'This quarter' },
  { value: 'ytd', label: 'Year to date' },
  { value: 'custom', label: 'Custom' },
]

export type CompareTo = 'previous' | 'last-year'
export const COMPARE_OPTIONS: ReadonlyArray<{ value: CompareTo; label: string }> = [
  { value: 'previous', label: 'vs previous period' },
  { value: 'last-year', label: 'vs same period last year' },
]

export interface InclusiveRange {
  from: IsoDate
  to: IsoDate
}

export const endOfMonth = (iso: IsoDate) => addDays(addMonths(startOfMonth(iso), 1), -1)
const minIso = (a: IsoDate, b: IsoDate) => (a < b ? a : b)

/** The range a preset covers, never past today. */
export function ownerRange(period: OwnerPeriod, today: IsoDate, custom: Partial<InclusiveRange> = {}): InclusiveRange {
  if (period === 'last-month') {
    const from = addMonths(startOfMonth(today), -1)
    return { from, to: endOfMonth(from) }
  }
  if (period === 'quarter') {
    const month = Number(today.slice(5, 7))
    const first = `${today.slice(0, 4)}-${String(month - ((month - 1) % 3)).padStart(2, '0')}-01`
    return { from: first, to: today }
  }
  if (period === 'ytd') return { from: `${today.slice(0, 4)}-01-01`, to: today }
  if (period === 'custom' && custom.from && custom.to && custom.from <= custom.to) return { from: custom.from, to: minIso(custom.to, today) }
  return { from: startOfMonth(today), to: today }
}

/** The comparison range: the same number of days just before, or the same dates a year earlier. */
export function compareRange(range: InclusiveRange, mode: CompareTo): InclusiveRange {
  if (mode === 'last-year') return { from: addMonths(range.from, -12), to: addMonths(range.to, -12) }
  const length = daysBetween(range.from, range.to) + 1
  return { from: addDays(range.from, -length), to: addDays(range.from, -1) }
}

/** Calendar months touched by the range, each clipped to it. */
export function monthsIn(range: InclusiveRange): Array<InclusiveRange & { month: string }> {
  const out: Array<InclusiveRange & { month: string }> = []
  for (let m = startOfMonth(range.from); m <= range.to; m = addMonths(m, 1)) {
    out.push({ month: m.slice(0, 7), from: m < range.from ? range.from : m, to: minIso(endOfMonth(m), range.to) })
  }
  return out
}

/** The P&L lines the reports print, all positive: costs are subtracted in `profit`. */
export interface PnlLine {
  revenue: number
  fees: number
  other: number
  expenses: number
  payroll: number
  profit: number
}

export const EMPTY_PNL: PnlLine = { revenue: 0, fees: 0, other: 0, expenses: 0, payroll: 0, profit: 0 }

export function addPnl(a: PnlLine, b: PnlLine): PnlLine {
  return { revenue: a.revenue + b.revenue, fees: a.fees + b.fees, other: a.other + b.other, expenses: a.expenses + b.expenses, payroll: a.payroll + b.payroll, profit: a.profit + b.profit }
}

/** Total income before costs: room revenue plus other income. */
export const totalRevenue = (p: PnlLine) => p.revenue + p.other
export const operatingMargin = (p: PnlLine) => (totalRevenue(p) > 0 ? p.profit / totalRevenue(p) : 0)

export interface RoomKpis {
  occupancy: number
  adr: number
  revpar: number
}

/** Occupancy over sellable nights, ADR over sold nights, RevPAR over sellable nights. */
export function roomKpis(roomRevenue: number, sold: number, sellable: number): RoomKpis {
  return {
    occupancy: sellable > 0 ? sold / sellable : 0,
    adr: sold > 0 ? roomRevenue / sold : 0,
    revpar: sellable > 0 ? roomRevenue / sellable : 0,
  }
}

export interface Delta {
  value: number
  previous: number
  change: number | null
}

export const delta = (value: number, previous: number): Delta => ({ value, previous, change: change(value, previous) })

type StayLike = Pick<Booking, 'status' | 'checkIn' | 'checkOut' | 'listRates' | 'rateOverride' | 'discount'>

/** Revenue and nights already confirmed for the next `days` nights from today. */
export function onTheBooks(stays: readonly StayLike[], units: number, today: IsoDate, days: number) {
  const end = addDays(today, days)
  const live = stays.filter((b) => b.status === 'confirmed' || b.status === 'checked_in')
  const nights = live.reduce((s, b) => s + overlapNights(b.checkIn, b.checkOut, today, end), 0)
  const revenue = live.reduce((s, b) => s + chargedBetween(b, today, end), 0)
  return { days, revenue, nights, occupancy: units > 0 ? nights / (units * days) : 0 }
}

const PNL_PARTS: ReadonlyArray<{ key: keyof Omit<PnlLine, 'profit'>; label: string; cost: boolean }> = [
  { key: 'revenue', label: 'room revenue', cost: false },
  { key: 'other', label: 'other income', cost: false },
  { key: 'fees', label: 'Airbnb fees', cost: true },
  { key: 'expenses', label: 'operating expenses', cost: true },
  { key: 'payroll', label: 'payroll', cost: true },
]

/** The P&L line that moved profit the most between two periods, with its effect on profit. */
export function mainDriver(current: PnlLine, previous: PnlLine) {
  return PNL_PARTS.map((p) => ({ label: p.label, cost: p.cost, effect: (current[p.key] - previous[p.key]) * (p.cost ? -1 : 1) })).sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect))[0]
}

export interface Movement {
  key: string
  text: string
  /** Effect on profit; positive is good for the owner. */
  effect: number
}

/**
 * The biggest movements versus the comparison period as plain sentences: the portfolio profit,
 * then each villa whose profit moved, largest first.
 */
export function describeChanges(
  portfolio: { current: PnlLine; previous: PnlLine },
  villas: ReadonlyArray<{ name: string; current: PnlLine; previous: PnlLine }>,
  fmt: (value: number) => string,
  limit = 5,
): Movement[] {
  const sentence = (subject: string, c: PnlLine, p: PnlLine) => {
    const diff = c.profit - p.profit
    const driver = mainDriver(c, p)
    const why = driver && driver.effect !== 0 ? `, mostly from ${driver.label}${driver.cost ? (driver.effect > 0 ? ' going down' : ' going up') : driver.effect > 0 ? ' going up' : ' going down'}` : ''
    return `${subject} profit ${diff >= 0 ? 'up' : 'down'} ${fmt(Math.abs(diff))}${why}.`
  }
  const rows: Movement[] = villas
    .map((v) => ({ key: v.name, text: sentence(v.name, v.current, v.previous), effect: v.current.profit - v.previous.profit }))
    .filter((m) => m.effect !== 0)
    .sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect))
  const total = portfolio.current.profit - portfolio.previous.profit
  const head: Movement[] = total === 0 ? [] : [{ key: 'portfolio', text: sentence('Portfolio', portfolio.current, portfolio.previous), effect: total }]
  return [...head, ...rows].slice(0, limit)
}
