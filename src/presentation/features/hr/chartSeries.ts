import type { AttendanceStatus } from '@/domain/hr'
import { seriesColor } from '../../charts/colors'

/** One colour per attendance status, shared by every HR chart so a legend reads the same everywhere. */
export const ATTENDANCE_SERIES: ReadonlyArray<{ id: Exclude<AttendanceStatus, 'off'>; label: string; color: string }> = [
  { id: 'present', label: 'Present', color: seriesColor(2) },
  { id: 'late', label: 'Late', color: seriesColor(3) },
  { id: 'absent', label: 'Absent', color: seriesColor(1) },
  { id: 'leave', label: 'On leave', color: seriesColor(4) },
]

/** Slices for a donut from the four attendance counts; empty statuses are dropped. */
export function attendanceSlices(counts: Record<Exclude<AttendanceStatus, 'off'>, number>) {
  return ATTENDANCE_SERIES.map((s) => ({ id: s.id, label: s.label, value: counts[s.id], color: s.color })).filter((s) => s.value > 0)
}

/** Payroll components as chart series: what the company pays, what is withheld, what the employee receives. */
export const PAY_SERIES = [
  { id: 'gross', label: 'Gross', color: seriesColor(2) },
  { id: 'deductions', label: 'Deductions', color: seriesColor(1) },
  { id: 'net', label: 'Net', color: seriesColor(4) },
] as const
