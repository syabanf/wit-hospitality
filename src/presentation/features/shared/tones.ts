import type { BookingStatus, NightState } from '@/domain/booking'
import type { TransactionStatus } from '@/domain/finance'
import type { ServiceStatus } from '@/domain/roomService'
import type { AttendanceStatus, EmployeeStatus, LoanStatus, RequestStatus } from '@/domain/hr'
import type { PayrollStatus } from '@/domain/payroll'
import type { KpiBand } from '@/domain/people'
import type { Tone } from '../../ui/Badge'

export const BOOKING_TONE: Record<BookingStatus, Tone> = {
  draft: 'neutral',
  confirmed: 'info',
  checked_in: 'success',
  checked_out: 'neutral',
  cancelled: 'danger',
  no_show: 'danger',
}

export const TRANSACTION_TONE: Record<TransactionStatus, Tone> = {
  draft: 'neutral',
  submitted: 'warning',
  approved: 'info',
  posted: 'success',
  rejected: 'danger',
  reversed: 'danger',
}

export const SERVICE_TONE: Record<ServiceStatus, Tone> = { open: 'info', in_progress: 'warning', done: 'success', cancelled: 'neutral' }

/** Night cells and unit chips: occupied is the inverted surface, blocked is hatched, closed is greyed. */
export const NIGHT_CLASS: Record<NightState, string> = {
  free: 'border border-line-strong bg-raised text-fg',
  occupied: 'bg-invert text-on-invert',
  blocked: 'hatch border border-line-strong bg-control text-muted',
  closed: 'bg-control text-subtle line-through',
}

export const NIGHT_TONE: Record<NightState, Tone> = { free: 'success', occupied: 'neutral', blocked: 'warning', closed: 'danger' }

export const NIGHT_LABEL: Record<NightState, string> = { free: 'Free', occupied: 'Occupied', blocked: 'Blocked', closed: 'Closed' }

export const REQUEST_TONE: Record<RequestStatus, Tone> = { pending: 'warning', approved: 'success', rejected: 'danger', cancelled: 'neutral' }
export const LOAN_TONE: Record<LoanStatus, Tone> = { ...REQUEST_TONE, active: 'info', settled: 'success' }
export const ATTENDANCE_TONE: Record<AttendanceStatus, Tone> = { present: 'success', late: 'warning', absent: 'danger', leave: 'info', off: 'neutral' }
export const EMPLOYEE_TONE: Record<EmployeeStatus, Tone> = { active: 'success', probation: 'info', inactive: 'neutral' }
export const PAYROLL_TONE: Record<PayrollStatus, Tone> = { draft: 'neutral', calculated: 'warning', approved: 'info', closed: 'success' }
export const KPI_TONE: Record<KpiBand, Tone> = { exceeds: 'success', meets: 'info', below: 'danger' }
