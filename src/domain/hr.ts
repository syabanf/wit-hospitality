import { daysBetween, weekdayIndex, withinRange, type IsoDate } from '@/lib/dates'

export type EmployeeStatus = 'active' | 'probation' | 'inactive'
export const EMPLOYEE_STATUSES: readonly EmployeeStatus[] = ['active', 'probation', 'inactive']
export const EMPLOYEE_STATUS_LABEL: Record<EmployeeStatus, string> = { active: 'Active', probation: 'Probation', inactive: 'Left' }

export type Department = 'front_desk' | 'housekeeping' | 'maintenance' | 'security' | 'fnb' | 'management' | 'finance'
export const DEPARTMENTS: readonly Department[] = ['front_desk', 'housekeeping', 'maintenance', 'security', 'fnb', 'management', 'finance']
export const DEPARTMENT_LABEL: Record<Department, string> = {
  front_desk: 'Front desk',
  housekeeping: 'Housekeeping',
  maintenance: 'Maintenance',
  security: 'Security',
  fnb: 'Food and beverage',
  management: 'Management',
  finance: 'Finance and admin',
}

export interface Allowance {
  name: string
  amount: number
}

/** How an employee's cost splits across villas; the percentages add up to 100. */
export interface VillaAllocation {
  villaId: string
  percent: number
}

export interface Employee {
  id: string
  code: string
  name: string
  position: string
  department: Department
  status: EmployeeStatus
  joinedOn: IsoDate
  leftOn: IsoDate | null
  phone: string
  email: string
  bankName: string
  bankAccount: string
  npwp: string
  /** Villas this person works at; the allocation says how the cost splits. */
  allocations: readonly VillaAllocation[]
  basicSalary: number
  allowances: readonly Allowance[]
  serviceChargeEligible: boolean
  bpjsEnrolled: boolean
  annualLeaveDays: number
}

export type EmployeeInput = Omit<Employee, 'id' | 'code'> & { code: string }

export const villaIdsOf = (e: Pick<Employee, 'allocations'>) => e.allocations.map((a) => a.villaId)

export function validateEmployee(input: EmployeeInput, employees: readonly Employee[], excludeId?: string): Record<string, string> {
  const errors: Record<string, string> = {}
  if (!/^EMP-\d{3}$/.test(input.code)) errors.code = 'The code is EMP- and three digits, for example EMP-021.'
  else if (employees.some((e) => e.code === input.code && e.id !== excludeId)) errors.code = `${input.code} is already used.`
  if (input.name.trim().length < 2) errors.name = 'Enter the employee’s name.'
  if (input.position.trim().length < 2) errors.position = 'Enter the position.'
  if (!DEPARTMENTS.includes(input.department)) errors.department = 'Pick the department.'
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.joinedOn)) errors.joinedOn = 'Pick the join date.'
  if (input.leftOn && input.leftOn < input.joinedOn) errors.leftOn = 'The leaving date is before the join date.'
  if (input.status === 'inactive' && !input.leftOn) errors.leftOn = 'Record when the employee left.'
  if (input.phone && !/^\+?[\d\s-]{7,}$/.test(input.phone)) errors.phone = 'Enter a phone number with the country code.'
  if (input.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) errors.email = 'Enter a valid email address.'
  if (!Number.isInteger(input.basicSalary) || input.basicSalary <= 0) errors.basicSalary = 'Enter the basic salary in whole rupiah.'
  if (input.allocations.length === 0) errors.allocations = 'Assign at least one villa.'
  else {
    const total = input.allocations.reduce((s, a) => s + a.percent, 0)
    if (total !== 100) errors.allocations = `The villa shares add up to ${total}%, not 100%.`
    if (input.allocations.some((a) => !a.villaId)) errors.allocations = 'Pick a villa for every share.'
    if (new Set(input.allocations.map((a) => a.villaId)).size !== input.allocations.length) errors.allocations = 'A villa is listed twice.'
  }
  if (input.allowances.some((a) => a.name.trim().length < 2 || !Number.isInteger(a.amount) || a.amount < 0)) errors.allowances = 'Each allowance needs a name and a whole rupiah amount.'
  if (!Number.isInteger(input.annualLeaveDays) || input.annualLeaveDays < 0 || input.annualLeaveDays > 30) errors.annualLeaveDays = 'Annual leave is 0 to 30 days.'
  return errors
}

export interface Shift {
  id: string
  name: string
  /** "HH:MM" 24h. */
  start: string
  end: string
}

export interface ShiftAssignment {
  id: string
  employeeId: string
  date: IsoDate
  /** Null is a day off. */
  shiftId: string | null
  villaId: string
}

export interface ShiftAssignmentInput {
  employeeId: string
  date: string
  shiftId: string | null
  villaId: string
}

