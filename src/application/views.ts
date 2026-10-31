import type { Attachment } from '@/domain/attachment'
import type { Role } from '@/domain/access'
import type { AirbnbAccount, Listing } from '@/domain/airbnb'
import type { Booking, NightState, UnitBlock } from '@/domain/booking'
import type { CashAccount, Category, Transaction, TransactionStatus } from '@/domain/finance'
import type { AgingBucket, Payment, PaymentLink } from '@/domain/payment'
import type { Guest } from '@/domain/guest'
import type { Attendance, Employee, LeaveRequest, Loan, OvertimeRequest, Shift } from '@/domain/hr'
import type { Asset, HousekeepingRecord, HousekeepingState, PlanState, PreventivePlan, Vendor, WorkOrder } from '@/domain/maintenance'
import type { KpiReview } from '@/domain/people'
import type { ServiceRequest } from '@/domain/roomService'
import type { Location, Unit, UnitPlace, Villa } from '@/domain/property'
import type { Period } from '@/domain/dashboard'
import type { IsoDate } from '@/lib/dates'

/** A booking with everything a row or a record page prints. */
export interface BookingView extends Booking {
  guest: Guest
  guestName: string
  place: UnitPlace
  unitCode: string
  account: AirbnbAccount | null
  sourceLabel: string
  nights: number
  total: number
  /** Total less the Airbnb fee. */
  payout: number
}

export interface TransactionView extends Transaction {
  category: Category
  categoryName: string
  account: CashAccount
  accountName: string
  location: Location
  villa: Villa | null
  unit: Unit | null
  /** Roles that sign, in order, with how many have. */
  levels: readonly Role[]
  nextApprover: Role | null
}

export interface DashboardFilter {
  period: Period
  /** Custom inclusive dates; when set they replace the period preset. */
  from?: string
  to?: string
  locationId?: string
  villaId?: string
  unitId?: string
  /** "direct" or an Airbnb account id. */
  source?: string
}

export interface Metric {
  value: number
  previous: number
  change: number | null
}

export interface UnitRow {
  place: UnitPlace
  tonight: NightState
  listing: Listing | null
  account: AirbnbAccount | null
  nextArrival: BookingView | null
}

export interface BlockView extends UnitBlock {
  place: UnitPlace
}

export interface CalendarSpan {
  kind: 'booking' | 'block'
  id: string
  start: number
  length: number
  label: string
  slot: number
  status: string
  /** True when the stay started before the visible window. */
  clippedStart: boolean
  clippedEnd: boolean
}

export interface CalendarRow {
  place: UnitPlace
  spans: CalendarSpan[]
  /** Night states per visible day, for the free cells. */
  states: NightState[]
}

export interface ServiceRequestView extends ServiceRequest {
  place: UnitPlace
  unitCode: string
  booking: BookingView | null
  guestName: string | null
}

export interface GuestRow extends Guest {
  stays: number
  nights: number
  spent: number
  lastStay: IsoDate | null
  inHouse: boolean
}

export interface EmployeeView extends Employee {
  villas: readonly Villa[]
  villaNames: string
  /** Annual leave days left this year. */
  leaveLeft: number
  tenureMonths: number
  openLoan: Loan | null
}

export interface AttendanceView extends Attendance {
  employeeName: string
  shift: Shift | null
}

export interface LeaveView extends LeaveRequest {
  employeeName: string
}

export interface OvertimeView extends OvertimeRequest {
  employeeName: string
  villaName: string
}

export interface LoanView extends Loan {
  employeeName: string
  outstanding: number
}

export interface KpiView extends KpiReview {
  employeeName: string
  score: number
}

/** A generic report: typed columns so one page renders any of them, with CSV export. */
export type ReportColumnKind = 'text' | 'money' | 'number' | 'percent' | 'date'

export interface ReportColumn {
  key: string
  header: string
  kind: ReportColumnKind
  /** Sum this column in the totals row. */
  total?: boolean
}

export type ReportRow = Record<string, string | number | null>

export interface ReportResult {
  slug: string
  title: string
  blurb: string
  columns: readonly ReportColumn[]
  rows: readonly ReportRow[]
  /** The range the figures cover, inclusive dates. */
  from: IsoDate
  to: IsoDate
}

export interface WorkOrderView extends WorkOrder {
  villaName: string
  locationId: string
  locationName: string
  unitCode: string
  assetName: string
  assigneeName: string
  vendorName: string
  partsTotal: number
  total: number
  /** Expense lines by the state of their ledger entries. */
  spent: { recorded: number; approved: number; posted: number }
  /** Scheduled date passed and the job is still open. */
  late: boolean
}

export interface AssetView extends Asset {
  villaName: string
  unitCode: string
  workOrders: number
  costToDate: number
  openJobs: number
  inWarranty: boolean
}

export interface VendorView extends Vendor {
  workOrders: number
  openJobs: number
  spend: number
}

export interface PlanView extends PreventivePlan {
  villaName: string
  unitCode: string
  assetName: string
  assigneeName: string
  vendorName: string
  state: PlanState
  openWorkOrderId: string | null
}

export interface HousekeepingRow {
  place: UnitPlace
  record: HousekeepingRecord | null
  state: HousekeepingState
  /** The open job holding the unit, when out of order. */
  blockingWorkOrder: WorkOrderView | null
  arrival: BookingView | null
  departure: BookingView | null
  inHouse: BookingView | null
}

export interface PaymentView extends Payment {
  bookingCode: string
  guestName: string
  unitCode: string
  villaId: string
  villaName: string
  locationId: string
  link: PaymentLink | null
  /** Status of the finance entry the money landed in. */
  transactionStatus: TransactionStatus | null
  transactionNumber: string | null
  /** Receipts on that entry: the transfer slip, the refund proof. */
  proofs: readonly Attachment[]
}

export interface ReceivableRow {
  booking: BookingView
  /** What the booking should bring in: the stay total, or the payout for Airbnb. */
  expected: number
  paid: number
  outstanding: number
  dueOn: IsoDate
  bucket: AgingBucket
  pendingLink: PaymentLink | null
}

export interface InvoiceLine {
  label: string
  detail: string
  amount: number
  /** Settled at the desk, outside the stay balance. */
  separate?: boolean
}

export interface InvoiceView {
  booking: BookingView
  lines: readonly InvoiceLine[]
  total: number
  expected: number
  paid: number
  outstanding: number
  /** Paid above what the stay now costs, after a shorter stay or a cheaper unit; refund it from the payment card. */
  overpaid: number
  dueOn: IsoDate
  payments: readonly PaymentView[]
  links: readonly PaymentLink[]
}
