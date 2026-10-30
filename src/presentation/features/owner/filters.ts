import type { OwnerFilter } from '@/application/performance'
import { COMPARE_OPTIONS, compareRange, OWNER_PERIODS, ownerRange, type CompareTo, type OwnerPeriod } from '@/domain/performance'
import { shortDay, type IsoDate } from '@/lib/dates'

export interface OwnerState {
  period: OwnerPeriod
  compare: CompareTo
  filter: OwnerFilter
}

/** Period, comparison and scope live in the URL so a link reopens the same view. */
export function parseOwner(params: URLSearchParams, today: IsoDate): OwnerState {
  const period = OWNER_PERIODS.find((p) => p.value === params.get('period'))?.value ?? 'month'
  const compare = COMPARE_OPTIONS.find((c) => c.value === params.get('compare'))?.value ?? 'previous'
  const range = ownerRange(period, today, { from: params.get('from') ?? undefined, to: params.get('to') ?? undefined })
  const before = compareRange(range, compare)
  const pick = (key: string) => params.get(key) || undefined
  return { period, compare, filter: { ...range, compareFrom: before.from, compareTo: before.to, locationId: pick('location'), villaId: pick('villa') } }
}

export const ownerKey = (f: OwnerFilter) => [f.from, f.to, f.compareFrom, f.compareTo, f.locationId, f.villaId].map((v) => v ?? '').join('|')

export const rangeLabel = (from: IsoDate, to: IsoDate) => (from === to ? shortDay(from) : `${shortDay(from)} to ${shortDay(to)}`)

/** Writes one or more keys, keeping the rest of the query. Empty values drop the key. */
export function withParams(params: URLSearchParams, next: Record<string, string | undefined>) {
  const search = new URLSearchParams(params)
  for (const [k, v] of Object.entries(next)) {
    if (v) search.set(k, v)
    else search.delete(k)
  }
  return search
}
