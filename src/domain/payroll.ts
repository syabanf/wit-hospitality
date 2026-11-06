import { daysBetween, type IsoDate } from '@/lib/dates'
import type { Attendance, Employee, Loan, OvertimeRequest } from './hr'

/**
 * Payroll rules the client configures. Percentages are of the basic salary; the tax is the
 * simplified monthly PPh 21 (gross less employee BPJS less the monthly PTKP, taxed in two bands).
 */
export interface PayrollSettings {
  workingDaysPerMonth: number
  /** Hourly overtime = basic / divisor × multiplier (government formula: 1/173 × 1.5). */
  overtimeDivisor: number
  overtimeMultiplier: number
  lateDeductionPerMinute: number
  /** Minutes late before any deduction applies. */
  lateGraceMinutes: number
  bpjsHealthEmployeePct: number
  bpjsHealthCompanyPct: number
  bpjsEmploymentEmployeePct: number
  bpjsEmploymentCompanyPct: number
  /** Monthly non-taxable income (PTKP ÷ 12). */
  ptkpMonthly: number
  pph21LowerPct: number
  /** Taxable amount per month above which the upper rate applies. */
  pph21Band: number
  pph21UpperPct: number
  /** Month number (1 to 12) in which THR is paid, one basic salary for a full year of service. */
  thrMonth: number
  /** Share of the month's service charge pool (Service charge payable billed on the folio) paid out, split evenly between eligible staff. */
  serviceChargePct: number
}

export const DEFAULT_PAYROLL_SETTINGS: PayrollSettings = {
  workingDaysPerMonth: 25,
  overtimeDivisor: 173,
  overtimeMultiplier: 1.5,
  lateDeductionPerMinute: 1_000,
  lateGraceMinutes: 10,
  bpjsHealthEmployeePct: 1,
  bpjsHealthCompanyPct: 4,
  bpjsEmploymentEmployeePct: 3,
  bpjsEmploymentCompanyPct: 6.24,
  ptkpMonthly: 4_500_000,
  pph21LowerPct: 5,
  pph21Band: 5_000_000,
  pph21UpperPct: 15,
  thrMonth: 3,
  serviceChargePct: 100,
}

export function validatePayrollSettings(s: PayrollSettings): Partial<Record<keyof PayrollSettings, string>> {
  const errors: Partial<Record<keyof PayrollSettings, string>> = {}
  const pct = (k: keyof PayrollSettings) => {
    const v = s[k]
    if (!(v >= 0 && v <= 100)) errors[k] = 'A percentage from 0 to 100.'
  }
  if (!Number.isInteger(s.workingDaysPerMonth) || s.workingDaysPerMonth < 20 || s.workingDaysPerMonth > 31) errors.workingDaysPerMonth = '20 to 31 days.'
  if (!(s.overtimeDivisor > 0)) errors.overtimeDivisor = 'Above zero.'
  if (!(s.overtimeMultiplier >= 1)) errors.overtimeMultiplier = 'At least 1.'
  if (!Number.isInteger(s.lateDeductionPerMinute) || s.lateDeductionPerMinute < 0) errors.lateDeductionPerMinute = 'Whole rupiah, zero or more.'
  if (!Number.isInteger(s.lateGraceMinutes) || s.lateGraceMinutes < 0) errors.lateGraceMinutes = 'Whole minutes, zero or more.'
  for (const k of ['bpjsHealthEmployeePct', 'bpjsHealthCompanyPct', 'bpjsEmploymentEmployeePct', 'bpjsEmploymentCompanyPct', 'pph21LowerPct', 'pph21UpperPct', 'serviceChargePct'] as const) pct(k)
  if (!Number.isInteger(s.ptkpMonthly) || s.ptkpMonthly < 0) errors.ptkpMonthly = 'Whole rupiah, zero or more.'
  if (!Number.isInteger(s.pph21Band) || s.pph21Band <= 0) errors.pph21Band = 'Whole rupiah above zero.'
  if (!Number.isInteger(s.thrMonth) || s.thrMonth < 1 || s.thrMonth > 12) errors.thrMonth = 'A month from 1 to 12.'
  return errors
}

export type PayrollStatus = 'draft' | 'calculated' | 'approved' | 'closed'
export const PAYROLL_STATUSES: readonly PayrollStatus[] = ['draft', 'calculated', 'approved', 'closed']
export const PAYROLL_STATUS_LABEL: Record<PayrollStatus, string> = { draft: 'Draft', calculated: 'Calculated', approved: 'Approved', closed: 'Closed' }
export const PAYROLL_TRANSITIONS: Record<PayrollStatus, readonly PayrollStatus[]> = {
  draft: ['calculated'],
  calculated: ['approved', 'draft'],
  approved: ['closed', 'draft'],
  closed: [],
}
export const canTransitionPayroll = (p: Pick<PayrollPeriod, 'status'>, to: PayrollStatus) => PAYROLL_TRANSITIONS[p.status].includes(to)

