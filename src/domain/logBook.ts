import { addDays, type IsoDate } from '@/lib/dates'
import { RuleError } from './errors'

/**
 * The front office log book: the desk's notes from shift to shift. A note flagged for follow-up
 * stays open until someone marks it done, and the next shift acknowledges it on the way.
 * Contract: api/docs/contracts/front-office-controls-contract.md section 3.
 */

export type LogCategory = 'handover' | 'guest' | 'maintenance' | 'cash' | 'security' | 'other'
export const LOG_CATEGORIES: readonly LogCategory[] = ['handover', 'guest', 'maintenance', 'cash', 'security', 'other']
export const LOG_CATEGORY_LABEL: Record<LogCategory, string> = { handover: 'Handover', guest: 'Guest', maintenance: 'Maintenance', cash: 'Cash', security: 'Security', other: 'Other' }

export type LogShift = 'morning' | 'afternoon' | 'night'
export const LOG_SHIFTS: readonly LogShift[] = ['morning', 'afternoon', 'night']
export const LOG_SHIFT_LABEL: Record<LogShift, string> = { morning: 'Morning', afternoon: 'Afternoon', night: 'Night' }
export const LOG_SHIFT_HOURS: Record<LogShift, string> = { morning: '07:00 to 15:00', afternoon: '15:00 to 23:00', night: '23:00 to 07:00' }

export type LogLinkKind = 'booking' | 'unit' | 'guest'

export interface LogLink {
  kind: LogLinkKind
  id: string
  label: string
}

export interface LogEntry {
  id: string
  at: string
  /** The shift's day: a night note written before 07:00 belongs to the day before. */
  date: IsoDate
  shift: LogShift
  author: string
  authorId: string
  category: LogCategory
  text: string
  /** The property the note is about; null for every property. */
  villaId: string | null
  link: LogLink | null
  followUp: boolean
  acknowledgedBy: string | null
  acknowledgedAt: string | null
  doneBy: string | null
  doneAt: string | null
  doneNote: string
  /** The cashier shift whose close wrote this handover. */
  shiftId: string | null
}

export interface LogInput {
  category: LogCategory
  text: string
  villaId: string | null
  link: { kind: LogLinkKind; id: string } | null
  followUp: boolean
}

export const MAX_LOG_TEXT = 1000
const length = (s: string) => [...s.trim()].length

/** The message for an entry's text, or undefined when it reads fine; the shift close's handover uses it too. */
export function logTextProblem(text: string): string | undefined {
  if (length(text) < 3) return 'Write what the next shift needs to know.'
  if (length(text) > MAX_LOG_TEXT) return 'Keep an entry under 1000 characters.'
  return undefined
}

export function validateLog(input: LogInput): Partial<Record<keyof LogInput, string>> {
  const errors: Partial<Record<keyof LogInput, string>> = {}
  if (!LOG_CATEGORIES.includes(input.category)) errors.category = 'Pick a category.'
  const text = logTextProblem(input.text)
  if (text) errors.text = text
  if (input.link && !['booking', 'unit', 'guest'].includes(input.link.kind)) errors.link = 'That booking, room or guest was not found.'
  return errors
}

/** The shift and its day from a local stamp: 07 to 15 morning, 15 to 23 afternoon, the rest night. */
export function shiftOf(stamp: string): { shift: LogShift; date: IsoDate } {
  const date = stamp.slice(0, 10)
  const hour = Number(stamp.slice(11, 13)) || 0
  if (hour >= 7 && hour < 15) return { shift: 'morning', date }
  if (hour >= 15 && hour < 23) return { shift: 'afternoon', date }
  return { shift: 'night', date: hour < 7 ? addDays(date, -1) : date }
}

const hourMinute = (stamp: string | null) => (stamp ?? '').slice(11, 16)

export const isOpenFollowUp = (e: Pick<LogEntry, 'followUp' | 'doneBy'>) => e.followUp && e.doneBy === null

export function acknowledgeProblem(e: LogEntry, userId: string): RuleError | null {
  if (!e.followUp) return new RuleError('LOG_NO_FOLLOW_UP', 'That entry asks for no follow-up.')
  if (e.acknowledgedBy) return new RuleError('LOG_ACKNOWLEDGED', `${e.acknowledgedBy} acknowledged it at ${hourMinute(e.acknowledgedAt)}.`)
  if (e.authorId === userId) return new RuleError('LOG_OWN_ENTRY', 'The next shift acknowledges this note; you wrote it.')
  return null
}

/** Throws LOG_NO_FOLLOW_UP or LOG_DONE, else returns the note's field error. */
export function doneProblem(e: LogEntry, note: string): { note?: string } {
  if (!e.followUp) throw new RuleError('LOG_NO_FOLLOW_UP', 'That entry asks for no follow-up.')
  if (e.doneBy) throw new RuleError('LOG_DONE', `${e.doneBy} marked it done at ${hourMinute(e.doneAt)}.`)
  return length(note) > 300 ? { note: 'Keep the note under 300 characters.' } : {}
}

export interface LogFilter {
  from?: IsoDate
  to?: IsoDate
  category?: LogCategory | 'all'
  shift?: LogShift | 'all'
  followUp?: boolean
  query?: string
}

export function filterLog(list: readonly LogEntry[], f: LogFilter): LogEntry[] {
  const q = (f.query ?? '').trim().toLowerCase()
  return list.filter((e) => {
    if (f.from && e.date < f.from) return false
    if (f.to && e.date > f.to) return false
    if (f.category && f.category !== 'all' && e.category !== f.category) return false
    if (f.shift && f.shift !== 'all' && e.shift !== f.shift) return false
    if (f.followUp && !e.followUp) return false
    if (q && ![e.text, e.author, e.link?.label ?? ''].some((v) => v.toLowerCase().includes(q))) return false
    return true
  })
}

/** Entries by day, newest first, then by shift, latest shift first. */
export function groupByShift(list: readonly LogEntry[]): Array<{ date: IsoDate; shift: LogShift; entries: LogEntry[] }> {
  const groups = new Map<string, { date: IsoDate; shift: LogShift; entries: LogEntry[] }>()
  for (const e of [...list].sort((a, b) => b.at.localeCompare(a.at))) {
    const key = `${e.date}:${e.shift}`
    const g = groups.get(key) ?? { date: e.date, shift: e.shift, entries: [] }
    g.entries.push(e)
    groups.set(key, g)
  }
  return [...groups.values()].sort((a, b) => b.date.localeCompare(a.date) || LOG_SHIFTS.indexOf(b.shift) - LOG_SHIFTS.indexOf(a.shift))
}