export type AttendanceStatus = 'present' | 'late' | 'absent' | 'leave' | 'off'
export const ATTENDANCE_STATUSES: readonly AttendanceStatus[] = ['present', 'late', 'absent', 'leave', 'off']
export const ATTENDANCE_STATUS_LABEL: Record<AttendanceStatus, string> = { present: 'Present', late: 'Late', absent: 'Absent', leave: 'On leave', off: 'Day off' }

export interface Attendance {
  id: string
  employeeId: string
  date: IsoDate
  status: AttendanceStatus
  clockIn: string | null
  clockOut: string | null
  lateMinutes: number
  note: string
}

export interface AttendanceInput {
  employeeId: string
  date: string
  status: AttendanceStatus
  clockIn: string | null
  clockOut: string | null
  note: string
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/
export const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))

/** Minutes after the shift start, zero when on time or when no shift is known. */
export function lateMinutes(clockIn: string | null, shift: Shift | null): number {
  if (!clockIn || !shift) return 0
  return Math.max(0, minutesOf(clockIn) - minutesOf(shift.start))
}

export function validateAttendance(input: AttendanceInput): Partial<Record<keyof AttendanceInput, string>> {
  const errors: Partial<Record<keyof AttendanceInput, string>> = {}
  if (!input.employeeId) errors.employeeId = 'Pick the employee.'
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) errors.date = 'Pick the date.'
  if (!ATTENDANCE_STATUSES.includes(input.status)) errors.status = 'Pick the status.'
  if ((input.status === 'present' || input.status === 'late') && !(input.clockIn && TIME.test(input.clockIn))) errors.clockIn = 'Enter the clock-in time as HH:MM.'
  if (input.clockOut && !TIME.test(input.clockOut)) errors.clockOut = 'Enter the clock-out time as HH:MM.'
  if (input.clockIn && input.clockOut && TIME.test(input.clockIn) && TIME.test(input.clockOut) && minutesOf(input.clockOut) <= minutesOf(input.clockIn)) errors.clockOut = 'Clock-out is before clock-in.'
  return errors
}

export type RequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled'
export const REQUEST_STATUSES: readonly RequestStatus[] = ['pending', 'approved', 'rejected', 'cancelled']
export const REQUEST_STATUS_LABEL: Record<RequestStatus, string> = { pending: 'Pending', approved: 'Approved', rejected: 'Rejected', cancelled: 'Cancelled' }

export type LeaveKind = 'annual' | 'sick' | 'permission' | 'unpaid'
export const LEAVE_KINDS: readonly LeaveKind[] = ['annual', 'sick', 'permission', 'unpaid']
export const LEAVE_KIND_LABEL: Record<LeaveKind, string> = { annual: 'Annual leave', sick: 'Sick leave', permission: 'Permission', unpaid: 'Unpaid leave' }

export interface Decision {
  decidedOn: IsoDate | null
  decidedBy: string
  decisionNote: string
}

export interface LeaveRequest extends Decision {
  id: string
  number: string
  employeeId: string
  kind: LeaveKind
  from: IsoDate
  /** Inclusive last day. */
  to: IsoDate
  days: number
  reason: string
  status: RequestStatus
  requestedOn: IsoDate
}

export interface LeaveInput {
  employeeId: string
  kind: LeaveKind
  from: string
  to: string
  reason: string
}