export type AdjustmentKind = 'bonus' | 'reimbursement' | 'deduction' | 'other'
export const ADJUSTMENT_KINDS: readonly AdjustmentKind[] = ['bonus', 'reimbursement', 'deduction', 'other']
export const ADJUSTMENT_KIND_LABEL: Record<AdjustmentKind, string> = { bonus: 'Bonus', reimbursement: 'Reimbursement', deduction: 'Deduction', other: 'Other' }

/** A manual change to one payslip, kept with its reason and author. */
export interface PayrollAdjustment {
  id: string
  kind: AdjustmentKind
  /** Positive adds to pay; a deduction is stored negative. */
  amount: number
  reason: string
  by: string
  on: IsoDate
}

export interface PayrollAdjustmentInput {
  kind: AdjustmentKind
  amount: number
  reason: string
}

export function validateAdjustment(input: PayrollAdjustmentInput): Partial<Record<keyof PayrollAdjustmentInput, string>> {
  const errors: Partial<Record<keyof PayrollAdjustmentInput, string>> = {}
  if (!ADJUSTMENT_KINDS.includes(input.kind)) errors.kind = 'Pick the kind.'
  if (!Number.isInteger(input.amount) || input.amount <= 0) errors.amount = 'Enter a whole rupiah amount above zero.'
  if (input.reason.trim().length < 5) errors.reason = 'Give the reason; it stays on the payslip.'
  return errors
}

export interface VillaShare {
  villaId: string
  percent: number
  amount: number
}

/** One employee's pay for the month, every component shown so the payslip explains itself. */
export interface PayrollLine {
  employeeId: string
  employeeName: string
  basic: number
  allowances: number
  overtimeHours: number
  overtimePay: number
  serviceCharge: number
  thr: number
  bonus: number
  reimbursement: number
  gross: number
  lateMinutes: number
  lateDeduction: number
  absentDays: number
  absentDeduction: number
  loanDeduction: number
  bpjsHealth: number
  bpjsEmployment: number
  pph21: number
  otherDeduction: number
  deductions: number
  net: number
  /** Company-side BPJS, part of the villa cost but not of the payslip. */
  companyBpjs: number
  adjustments: readonly PayrollAdjustment[]
  allocation: readonly VillaShare[]
}

export interface PayrollEvent {
  kind: 'created' | 'calculated' | 'approved' | 'closed' | 'reopened' | 'published'
  by: string
  on: IsoDate
  note: string
}

export interface PayrollPeriod {
  id: string
  /** "YYYY-MM". */
  month: string
  status: PayrollStatus
  lines: readonly PayrollLine[]
  /** The service charge pool: Service charge payable the folio billed in the month. */
  revenueBase: number
  history: readonly PayrollEvent[]
  /** Set on closing: the cash-out entry on the bank for the net pay. */
  transactionId: string | null
  paidFromAccountId: string | null
  /** Payslips are visible to employees after publishing. */
  published: boolean
}

export const periodLabel = (month: string) => {
  const [y, m] = month.split('-')
  return `${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][Number(m) - 1]} ${y}`
}

export interface LineInputs {
  employee: Employee
  settings: PayrollSettings
  /** "YYYY-MM". */
  month: string
  attendance: readonly Attendance[]
  overtime: readonly OvertimeRequest[]
  loans: readonly Loan[]
  adjustments: readonly PayrollAdjustment[]
  /** This employee's share of the month's service charge pool, already split. */
  serviceCharge: number
}

const round = (v: number) => Math.round(v)
const pct = (base: number, p: number) => round((base * p) / 100)

/** Months of service completed at the first of `month`. */
export function tenureMonths(joinedOn: IsoDate, month: string): number {
  const first = `${month}-01`
  if (joinedOn > first) return 0
  return Math.floor(daysBetween(joinedOn, first) / 30.4375)
}

/** THR in the configured month: one basic salary after a year, pro rata from one month of service. */
export function thrFor(employee: Employee, settings: PayrollSettings, month: string): number {
  if (Number(month.slice(5, 7)) !== settings.thrMonth) return 0
  const months = Math.min(12, tenureMonths(employee.joinedOn, month))
  if (months < 1) return 0
  return round((employee.basicSalary * months) / 12)
}

/** Simplified monthly PPh 21: two bands over the amount above PTKP. */
export function pph21(gross: number, employeeBpjs: number, s: PayrollSettings): number {
  const taxable = gross - employeeBpjs - s.ptkpMonthly
  if (taxable <= 0) return 0
  const lower = Math.min(taxable, s.pph21Band)
  const upper = Math.max(0, taxable - s.pph21Band)
  return round((lower * s.pph21LowerPct) / 100 + (upper * s.pph21UpperPct) / 100)
}

