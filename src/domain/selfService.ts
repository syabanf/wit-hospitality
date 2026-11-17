import { RuleError } from './errors'
import { ATTENDANCE_STATUS_LABEL, CLOCK_PLACE_LABEL, LEAVE_KINDS, lateMinutes, villaIdsOf, type Attendance, type ClockStamp, type Employee, type LeaveKind, type LeaveRequest, type Shift, type ShiftAssignment, type ShiftAssignmentInput } from './hr'
import type { IsoDate } from '@/lib/dates'

/** The employee area's own rules: the clock, shift swaps and the leave balance per kind. The Go API holds the same rules with the same codes. */

export interface GeoPoint {
  lat: number
  lng: number
}

/** How far from a villa a clock still counts as pressed at the villa. */
export interface AttendanceSettings {
  radiusMeters: number
}
export const DEFAULT_ATTENDANCE_SETTINGS: AttendanceSettings = { radiusMeters: 200 }

export function validateAttendanceSettings(s: AttendanceSettings): Partial<Record<keyof AttendanceSettings, string>> {
  return Number.isInteger(s.radiusMeters) && s.radiusMeters >= 20 && s.radiusMeters <= 5000 ? {} : { radiusMeters: 'The radius is 20 to 5000 whole metres.' }
}

export const validGeo = (g: GeoPoint | null | undefined): g is GeoPoint => Boolean(g) && Number.isFinite(g?.lat) && Number.isFinite(g?.lng) && Math.abs(g?.lat ?? 91) <= 90 && Math.abs(g?.lng ?? 181) <= 180

/** Metres between two points on the haversine great circle, rounded. */
export function distanceMeters(a: GeoPoint, b: GeoPoint): number {
  const rad = (deg: number) => (deg * Math.PI) / 180
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2
  return Math.round(2 * 6_371_000 * Math.asin(Math.sqrt(h)))
}

export interface VillaPoint {
  id: string
  lat: number | null
  lng: number | null
}

/** The position against the nearest of the villas; null when the browser gave none. A missing position never blocks the clock. */
export function stampGeo(point: GeoPoint | null | undefined, villas: readonly VillaPoint[], radiusMeters: number): ClockStamp | null {
  if (!validGeo(point)) return null
  let nearest: { id: string; distance: number } | null = null
  for (const v of villas) {
    if (v.lat === null || v.lng === null) continue
    const distance = distanceMeters(point, { lat: v.lat, lng: v.lng })
    if (!nearest || distance < nearest.distance) nearest = { id: v.id, distance }
  }
  if (!nearest) return { lat: point.lat, lng: point.lng, villaId: null, distanceMeters: null, place: 'unknown' }
  return { lat: point.lat, lng: point.lng, villaId: nearest.id, distanceMeters: nearest.distance, place: nearest.distance <= radiusMeters ? 'villa' : 'away' }
}

/** "At the villa, 32 m" for a stamped position; a clock without one says so. */
export function placeLabel(geo: ClockStamp | null) {
  if (!geo) return 'No position shared'
  if (geo.distanceMeters === null) return CLOCK_PLACE_LABEL[geo.place]
  return `${CLOCK_PLACE_LABEL[geo.place]}, ${geo.distanceMeters >= 1000 ? `${(geo.distanceMeters / 1000).toFixed(1)} km` : `${geo.distanceMeters} m`}`
}

export interface ClockInput {
  /** Needed on a day the roster gives no shift. */
  reason: string
  geo: GeoPoint | null
}

const overnight = (shift: Shift | null) => Boolean(shift && shift.end < shift.start)

/** The row a clock-out closes: today's, or yesterday's when that shift runs past midnight. */
export function openClock(today: Attendance | undefined, yesterday: Attendance | undefined, yesterdayShift: Shift | null): Attendance | null {
  if (today?.clockIn && !today.clockOut) return today
  if (yesterday?.clockIn && !yesterday.clockOut && overnight(yesterdayShift)) return yesterday
  return null
}

export type ClockAction = 'in' | 'out' | 'done'
export const CLOCK_ACTION_LABEL: Record<ClockAction, string> = { in: 'Clock in', out: 'Clock out', done: 'Day complete' }

/** What the one big button does next. */
export function clockAction(today: Attendance | undefined, yesterday: Attendance | undefined, yesterdayShift: Shift | null): ClockAction {
  if (openClock(today, yesterday, yesterdayShift)) return 'out'
  return today?.clockIn ? 'done' : 'in'
}

