import type { Attachment } from '@/domain/attachment'
import type { Role } from '@/domain/access'
import type { AirbnbAccount, Listing } from '@/domain/airbnb'
import type { Booking, NightState, UnitBlock } from '@/domain/booking'
import type { BookingGroup, GroupStatus } from '@/domain/group'
import type { StayPrice } from '@/domain/pricing'
import type { StayTax } from '@/domain/tax'
import type { CashAccount, Category, Reconciliation, Transaction, TransactionStatus } from '@/domain/finance'
import type { AgingBucket, Payment, PaymentLink } from '@/domain/payment'
import type { Guest } from '@/domain/guest'
import type { Attendance, Employee, LeaveRequest, Loan, OvertimeRequest, Shift } from '@/domain/hr'
import type { Asset, HousekeepingRecord, HousekeepingState, PlanState, PreventivePlan, Vendor, WorkOrder } from '@/domain/maintenance'
import type { KpiReview } from '@/domain/people'
import type { ServiceRequest } from '@/domain/roomService'
import type { MenuItem, OrderPayState, OrderTotals, ServiceOrder, ServicePartner } from '@/domain/serviceOrder'
import type { Location, Unit, UnitPlace, Villa } from '@/domain/property'
import type { Period } from '@/domain/dashboard'
import type { IsoDate } from '@/lib/dates'

/** A booking with everything a row or a record page prints. */
export interface BookingView extends Booking {
  guest: Guest
  guestName: string
  place: UnitPlace
  /** The room's code, or "Unassigned" while the operator still has to pick one. */
  unitCode: string
  /** The room type the guest booked, for a stay without a room yet. */
  roomType: string | null
  account: AirbnbAccount | null
  sourceLabel: string
  nights: number
  /** What the guest pays for the room: with service and PB1 added when the price reads net. */
  total: number
  /** The room's net, service, PB1 and total, the price mode and the rates the note quotes. */
  taxes: StayTax
  /** List, override, discount and total; the list is the Airbnb listing for direct stays. */
  price: StayPrice
  /** The average a night costs. */
  rate: number
  /** Total less the Airbnb fee. */
  payout: number
  /** The group reservation the stay belongs to, for the chip that links to it. */
  group: Pick<BookingGroup, 'id' | 'code' | 'name' | 'billing' | 'cityLedger'> | null
}

/** A group with its stays and money, for the list and the record. */
export interface GroupRow {
  group: BookingGroup
  leadName: string
  villaNames: string
  stays: BookingView[]
  status: GroupStatus
  checkIn: IsoDate
  checkOut: IsoDate
  /** Unit nights across the stays that earn. */
  nights: number
  guests: number
  total: number
  paid: number
  /** What the stays still owe on their rooms. */
  outstanding: number
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
  /** The group code on a group stay. */
  group?: string
}

export interface CalendarRow {
  key: string
  place: UnitPlace
  /** Set on a lane of stays still waiting for a room: the room type's name. `place` is then a room of that type. */
  lane: string | null
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

/** A room service order with its stay, totals and how it is settled. */
export interface ServiceOrderView extends ServiceOrder {
  place: UnitPlace
  unitCode: string
  bookingCode: string
  guestName: string
  totals: OrderTotals
  payState: OrderPayState
  /** The payment asked for this order, when there is one. */
  paymentNumber: string | null
  late: boolean
  /** Minutes from the requested time to delivery, once delivered. */
  delay: number | null
}

export interface MenuItemView extends MenuItem {
  villaName: string
  partner: ServicePartner | null
  margin: number
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
  /** Room service billed on the stay, settled apart from the room. */
  roomService: { charged: number; paid: number; outstanding: number }
  /** The room's subtotal, service and PB1 with the line the invoice prints about them; absent on views built before tax. */
  tax?: { subtotal: number; service: number; pb1: number; total: number; note: string }
}

/** One petty cash box as the finance service describes it. */
export interface PettyRow {
  account: CashAccount
  villa: Villa | null
  custodian: string
  source: CashAccount | null
  balance: number
  low: boolean
  topUp: number
  spent30: number
  pendingSpend: number
  topUpPending: boolean
  lastCount: Reconciliation | null
}