export function computeLine(i: LineInputs): PayrollLine {
  const { employee: e, settings: s, month } = i
  const inMonth = (iso: IsoDate) => iso.startsWith(month)
  const mine = i.attendance.filter((a) => a.employeeId === e.id && inMonth(a.date))
  const lateMinutesTotal = mine.filter((a) => a.status === 'late').reduce((sum, a) => sum + Math.max(0, a.lateMinutes - s.lateGraceMinutes), 0)
  const absentDays = mine.filter((a) => a.status === 'absent').length
  const overtimeHours = i.overtime.filter((o) => o.employeeId === e.id && o.status === 'approved' && inMonth(o.date)).reduce((sum, o) => sum + o.hours, 0)
  const hourly = (e.basicSalary / s.overtimeDivisor) * s.overtimeMultiplier
  const allowances = e.allowances.reduce((sum, a) => sum + a.amount, 0)
  const bonus = i.adjustments.filter((a) => a.kind === 'bonus').reduce((sum, a) => sum + a.amount, 0)
  const reimbursement = i.adjustments.filter((a) => a.kind === 'reimbursement').reduce((sum, a) => sum + a.amount, 0)
  const otherPlus = i.adjustments.filter((a) => a.kind === 'other' && a.amount > 0).reduce((sum, a) => sum + a.amount, 0)
  const otherMinus = i.adjustments.filter((a) => (a.kind === 'other' && a.amount < 0) || a.kind === 'deduction').reduce((sum, a) => sum + Math.abs(a.amount), 0)
  const thr = thrFor(e, s, month)
  const overtimePay = round(overtimeHours * hourly)
  const serviceCharge = e.serviceChargeEligible ? i.serviceCharge : 0
  const gross = e.basicSalary + allowances + overtimePay + serviceCharge + thr + bonus + reimbursement + otherPlus
  const lateDeduction = lateMinutesTotal * s.lateDeductionPerMinute
  const absentDeduction = round((e.basicSalary / s.workingDaysPerMonth) * absentDays)
  const loanDeduction = i.loans.filter((l) => l.employeeId === e.id && l.status === 'active' && l.startMonth <= month).reduce((sum, l) => sum + Math.min(l.monthly, Math.max(0, l.amount - l.repaid)), 0)
  const bpjsHealth = e.bpjsEnrolled ? pct(e.basicSalary, s.bpjsHealthEmployeePct) : 0
  const bpjsEmployment = e.bpjsEnrolled ? pct(e.basicSalary, s.bpjsEmploymentEmployeePct) : 0
  const companyBpjs = e.bpjsEnrolled ? pct(e.basicSalary, s.bpjsHealthCompanyPct) + pct(e.basicSalary, s.bpjsEmploymentCompanyPct) : 0
  const tax = pph21(gross - reimbursement, bpjsHealth + bpjsEmployment, s)
  const deductions = lateDeduction + absentDeduction + loanDeduction + bpjsHealth + bpjsEmployment + tax + otherMinus
  const net = Math.max(0, gross - deductions)
  const allocation: VillaShare[] = e.allocations.map((a) => ({ villaId: a.villaId, percent: a.percent, amount: round(((net + companyBpjs) * a.percent) / 100) }))
  return {
    employeeId: e.id,
    employeeName: e.name,
    basic: e.basicSalary,
    allowances,
    overtimeHours,
    overtimePay,
    serviceCharge,
    thr,
    bonus,
    reimbursement,
    gross,
    lateMinutes: lateMinutesTotal,
    lateDeduction,
    absentDays,
    absentDeduction,
    loanDeduction,
    bpjsHealth,
    bpjsEmployment,
    pph21: tax,
    otherDeduction: otherMinus,
    deductions,
    net,
    companyBpjs,
    adjustments: i.adjustments,
    allocation,
  }
}

/** Equal split of the pool among eligible employees. */
export function serviceChargeShare(revenue: number, settings: PayrollSettings, eligible: number): number {
  if (eligible <= 0) return 0
  return Math.floor((revenue * settings.serviceChargePct) / 100 / eligible / 1000) * 1000
}

export interface PayrollTotals {
  employees: number
  gross: number
  deductions: number
  net: number
  companyBpjs: number
  /** Net pay plus company BPJS: what the villas carry. */
  cost: number
}

export function periodTotals(lines: readonly PayrollLine[]): PayrollTotals {
  const sum = (pick: (l: PayrollLine) => number) => lines.reduce((s, l) => s + pick(l), 0)
  const net = sum((l) => l.net)
  const companyBpjs = sum((l) => l.companyBpjs)
  return { employees: lines.length, gross: sum((l) => l.gross), deductions: sum((l) => l.deductions), net, companyBpjs, cost: net + companyBpjs }
}

/** Payroll cost per villa for one period, from the allocations. */
export function costByVilla(lines: readonly PayrollLine[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const l of lines) for (const a of l.allocation) out.set(a.villaId, (out.get(a.villaId) ?? 0) + a.amount)
  return out
}