/** Refuses a clock-in: a day already clocked, a leave day, a day HR recorded, or a day off the roster without a reason. */
export function checkClockIn(row: Attendance | undefined, shift: Shift | null, onLeave: boolean, reason: string): void {
  if (row?.clockIn) throw row.clockOut ? new RuleError('CLOCK_ALREADY_OUT', `You already clocked out at ${row.clockOut}.`) : new RuleError('CLOCK_ALREADY_IN', `You already clocked in at ${row.clockIn}.`)
  if (onLeave || row?.status === 'leave') throw new RuleError('CLOCK_ON_LEAVE', 'You are on leave today.')
  if (row && row.status !== 'off') throw new RuleError('CLOCK_DAY_RECORDED', `HR recorded today as ${ATTENDANCE_STATUS_LABEL[row.status].toLowerCase()}. Ask HR to correct it.`)
  if (!shift && reason.trim().length < 3) throw new RuleError('CLOCK_NOT_ROSTERED', 'You are not on the roster today. Say why you are clocking in.')
}

/** The row a clock-in writes: late against the shift start, present on a day without a shift. */
export function clockedIn(time: string, shift: Shift | null, reason: string, geo: ClockStamp | null): Pick<Attendance, 'status' | 'clockIn' | 'clockOut' | 'lateMinutes' | 'note' | 'source' | 'corrected' | 'clockInGeo' | 'clockOutGeo'> {
  const late = lateMinutes(time, shift)
  return { status: late > 0 ? 'late' : 'present', clockIn: time, clockOut: null, lateMinutes: late, note: reason.trim(), source: 'self', corrected: false, clockInGeo: geo, clockOutGeo: null }
}

/** Refuses a clock-out without an open clock-in. */
export function checkClockOut(open: Attendance | null, today: Attendance | undefined): Attendance {
  if (open) return open
  if (today?.clockOut) throw new RuleError('CLOCK_ALREADY_OUT', `You already clocked out at ${today.clockOut}.`)
  throw new RuleError('CLOCK_NOT_IN', 'Clock in first.')
}

/** Days a year per kind; null has no limit. Annual leave follows the employee's own entitlement. */
const LEAVE_QUOTA: Record<Exclude<LeaveKind, 'annual'>, number | null> = { sick: 12, permission: 6, unpaid: null }
const LEAVE_NOUN: Record<LeaveKind, string> = { annual: 'annual leave', sick: 'sick leave', permission: 'permission', unpaid: 'unpaid leave' }

export interface LeaveBalance {
  kind: LeaveKind
  /** Days a year; null has no limit. */
  entitlement: number | null
  used: number
  pending: number
  /** Days still open to request; null has no limit. */
  left: number | null
}

export const leaveEntitlement = (employee: Pick<Employee, 'annualLeaveDays'>, kind: LeaveKind) => (kind === 'annual' ? employee.annualLeaveDays : LEAVE_QUOTA[kind])

/** Per kind for one year: approved days are used, pending days are held, and both come off the entitlement. A request counts in the year it starts. */
export function leaveBalances(employee: Pick<Employee, 'id' | 'annualLeaveDays'>, leaves: readonly LeaveRequest[], year: string): LeaveBalance[] {
  return LEAVE_KINDS.map((kind) => {
    const mine = leaves.filter((l) => l.employeeId === employee.id && l.kind === kind && l.from.startsWith(year))
    const days = (status: LeaveRequest['status']) => mine.filter((l) => l.status === status).reduce((s, l) => s + l.days, 0)
    const entitlement = leaveEntitlement(employee, kind)
    const used = days('approved')
    const pending = days('pending')
    return { kind, entitlement, used, pending, left: entitlement === null ? null : Math.max(0, entitlement - used - pending) }
  })
}

/** Annual days still open to request this year. */
export const annualLeaveLeft = (employee: Pick<Employee, 'id' | 'annualLeaveDays'>, leaves: readonly LeaveRequest[], year: string) => leaveBalances(employee, leaves, year)[0]?.left ?? 0

/** Refuses a request past what is left of a limited kind. */
export function checkLeaveBalance(kind: LeaveKind, days: number, balances: readonly LeaveBalance[]): void {
  const left = balances.find((b) => b.kind === kind)?.left ?? null
  if (left === null || days <= left) return
  throw new RuleError('LEAVE_BALANCE_EXCEEDED', left === 0 ? `No ${LEAVE_NOUN[kind]} days are left.` : `Only ${left} ${LEAVE_NOUN[kind]} ${left === 1 ? 'day is' : 'days are'} left.`)
}

