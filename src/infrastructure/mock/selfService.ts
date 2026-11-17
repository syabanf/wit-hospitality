import type { SelfServicePort } from '@/application/selfService'
import { can, ROLE_LABEL, type AuditAction, type User } from '@/domain/access'
import { findById, RuleError } from '@/domain/errors'
import { villaIdsOf, type Attendance, type Employee, type ShiftAssignment } from '@/domain/hr'
import { checkClockIn, checkClockOut, checkSwap, clockedIn, moveSwap, openClock, stampGeo, swapAssignments, TEAM_DAYS, validateAttendanceSettings, validateSwap, type GeoPoint, type ShiftSwap, type SwapWorld } from '@/domain/selfService'
import { addDays } from '@/lib/dates'
import type { MockState } from './state'

/** The mock API's shared helpers the employee area needs. */
export interface SelfServiceContext {
  s: MockState
  later: <T>(value: () => T) => Promise<T>
  today: () => string
  /** The server's time of day in the business time zone, "HH:MM". */
  nowTime: () => string
  user: () => User
  seq: (key: string) => number
  refuse: (errors: Record<string, string | undefined>) => void
  log: (action: AuditAction, entity: string, entityId: string, summary: string, before?: Record<string, unknown> | null, after?: Record<string, unknown> | null) => void
}

const SWAP_AUDIT = { accept: 'status', decline: 'status', cancel: 'status', approve: 'approve', reject: 'reject' } as const