/** Working days Monday to Saturday between two inclusive dates. */
export function leaveDays(from: IsoDate, to: IsoDate): number {
  const n = daysBetween(from, to) + 1
  let days = 0
  for (let i = 0; i < n; i++) {
    const d = new Date(`${from}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() + i)
    if (weekdayIndex(d.toISOString().slice(0, 10)) !== 6) days++
  }
  return days
}

export function validateLeave(input: LeaveInput, employee: Employee | undefined, balance: number): Partial<Record<keyof LeaveInput, string>> {
  const errors: Partial<Record<keyof LeaveInput, string>> = {}
  if (!employee) errors.employeeId = 'Pick the employee.'
  if (!LEAVE_KINDS.includes(input.kind)) errors.kind = 'Pick the kind of leave.'
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.from) || !/^\d{4}-\d{2}-\d{2}$/.test(input.to)) errors.to = 'Pick both dates.'
  else if (input.to < input.from) errors.to = 'The last day is before the first.'
  else if (daysBetween(input.from, input.to) > 30) errors.to = 'A request covers at most 31 days.'
  else if (input.kind === 'annual' && leaveDays(input.from, input.to) > balance) errors.to = `Only ${balance} annual leave days are left.`
  if (input.reason.trim().length < 3) errors.reason = 'Say why.'
  return errors
}

/** Annual days left this year: the entitlement less approved annual leave in the year. */
export function leaveBalance(employee: Employee, leaves: readonly LeaveRequest[], year: string): number {
  const used = leaves.filter((l) => l.employeeId === employee.id && l.kind === 'annual' && l.status === 'approved' && l.from.startsWith(year)).reduce((s, l) => s + l.days, 0)
  return Math.max(0, employee.annualLeaveDays - used)
}

export interface OvertimeRequest extends Decision {
  id: string
  number: string
  employeeId: string
  date: IsoDate
  hours: number
  villaId: string
  reason: string
  status: RequestStatus
  requestedOn: IsoDate
}

export interface OvertimeInput {
  employeeId: string
  date: string
  hours: number
  villaId: string
  reason: string
}

export function validateOvertime(input: OvertimeInput): Partial<Record<keyof OvertimeInput, string>> {
  const errors: Partial<Record<keyof OvertimeInput, string>> = {}
  if (!input.employeeId) errors.employeeId = 'Pick the employee.'
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) errors.date = 'Pick the date.'
  if (!(input.hours >= 0.5 && input.hours <= 8) || Math.round(input.hours * 2) !== input.hours * 2) errors.hours = 'Overtime is 0.5 to 8 hours, in half hours.'
  if (!input.villaId) errors.villaId = 'Pick the villa the hours were worked at.'
  if (input.reason.trim().length < 3) errors.reason = 'Say what the hours were for.'
  return errors
}

export type LoanKind = 'loan' | 'advance'
export const LOAN_KIND_LABEL: Record<LoanKind, string> = { loan: 'Loan', advance: 'Salary advance' }
export type LoanStatus = RequestStatus | 'active' | 'settled'
export const LOAN_STATUS_LABEL: Record<LoanStatus, string> = { ...REQUEST_STATUS_LABEL, active: 'Repaying', settled: 'Settled' }

/** Money lent to an employee and repaid through payroll in equal monthly instalments. */
export interface Loan extends Decision {
  id: string
  number: string
  employeeId: string
  kind: LoanKind
  amount: number
  installments: number
  monthly: number
  repaid: number
  reason: string
  status: LoanStatus
  requestedOn: IsoDate
  /** First payroll month that deducts, "YYYY-MM". */
  startMonth: string
}

export interface LoanInput {
  employeeId: string
  kind: LoanKind
  amount: number
  installments: number
  reason: string
  startMonth: string
}

export const loanOutstanding = (l: Pick<Loan, 'amount' | 'repaid'>) => Math.max(0, l.amount - l.repaid)
export const loanInstalment = (amount: number, installments: number) => Math.ceil(amount / Math.max(1, installments) / 1000) * 1000

export function validateLoan(input: LoanInput, employee: Employee | undefined, openLoans: readonly Loan[]): Partial<Record<keyof LoanInput, string>> {
  const errors: Partial<Record<keyof LoanInput, string>> = {}
  if (!employee) errors.employeeId = 'Pick the employee.'
  if (!Number.isInteger(input.amount) || input.amount <= 0) errors.amount = 'Enter the amount in whole rupiah.'
  else if (employee && input.amount > employee.basicSalary * 3) errors.amount = 'A loan is at most three months of basic salary.'
  if (!Number.isInteger(input.installments) || input.installments < 1 || input.installments > 12) errors.installments = 'Repay over 1 to 12 months.'
  if (input.kind === 'advance' && input.installments !== 1) errors.installments = 'A salary advance is repaid from the next payroll.'
  if (!/^\d{4}-\d{2}$/.test(input.startMonth)) errors.startMonth = 'Pick the first repayment month.'
  if (input.reason.trim().length < 3) errors.reason = 'Say what the money is for.'
  if (employee && openLoans.some((l) => l.employeeId === employee.id && (l.status === 'pending' || l.status === 'active' || l.status === 'approved'))) errors.amount = `${employee.name} still has an open loan.`
  return errors
}

export const REQUEST_TRANSITIONS: Record<RequestStatus, readonly RequestStatus[]> = {
  pending: ['approved', 'rejected', 'cancelled'],
  approved: [],
  rejected: [],
  cancelled: [],
}

export interface HrFilter {
  status?: string
  employeeId?: string
  villaId?: string
  query?: string
  from?: string
  to?: string
}

export function filterByEmployee<T extends { employeeId: string; status: string; employeeName: string }>(list: readonly T[], f: HrFilter, dateOf: (row: T) => IsoDate, villaOf?: (row: T) => string | null): T[] {
  const q = (f.query ?? '').trim().toLowerCase()
  return list.filter((r) => {
    if (f.status && f.status !== 'all' && r.status !== f.status) return false
    if (f.employeeId && r.employeeId !== f.employeeId) return false
    if (f.villaId && villaOf && villaOf(r) !== f.villaId) return false
    if (!withinRange(dateOf(r), f.from, f.to)) return false
    if (q && !r.employeeName.toLowerCase().includes(q)) return false
    return true
  })
}

/** "2026-10" from a date. */
export const monthOf = (iso: IsoDate) => iso.slice(0, 7)
