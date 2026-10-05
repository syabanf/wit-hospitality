import { addDays, daysBetween, maxIso, shortDay, shortWeekday, type IsoDate } from '@/lib/dates'

export type Period = '7d' | '30d' | '90d'
export const PERIODS: readonly Period[] = ['7d', '30d', '90d']
export const PERIOD_LABEL: Record<Period, string> = { '7d': '7 days', '30d': '30 days', '90d': '90 days' }
const PERIOD_DAYS: Record<Period, number> = { '7d': 7, '30d': 30, '90d': 90 }

/** `to` is exclusive. */
export interface DateRange {
  from: IsoDate
  to: IsoDate
}

/**
 * The last N days ending today, and the N days before them for comparison.
 * A custom inclusive `from`/`to` pair replaces the preset; the comparison keeps the same length.
 */
export function periodRange(period: Period, today: IsoDate, custom?: { from?: string; to?: string }): { current: DateRange; previous: DateRange } {
  if (custom?.from || custom?.to) {
    const to = addDays(custom.to ?? today, 1)
    const from = custom.from ?? addDays(to, -PERIOD_DAYS[period])
    const n = Math.max(1, daysBetween(from, to))
    return { current: { from, to }, previous: { from: addDays(from, -n), to: from } }
  }
  const n = PERIOD_DAYS[period]
  const to = addDays(today, 1)
  const from = addDays(to, -n)
  return { current: { from, to }, previous: { from: addDays(from, -n), to: from } }
}

export interface Bucket extends DateRange {
  key: string
  label: string
}

/** Days for a week, weeks for anything longer. Weeks count back from the range end, so the latest bucket is always full. */
export function buckets(range: DateRange, period: Period): Bucket[] {
  if (period === '7d' || daysBetween(range.from, range.to) <= 14) {
    return Array.from({ length: daysBetween(range.from, range.to) }, (_, i) => {
      const from = addDays(range.from, i)
      return { key: from, label: shortWeekday(from), from, to: addDays(from, 1) }
    })
  }
  const out: Bucket[] = []
  for (let to = range.to; to > range.from; to = addDays(to, -7)) {
    const from = maxIso(addDays(to, -7), range.from)
    out.unshift({ key: from, label: shortDay(from), from, to })
  }
  return out
}

/** Relative change, or null when there is nothing to compare against. */
export const change = (current: number, previous: number) => (previous > 0 ? (current - previous) / previous : null)