/** The clock, shift swaps and the team roster for the mock API, each call in the signed-in employee's name. */
export function createSelfServicePort({ s, later, today, nowTime, user, seq, refuse, log }: SelfServiceContext): SelfServicePort {
  const copy = <T>(v: T): T => structuredClone(v)
  const employeeOf = (u: User) => (u.employeeId ? s.employees.find((e) => e.id === u.employeeId) : undefined)
  const me = () => {
    const e = employeeOf(user())
    if (!e) throw new RuleError('NO_EMPLOYEE_RECORD', 'Your login is not linked to an employee record.')
    return e
  }
  const assignmentOn = (employeeId: string, date: string) => s.assignments.find((a) => a.employeeId === employeeId && a.date === date)
  const shiftOn = (employeeId: string, date: string) => s.shifts.find((x) => x.id === assignmentOn(employeeId, date)?.shiftId) ?? null
  const rowOn = (employeeId: string, date: string) => s.attendance.find((a) => a.employeeId === employeeId && a.date === date)
  /** The position against the villa the roster names that day, else the nearest villa the person works at. */
  const stamp = (e: Employee, date: string, geo: GeoPoint | null) => {
    const rostered = assignmentOn(e.id, date)
    const villaIds = rostered?.shiftId ? [rostered.villaId] : villaIdsOf(e)
    return stampGeo(geo, s.villas.filter((v) => villaIds.includes(v.id)), s.attendanceSettings.radiusMeters)
  }
  const swapWorld = (requester: Employee, counterpart: Employee): SwapWorld => ({
    today: today(),
    requester,
    counterpart,
    assignments: s.assignments,
    leaves: s.leaves,
    shifts: s.shifts,
    swaps: s.swaps,
    villaName: (id) => s.villas.find((v) => v.id === id)?.name ?? id,
  })
  const setCell = (input: Omit<ShiftAssignment, 'id'>) => {
    const existing = assignmentOn(input.employeeId, input.date)
    if (existing) Object.assign(existing, input)
    else s.assignments.push({ id: `asg-${seq('assignment')}`, ...input })
  }

  return {
    clockIn: (input) =>
      later(() => {
        const e = me()
        const date = today()
        const row = rowOn(e.id, date)
        const shift = shiftOn(e.id, date)
        checkClockIn(row, shift, s.leaves.some((l) => l.employeeId === e.id && l.status === 'approved' && l.from <= date && date <= l.to), input.reason)
        const record: Attendance = { id: row?.id ?? `att-${seq('attendance')}`, employeeId: e.id, date, ...clockedIn(nowTime(), shift, input.reason, stamp(e, date, input.geo)) }
        if (row) Object.assign(row, record)
        else s.attendance.push(record)
        log('create', 'attendance', record.id, `${e.name} clocked in at ${record.clockIn}`)
        return copy(record)
      }),
    clockOut: (input) =>
      later(() => {
        const e = me()
        const date = today()
        const yesterday = addDays(date, -1)
        const row = checkClockOut(openClock(rowOn(e.id, date), rowOn(e.id, yesterday), shiftOn(e.id, yesterday)), rowOn(e.id, date))
        row.clockOut = nowTime()
        row.clockOutGeo = stamp(e, row.date, input.geo)
        log('update', 'attendance', row.id, `${e.name} clocked out at ${row.clockOut}`)
        return copy(row)
      }),
    attendanceSettings: () => later(() => copy(s.attendanceSettings)),
    saveAttendanceSettings: (settings) =>
      later(() => {
        refuse(validateAttendanceSettings(settings))
        const before = { ...s.attendanceSettings }
        s.attendanceSettings = { radiusMeters: settings.radiusMeters }
        log('update', 'attendance-settings', 'settings', 'Changed the clock-in radius', before, { ...s.attendanceSettings })
        return copy(s.attendanceSettings)
      }),
    team: () =>
      later(() => {
        const e = employeeOf(user())
        if (!e) return []
        const mine = villaIdsOf(e)
        const from = today()
        const to = addDays(from, TEAM_DAYS)
        return s.employees
          .filter((x) => x.status !== 'inactive' && villaIdsOf(x).some((id) => mine.includes(id)))
          .map((x) => ({ id: x.id, name: x.name, position: x.position, villaIds: villaIdsOf(x), assignments: copy(s.assignments.filter((a) => a.employeeId === x.id && a.date >= from && a.date < to)) }))
      }),
    swaps: () =>
      later(() => {
        const u = user()
        const wide = can(s.permissions, u.role, 'hr', 'view') || can(s.permissions, u.role, 'payroll', 'view')
        return copy(s.swaps.filter((x) => wide || x.requesterId === u.employeeId || x.counterpartId === u.employeeId))
      }),
    requestSwap: (input) =>
      later(() => {
        const e = me()
        refuse(validateSwap(input, e.id))
        const other = findById(s.employees, input.counterpartId, 'employee')
        const { mine, theirs } = checkSwap(input, swapWorld(e, other))
        const n = seq('swap')
        const swap: ShiftSwap = { id: `sw-${n}`, number: `SW-${500 + n}`, villaId: mine.villaId, requesterId: e.id, requesterName: e.name, date: mine.date, shiftId: mine.shiftId ?? '', counterpartId: other.id, counterpartName: other.name, counterDate: theirs?.date ?? null, counterShiftId: theirs?.shiftId ?? null, note: input.note.trim(), status: 'offered', requestedOn: today(), respondedOn: null, decidedOn: null, decidedBy: '', decisionNote: '' }
        s.swaps.push(swap)
        log('create', 'shift-swap', swap.number, `${e.name} offered the shift on ${swap.date} to ${other.name}`)
        return copy(swap)
      }),
    moveSwap: (id, action, note) =>
      later(() => {
        const swap = findById(s.swaps, id, 'shift swap')
        const u = user()
        const before = swap.status
        const to = moveSwap(swap, action, { employeeId: u.employeeId, mayApprove: can(s.permissions, u.role, 'hr', 'edit'), roleLabel: ROLE_LABEL[u.role] }, note)
        if (action === 'accept' || action === 'approve') {
          const { mine, theirs } = checkSwap(swap, swapWorld(findById(s.employees, swap.requesterId, 'employee'), findById(s.employees, swap.counterpartId, 'employee')), swap.id)
          if (action === 'approve') swapAssignments(swap, mine, theirs).forEach(setCell)
        }
        swap.status = to
        if (action === 'accept' || action === 'decline') swap.respondedOn = today()
        else Object.assign(swap, { decidedOn: today(), decidedBy: u.name, decisionNote: note.trim() })
        log(SWAP_AUDIT[action], 'shift-swap', swap.number, `${to.charAt(0).toUpperCase() + to.slice(1)} ${swap.number}`, { status: before }, { status: to })
        return copy(swap)
      }),
  }
}
