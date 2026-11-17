import type { Action, Module, User } from '@/domain/access'
import type { Attendance, LeaveRequest, Shift, ShiftAssignment } from '@/domain/hr'
import type { Catalog, Villa } from '@/domain/property'
import { clockAction, leaveBalances, openClock, swapOpen, TEAM_DAYS, validateAttendanceSettings, validateSwap, type AttendanceSettings, type ClockInput, type GeoPoint, type ShiftSwap, type SwapAction, type SwapInput, type TeamMember } from '@/domain/selfService'
import { addDays, eachDay, type IsoDate } from '@/lib/dates'
import type { Ports } from './ports'
import type { AttendanceView, EmployeeView } from './views'

/** What the employee does for themselves: the clock, shift swaps and the roster of their villa coworkers. */
export interface SelfServicePort {
  /** Stamps the signed-in employee's clock-in with the server's time. */
  clockIn(input: ClockInput): Promise<Attendance>
  clockOut(input: { geo: GeoPoint | null }): Promise<Attendance>
  attendanceSettings(): Promise<AttendanceSettings>
  saveAttendanceSettings(settings: AttendanceSettings): Promise<AttendanceSettings>
  /** The signed-in employee and everyone who shares a villa with them: names and the coming shifts only. */
  team(): Promise<TeamMember[]>
  /** Swaps the signed-in employee is part of; with HR view, every swap in scope. */
  swaps(): Promise<ShiftSwap[]>
  requestSwap(input: SwapInput): Promise<ShiftSwap>
  moveSwap(id: string, action: SwapAction, note: string): Promise<ShiftSwap>
}

export interface SwapView extends ShiftSwap {
  shift: Shift | null
  counterShift: Shift | null
  villaName: string
}

interface Deps {
  ports: Ports
  today: () => IsoDate
  access: () => Promise<{ user: User }>
  allow: (module: Module, action: Action) => Promise<User>
  catalog: () => Promise<Catalog>
  check: (errors: Record<string, string | undefined>) => void
}

/** The hr tables the employee area reads, as hrWorld loads them. */
interface World {
  cat: { villas: readonly Villa[] }
  shifts: readonly Shift[]
  assignments: readonly ShiftAssignment[]
  attendance: readonly AttendanceView[]
  leaves: readonly LeaveRequest[]
}

const NOT_LINKED = { form: 'Your login is not linked to an employee record.' }

export function createSelfServices({ ports, today, access, allow, catalog, check }: Deps) {
  const describe = (shifts: readonly Shift[], villas: readonly Villa[]) => (s: ShiftSwap): SwapView => ({
    ...s,
    shift: shifts.find((x) => x.id === s.shiftId) ?? null,
    counterShift: shifts.find((x) => x.id === s.counterShiftId) ?? null,
    villaName: villas.find((v) => v.id === s.villaId)?.name ?? s.villaId,
  })
  const newestOpenFirst = (a: ShiftSwap, b: ShiftSwap) => Number(swapOpen(b)) - Number(swapOpen(a)) || b.requestedOn.localeCompare(a.requestedOn) || b.number.localeCompare(a.number)

  return {
    /** The clock, the leave balance, the swaps and the team roster of one employee, for the employee pages. */
    async area(w: World, employee: EmployeeView | null) {
      if (!employee) return { clock: null, leaveBalances: [], swaps: [], team: [] }
      const now = today()
      const [team, swaps] = await Promise.all([ports.selfService.team(), ports.selfService.swaps()])
      const rowOn = (date: IsoDate) => w.attendance.find((a) => a.employeeId === employee.id && a.date === date)
      const assignmentOn = (date: IsoDate) => w.assignments.find((a) => a.employeeId === employee.id && a.date === date)
      const shiftOn = (date: IsoDate) => w.shifts.find((x) => x.id === assignmentOn(date)?.shiftId) ?? null
      const yesterday = addDays(now, -1)
      const days = eachDay(now, addDays(now, TEAM_DAYS))
      return {
        clock: {
          action: clockAction(rowOn(now), rowOn(yesterday), shiftOn(yesterday)),
          /** The row the next press closes, else today's. */
          row: openClock(rowOn(now), rowOn(yesterday), shiftOn(yesterday)) ?? rowOn(now) ?? null,
          shift: shiftOn(now),
          villa: w.cat.villas.find((v) => v.id === assignmentOn(now)?.villaId) ?? null,
        },
        leaveBalances: leaveBalances(employee, w.leaves, now.slice(0, 4)),
        swaps: swaps.filter((s) => s.requesterId === employee.id || s.counterpartId === employee.id).sort(newestOpenFirst).map(describe(w.shifts, w.cat.villas)),
        /** Themselves first, then coworkers by name. */
        team: [...team]
          .sort((x, y) => Number(y.id === employee.id) - Number(x.id === employee.id) || x.name.localeCompare(y.name))
          .map((m) => ({
            id: m.id,
            name: m.name,
            position: m.position,
            days: days.map((date) => {
              const asg = m.assignments.find((a) => a.date === date) ?? null
              return { date, assigned: Boolean(asg), villaId: asg?.villaId ?? null, shift: asg?.shiftId ? (w.shifts.find((x) => x.id === asg.shiftId) ?? null) : null }
            }),
          })),
      }
    },
    clockIn: (input: ClockInput) => ports.selfService.clockIn(input),
    clockOut: (geo: GeoPoint | null) => ports.selfService.clockOut({ geo }),
    attendanceSettings: () => ports.selfService.attendanceSettings(),
    async saveAttendanceSettings(settings: AttendanceSettings) {
      await allow('hr', 'edit')
      check(validateAttendanceSettings(settings))
      return ports.selfService.saveAttendanceSettings(settings)
    },
    /** Every swap the user may see in their villas, open ones first, for the roster page. */
    async swaps() {
      const [cat, shifts, swaps] = await Promise.all([catalog(), ports.hr.shifts(), ports.selfService.swaps()])
      const villaIds = new Set(cat.villas.map((v) => v.id))
      return swaps.filter((s) => villaIds.has(s.villaId)).sort(newestOpenFirst).map(describe(shifts, cat.villas))
    },
    async requestSwap(input: SwapInput) {
      const { user } = await access()
      check(user.employeeId ? validateSwap(input, user.employeeId) : NOT_LINKED)
      return ports.selfService.requestSwap(input)
    },
    async moveSwap(id: string, action: SwapAction, note = '') {
      if (action === 'approve' || action === 'reject') await allow('hr', 'edit')
      if (action === 'reject') check({ note: note.trim().length < 3 ? 'Say why.' : undefined })
      return ports.selfService.moveSwap(id, action, note)
    },
  }
}
