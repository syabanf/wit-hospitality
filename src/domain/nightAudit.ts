import { addDays, type IsoDate } from '@/lib/dates'
import type { Booking } from './booking'
import { nightCharges } from './pricing'

/**
 * The night audit closes a business day, as a hotel PMS does: it marks arrivals that never came as
 * no-shows, posts that night's room to every stay in house and rolls the business date forward. The
 * business date runs apart from the calendar date; an audit for a date runs once.
 */

export type AuditCheckKey = 'arrivals' | 'departures' | 'links' | 'orders' | 'unassigned' | 'cashCount' | 'shiftsOpen'
export const AUDIT_CHECKS: readonly AuditCheckKey[] = ['arrivals', 'departures', 'links', 'orders', 'unassigned', 'cashCount', 'shiftsOpen']
export const AUDIT_CHECK_LABEL: Record<AuditCheckKey, string> = {
  arrivals: 'Arrivals not checked in',
  departures: 'Departures not checked out',
  links: 'Payment links still open',
  orders: 'Orders not delivered',
  unassigned: 'Room-type stays without a room',
  cashCount: 'Cashboxes not counted',
  shiftsOpen: 'Cashier shifts still open',
}
/** What the audit does about each check: only arrivals change, the rest are for the desk to look at. */
export const AUDIT_CHECK_HINT: Record<AuditCheckKey, string> = {
  arrivals: 'The audit marks them no-show; the cancellation policy applies.',
  departures: 'They stay in house; check them out or extend the stay.',
  links: 'The guest can still pay them; cancel any that are stale.',
  orders: 'Deliver or cancel them so the bill is complete.',
  unassigned: 'Assign a room before the guest arrives.',
  cashCount: 'Count the cashbox or close its cashier shift so the day closes on a known balance.',
  shiftsOpen: 'Close each shift on a counted drawer, or hand it over to the night cashier.',
}

export interface AuditCheck {
  key: AuditCheckKey
  label: string
  hint: string
  items: ReadonlyArray<{ label: string; to: string }>
}

export interface AuditStay {
  bookingId: string
  code: string
  /** Nights posted for the stay at this audit; more than one when it catches up a late check-in. */
  nights: number
  amount: number
}

export interface NightAudit {
  id: string
  /** The business date the audit closed. */
  date: IsoDate
  /** ISO date-time. */
  ranAt: string
  ranBy: string
  /** How many items each check listed when the audit ran. */
  checks: Record<AuditCheckKey, number>
  /** Booking codes marked no-show. */
  noShows: readonly string[]
  stays: readonly AuditStay[]
  nights: number
  roomRevenue: number
}

export interface AuditRunInput {
  date: IsoDate
  checks: Record<AuditCheckKey, number>
  noShows: readonly string[]
}

export const postedNights = (b: Pick<Booking, 'nightsPosted'>) => b.nightsPosted?.length ?? 0

/** The nights the audit of `date` posts on a stay in house: every one not yet posted up to and including that night. */
export function nightsToPost(b: Pick<Booking, 'status' | 'checkIn' | 'listRates' | 'nightsPosted'>, date: IsoDate): number[] {
  if (b.status !== 'checked_in') return []
  const out: number[] = []
  for (let i = postedNights(b); i < b.listRates.length && addDays(b.checkIn, i) <= date; i++) out.push(i)
  return out
}

/** What one stay's nights come to: the list or staff rate of each night less its share of the discount. */
export const nightsAmount = (b: Parameters<typeof nightCharges>[0], nights: readonly number[]) => {
  const charges = nightCharges(b)
  return nights.reduce((s, i) => s + (charges[i] ?? 0), 0)
}

/** A rerun of a closed date, or a date that is not the current business date, is refused. */
export function auditProblem(date: IsoDate, businessDate: IsoDate, today: IsoDate, audits: readonly Pick<NightAudit, 'date'>[]): { code: string; message: string } | null {
  if (audits.some((a) => a.date === date)) return { code: 'AUDIT_ALREADY_RUN', message: `The night audit for ${date} has run; the business date is ${businessDate}.` }
  if (date !== businessDate) return { code: 'AUDIT_DATE', message: `The business date is ${businessDate}; the audit closes that day only.` }
  if (date > today) return { code: 'AUDIT_TOO_EARLY', message: `${date} has not started yet; run its audit on that day or later.` }
  return null
}

export const emptyChecks = (): Record<AuditCheckKey, number> => ({ arrivals: 0, departures: 0, links: 0, orders: 0, unassigned: 0, cashCount: 0, shiftsOpen: 0 })
