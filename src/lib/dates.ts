/** Calendar dates as `YYYY-MM-DD` strings, computed in UTC so time zones never shift a day. */
export type IsoDate = string

const DAY_MS = 86_400_000

function toIso(date: Date): IsoDate {
  return date.toISOString().slice(0, 10)
}

function parseIso(iso: IsoDate): Date {
  return new Date(`${iso}T00:00:00Z`)
}

export function addDays(iso: IsoDate, days: number): IsoDate {
  return toIso(new Date(parseIso(iso).getTime() + days * DAY_MS))
}

/** Adds months and clamps the day, so Jan 31 + 1 month is Feb 28. */
export function addMonths(iso: IsoDate, months: number): IsoDate {
  const d = parseIso(iso)
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1))
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
  target.setUTCDate(Math.min(d.getUTCDate(), lastDay))
  return toIso(target)
}

export function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((parseIso(to).getTime() - parseIso(from).getTime()) / DAY_MS)
}

/** Day of the month, 1-31. */
export const parseIsoDay = (iso: IsoDate) => Number(iso.slice(8, 10))

/** Monday = 0 through Sunday = 6. */
export function weekdayIndex(iso: IsoDate): number {
  return (parseIso(iso).getUTCDay() + 6) % 7
}

export function startOfWeek(iso: IsoDate): IsoDate {
  return addDays(iso, -weekdayIndex(iso))
}

export function startOfMonth(iso: IsoDate): IsoDate {
  return `${iso.slice(0, 7)}-01`
}

const monthFmt = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' })
const longMonthFmt = new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' })
const dayFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
const weekdayFmt = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' })

export const shortMonth = (iso: IsoDate) => monthFmt.format(parseIso(iso))
export const longMonth = (iso: IsoDate) => longMonthFmt.format(parseIso(iso))
export const shortDay = (iso: IsoDate) => dayFmt.format(parseIso(iso))
export const shortWeekday = (iso: IsoDate) => weekdayFmt.format(parseIso(iso))

const weekdayDayFmt = new Intl.DateTimeFormat('en-US', { weekday: 'short', day: 'numeric', timeZone: 'UTC' })
const fullFmt = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })

/** "Mon 5" for calendar columns. */
export const weekdayDay = (iso: IsoDate) => weekdayDayFmt.format(parseIso(iso))
/** "Mon, Oct 5". */
export const fullDay = (iso: IsoDate) => fullFmt.format(parseIso(iso))

export const minIso = (a: IsoDate, b: IsoDate) => (a < b ? a : b)
export const maxIso = (a: IsoDate, b: IsoDate) => (a > b ? a : b)

/** Every day from `from` up to but not including `to`. */
export function eachDay(from: IsoDate, to: IsoDate): IsoDate[] {
  const n = Math.max(0, daysBetween(from, to))
  return Array.from({ length: n }, (_, i) => addDays(from, i))
}

/** True when `iso` sits inside the inclusive range; an open end matches everything on that side. */
export const withinRange = (iso: IsoDate, from?: string, to?: string) => (!from || iso >= from) && (!to || iso <= to)