export type SwapStatus = 'offered' | 'accepted' | 'declined' | 'approved' | 'rejected' | 'cancelled'
export const SWAP_STATUS_LABEL: Record<SwapStatus, string> = { offered: 'Waits for coworker', accepted: 'Waits for approval', declined: 'Declined', approved: 'Approved', rejected: 'Rejected', cancelled: 'Cancelled' }
export type SwapAction = 'accept' | 'decline' | 'cancel' | 'approve' | 'reject'
const SWAP_MOVE: Record<SwapAction, { from: readonly SwapStatus[]; to: SwapStatus }> = {
  accept: { from: ['offered'], to: 'accepted' },
  decline: { from: ['offered'], to: 'declined' },
  cancel: { from: ['offered', 'accepted'], to: 'cancelled' },
  approve: { from: ['accepted'], to: 'approved' },
  reject: { from: ['accepted'], to: 'rejected' },
}
export const swapOpen = (s: Pick<ShiftSwap, 'status'>) => s.status === 'offered' || s.status === 'accepted'

/** One employee gives a shift to a coworker at the same villa, alone or against one of the coworker's shifts. */
export interface ShiftSwap {
  id: string
  number: string
  villaId: string
  requesterId: string
  requesterName: string
  /** The requester's shift that moves to the coworker. */
  date: IsoDate
  shiftId: string
  counterpartId: string
  counterpartName: string
  /** The coworker's shift the requester takes in exchange; null gives the shift away. */
  counterDate: IsoDate | null
  counterShiftId: string | null
  note: string
  status: SwapStatus
  requestedOn: IsoDate
  respondedOn: IsoDate | null
  decidedOn: IsoDate | null
  decidedBy: string
  decisionNote: string
}

export interface SwapInput {
  date: string
  counterpartId: string
  counterDate: string | null
  note: string
}

const ISO = /^\d{4}-\d{2}-\d{2}$/

export function validateSwap(input: SwapInput, requesterId: string): Partial<Record<keyof SwapInput, string>> {
  const errors: Partial<Record<keyof SwapInput, string>> = {}
  if (!ISO.test(input.date)) errors.date = 'Pick the shift to hand over.'
  if (!input.counterpartId || input.counterpartId === requesterId) errors.counterpartId = 'Pick a coworker.'
  if (input.counterDate && !ISO.test(input.counterDate)) errors.counterDate = 'Pick the shift to take in exchange.'
  return errors
}

type SwapPerson = Pick<Employee, 'id' | 'name' | 'status' | 'allocations'>

/** What the swap rules read: the two people, their roster and leave, and the swaps still open. */
export interface SwapWorld {
  today: IsoDate
  requester: SwapPerson
  counterpart: SwapPerson
  assignments: readonly ShiftAssignment[]
  leaves: readonly Pick<LeaveRequest, 'employeeId' | 'status' | 'from' | 'to'>[]
  shifts: readonly Shift[]
  swaps: readonly ShiftSwap[]
  villaName: (id: string) => string
}

/**
 * Checks a swap against the roster as it stands and returns the two shifts it moves. It runs when
 * the swap is offered, accepted and approved; `ignoreId` leaves the swap itself out of the open ones.
 */
export function checkSwap(input: Pick<SwapInput, 'date' | 'counterDate'>, w: SwapWorld, ignoreId?: string): { mine: ShiftAssignment; theirs: ShiftAssignment | null } {
  const { requester, counterpart } = w
  const shiftOn = (employeeId: string, date: string) => w.assignments.find((a) => a.employeeId === employeeId && a.date === date && a.shiftId) ?? null
  const onLeave = (employeeId: string, date: string) => w.leaves.some((l) => l.employeeId === employeeId && l.status === 'approved' && l.from <= date && date <= l.to)
  const shiftName = (a: ShiftAssignment) => w.shifts.find((s) => s.id === a.shiftId)?.name ?? 'a shift'
  for (const date of [input.date, input.counterDate]) {
    if (date && date <= w.today) throw new RuleError('SWAP_PAST_SHIFT', `The shift on ${date} has started or passed. Swap an upcoming shift.`)
  }
  const mine = shiftOn(requester.id, input.date)
  if (!mine) throw new RuleError('SWAP_NO_SHIFT', `${requester.name} has no shift on ${input.date}.`)
  if (counterpart.status === 'inactive' || !villaIdsOf(counterpart).includes(mine.villaId)) throw new RuleError('SWAP_NOT_COWORKER', `${counterpart.name} does not work at ${w.villaName(mine.villaId)}.`)
  const theirs = input.counterDate ? shiftOn(counterpart.id, input.counterDate) : null
  if (input.counterDate) {
    if (!theirs) throw new RuleError('SWAP_NO_SHIFT', `${counterpart.name} has no shift on ${input.counterDate}.`)
    if (theirs.villaId !== mine.villaId) throw new RuleError('SWAP_NOT_COWORKER', `${counterpart.name} works at another villa on ${input.counterDate}.`)
    if (onLeave(requester.id, input.counterDate)) throw new RuleError('SWAP_ON_LEAVE', `${requester.name} is on leave on ${input.counterDate}.`)
  }
  if (onLeave(counterpart.id, input.date)) throw new RuleError('SWAP_ON_LEAVE', `${counterpart.name} is on leave on ${input.date}.`)
  if (input.counterDate !== input.date) {
    const taken = shiftOn(counterpart.id, input.date)
    if (taken) throw new RuleError('SWAP_DOUBLE_SHIFT', `${counterpart.name} already works ${shiftName(taken)} on ${input.date}.`)
    const own = input.counterDate ? shiftOn(requester.id, input.counterDate) : null
    if (own) throw new RuleError('SWAP_DOUBLE_SHIFT', `${requester.name} already works ${shiftName(own)} on ${input.counterDate}.`)
  }
  const touches = (s: ShiftSwap, employeeId: string, date: string | null) => Boolean(date) && ((s.requesterId === employeeId && s.date === date) || (s.counterpartId === employeeId && s.counterDate === date))
  const open = w.swaps.find((s) => s.id !== ignoreId && swapOpen(s) && (touches(s, requester.id, input.date) || touches(s, counterpart.id, input.counterDate)))
  if (open) throw new RuleError('SWAP_OPEN_EXISTS', `${open.number} is already open on that shift.`)
  return { mine, theirs }
}

/** The roster cells an approved swap writes. */
export function swapAssignments(swap: Pick<ShiftSwap, 'requesterId' | 'counterpartId' | 'date' | 'counterDate'>, mine: ShiftAssignment, theirs: ShiftAssignment | null): ShiftAssignmentInput[] {
  const cell = (employeeId: string, date: string, shiftId: string | null): ShiftAssignmentInput => ({ employeeId, date, shiftId, villaId: mine.villaId })
  if (!theirs || !swap.counterDate) return [cell(swap.requesterId, swap.date, null), cell(swap.counterpartId, swap.date, mine.shiftId)]
  if (swap.counterDate === swap.date) return [cell(swap.requesterId, swap.date, theirs.shiftId), cell(swap.counterpartId, swap.date, mine.shiftId)]
  return [cell(swap.requesterId, swap.date, null), cell(swap.counterpartId, swap.date, mine.shiftId), cell(swap.counterpartId, swap.counterDate, null), cell(swap.requesterId, swap.counterDate, theirs.shiftId)]
}

/**
 * Moves a swap one step. The coworker accepts or declines, the requester cancels, and whoever
 * edits the roster approves or rejects an accepted swap; a rejection says why.
 */
export function moveSwap(swap: ShiftSwap, action: SwapAction, actor: { employeeId: string | null; mayApprove: boolean; roleLabel: string }, note: string): SwapStatus {
  const move = SWAP_MOVE[action]
  if (action === 'approve' || action === 'reject') {
    if (!actor.mayApprove) throw new RuleError('FORBIDDEN', `${actor.roleLabel} cannot edit in HR.`)
    if (swap.status === 'offered') throw new RuleError('SWAP_NOT_ACCEPTED', `${swap.number} waits for ${swap.counterpartName} to accept.`)
  } else if (action === 'cancel') {
    if (actor.employeeId !== swap.requesterId) throw new RuleError('FORBIDDEN', `Only ${swap.requesterName} can cancel ${swap.number}.`)
  } else if (actor.employeeId !== swap.counterpartId) throw new RuleError('FORBIDDEN', `Only ${swap.counterpartName} can answer ${swap.number}.`)
  if (!move.from.includes(swap.status)) throw new RuleError('SWAP_INVALID_STATE', `${swap.number} is ${swap.status}; it can no longer change.`)
  if (action === 'reject' && note.trim().length < 3) throw new RuleError('VALIDATION_ERROR', 'Say why.')
  return move.to
}

/** A coworker as the team page shows them: the name, the position and the roster, nothing else. */
export interface TeamMember {
  id: string
  name: string
  position: string
  villaIds: readonly string[]
  assignments: readonly ShiftAssignment[]
}

/** How far ahead the team roster reaches, today included. */
export const TEAM_DAYS = 14
