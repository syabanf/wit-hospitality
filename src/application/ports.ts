import type { Profile } from '@/domain/account'
import type { AuditEntry, LoginInput, PasswordChange, Permissions, Role, User, UserInput } from '@/domain/access'
import type { AirbnbAccount, AirbnbAccountInput, Listing, ListingInput, ListingStatus } from '@/domain/airbnb'
import type { ApprovalRule, ApprovalRuleInput } from '@/domain/approval'
import type { Booking, BookingSource, BookingStatus, CheckInDetails, CheckOutDetails, PaymentInput as BookingPaymentInput, UnitBlock } from '@/domain/booking'
import type { AdjustmentInput, CashAccount, CashAccountInput, CashTransferInput, Category, Reconciliation, ReconciliationInput, Transaction, TransactionInput, TransactionKind, TransactionOrigin, TransactionStatus } from '@/domain/finance'
import type { Guest, GuestInput } from '@/domain/guest'
import type { Asset, AssetInput, ExpenseInput, HousekeepingRecord, HousekeepingState, InspectionResult, PlanInput, PreventivePlan, Vendor, VendorInput, WorkOrder, WorkOrderInput, WorkOrderSource, WorkOrderStatus } from '@/domain/maintenance'
import type { Attendance, AttendanceInput, Employee, EmployeeInput, LeaveInput, LeaveRequest, Loan, LoanInput, OvertimeInput, OvertimeRequest, RequestStatus, Shift, ShiftAssignment, ShiftAssignmentInput } from '@/domain/hr'
import type { PayrollAdjustmentInput, PayrollPeriod, PayrollSettings, PayrollStatus } from '@/domain/payroll'
import type { Payment, PaymentInput, PaymentLink, PaymentMethod, PaymentKind, PaymentPolicy, PublicCheckout } from '@/domain/payment'
import type { Announcement, AnnouncementInput, KpiInput, KpiReview } from '@/domain/people'
import type { ServiceRequest, ServiceRequestInput, ServiceStatus } from '@/domain/roomService'
import type { GroupInput, Location, LocationInput, PropertyInput, Unit, UnitGroup, UnitInput, Villa, VillaInput } from '@/domain/property'
import type { IsoDate } from '@/lib/dates'

export interface Clock {
  today(): IsoDate
}

export interface PropertyPort {
  locations(): Promise<Location[]>
  villas(): Promise<Villa[]>
  units(): Promise<Unit[]>
  groups(): Promise<UnitGroup[]>
  createLocation(input: LocationInput): Promise<Location>
  updateLocation(id: string, input: LocationInput): Promise<Location>
  createVilla(input: VillaInput): Promise<Villa>
  /** The wizard: villa, its room types and rooms in one transaction. Returns the new villa. */
  createProperty(input: PropertyInput): Promise<Villa>
  updateVilla(id: string, input: VillaInput): Promise<Villa>
  createGroup(input: GroupInput): Promise<UnitGroup>
  updateGroup(id: string, input: GroupInput): Promise<UnitGroup>
  createUnit(input: UnitInput): Promise<Unit>
  updateUnit(id: string, input: UnitInput): Promise<Unit>
}

export interface AirbnbPort {
  accounts(): Promise<AirbnbAccount[]>
  listings(): Promise<Listing[]>
  setListingStatus(id: string, status: ListingStatus): Promise<Listing>
  createAccount(input: AirbnbAccountInput): Promise<AirbnbAccount>
  updateAccount(id: string, input: AirbnbAccountInput): Promise<AirbnbAccount>
  createListing(input: ListingInput): Promise<Listing>
  updateListing(id: string, input: ListingInput): Promise<Listing>
}

export interface NewBooking {
  guestId: string | null
  /** A guest created with the booking when `guestId` is null. */
  newGuest: GuestInput | null
  unitId: string
  source: BookingSource
  airbnbAccountId: string | null
  airbnbCode: string | null
  checkIn: IsoDate
  checkOut: IsoDate
  nightlyRate: number
  notes: string
  /** Save as confirmed straight away instead of as a draft. */
  confirm: boolean
  /** Money taken with the booking: recorded now for cash or transfer, a gateway link otherwise. */
  payment?: { kind: 'deposit' | 'full'; method: PaymentMethod; amount: number; reference: string } | null
}

export type BookingAction = Exclude<BookingStatus, 'draft'>

export interface BookingPort {
  bookings(): Promise<Booking[]>
  blocks(): Promise<UnitBlock[]>
  create(input: NewBooking): Promise<Booking>
  transition(id: string, to: BookingAction): Promise<Booking>
  /** Checks the guest in with the front desk record; the deposit is booked separately through FinancePort. */
  checkIn(id: string, details: CheckInDetails): Promise<Booking>
  checkOut(id: string, details: CheckOutDetails): Promise<Booking>
  moveUnit(id: string, unitId: string, reason: string): Promise<Booking>
  adjustStay(id: string, checkIn: IsoDate, checkOut: IsoDate): Promise<Booking>
  updateNotes(id: string, notes: string): Promise<Booking>
  setPayment(id: string, payment: BookingPaymentInput): Promise<Booking>
  addBlock(input: Omit<UnitBlock, 'id'>): Promise<UnitBlock>
  removeBlock(id: string): Promise<void>
}

export interface GuestPort {
  guests(): Promise<Guest[]>
  create(input: GuestInput): Promise<Guest>
  update(id: string, input: GuestInput): Promise<Guest>
}

export type TransactionAction = Exclude<TransactionStatus, 'draft' | 'reversed'>

export interface CategoryInput {
  name: string
  kind: TransactionKind
  villaIds: readonly string[]
}

export interface FinancePort {
  accounts(): Promise<CashAccount[]>
  createAccount(input: CashAccountInput): Promise<CashAccount>
  updateAccount(id: string, input: CashAccountInput): Promise<CashAccount>
  categories(): Promise<Category[]>
  transactions(): Promise<Transaction[]>
  createTransaction(input: TransactionInput, submit: boolean, origin?: TransactionOrigin): Promise<Transaction>
  /** Approve signs the next level; the status turns approved once every level has signed. Reject needs a note. */
  transition(id: string, to: TransactionAction, note?: string): Promise<Transaction>
  /** Posts a compensating entry and returns it; the original becomes `reversed`. */
  reverse(id: string, reason: string): Promise<Transaction>
  /** Two linked entries, submitted together; returns the cash-out half. */
  transfer(input: CashTransferInput): Promise<Transaction>
  adjust(input: AdjustmentInput): Promise<Transaction>
  reconciliations(): Promise<Reconciliation[]>
  reconcile(input: ReconciliationInput): Promise<Reconciliation>
  createCategory(input: CategoryInput): Promise<Category>
  updateCategory(id: string, input: CategoryInput): Promise<Category>
  setCategoryActive(id: string, active: boolean): Promise<Category>
  approvalRules(): Promise<ApprovalRule[]>
  createRule(input: ApprovalRuleInput): Promise<ApprovalRule>
  updateRule(id: string, input: ApprovalRuleInput): Promise<ApprovalRule>
  deleteRule(id: string): Promise<void>
}

export interface ServicePort {
  requests(): Promise<ServiceRequest[]>
  create(input: ServiceRequestInput): Promise<ServiceRequest>
  update(id: string, input: ServiceRequestInput): Promise<ServiceRequest>
  transition(id: string, to: Exclude<ServiceStatus, 'open'>): Promise<ServiceRequest>
  assign(id: string, assignee: string): Promise<ServiceRequest>
  linkTransaction(id: string, transactionId: string): Promise<ServiceRequest>
}

export interface NewWorkOrder extends WorkOrderInput {
  source?: WorkOrderSource
  planId?: string | null
  /** Hold the unit with a maintenance block from this date (inclusive) to `blockTo` (exclusive). */
  blockFrom?: string | null
  blockTo?: string | null
}

export interface MaintenancePort {
  workOrders(): Promise<WorkOrder[]>
  createWorkOrder(input: NewWorkOrder): Promise<WorkOrder>
  updateWorkOrder(id: string, input: WorkOrderInput): Promise<WorkOrder>
  /** Closing a job trims its block to today and advances its preventive plan. */
  transitionWorkOrder(id: string, to: Exclude<WorkOrderStatus, 'open'>, note: string): Promise<WorkOrder>
  addNote(id: string, note: string): Promise<WorkOrder>
  /** Blocks the unit for the job, or releases the block when `from` is null. */
  setBlock(id: string, from: string | null, to: string | null): Promise<WorkOrder>
  /** Pays for part of the job: a submitted cash-out mapped to the unit, on the cashbox for cash or the bank for a transfer. */
  addExpense(id: string, input: ExpenseInput): Promise<WorkOrder>
  /** Fixes a rejected expense and sends its entry back for approval. */
  correctExpense(id: string, expenseId: string, input: ExpenseInput): Promise<WorkOrder>
  assets(): Promise<Asset[]>
  createAsset(input: AssetInput): Promise<Asset>
  updateAsset(id: string, input: AssetInput): Promise<Asset>
  vendors(): Promise<Vendor[]>
  createVendor(input: VendorInput): Promise<Vendor>
  updateVendor(id: string, input: VendorInput): Promise<Vendor>
  plans(): Promise<PreventivePlan[]>
  createPlan(input: PlanInput): Promise<PreventivePlan>
  updatePlan(id: string, input: PlanInput): Promise<PreventivePlan>
  /** Opens a work order for every active plan due within `horizonDays` that has none open. */
  generateDue(horizonDays: number): Promise<WorkOrder[]>
  housekeeping(): Promise<HousekeepingRecord[]>
  setHousekeeping(unitId: string, state: HousekeepingState, note: string): Promise<HousekeepingRecord>
  /** Records an inspection; all passed moves the room to inspected, a failure back to dirty. */
  inspect(unitId: string, results: readonly InspectionResult[], raiseWorkOrder: boolean): Promise<{ record: HousekeepingRecord; workOrder: WorkOrder | null }>
}

export interface NewPaymentLink {
  bookingId: string
  kind: PaymentKind
  method: PaymentMethod
  amount: number
  payer: string
}

export interface PaymentPort {
  payments(): Promise<Payment[]>
  links(): Promise<PaymentLink[]>
  policy(): Promise<PaymentPolicy>
  savePolicy(policy: PaymentPolicy): Promise<PaymentPolicy>
  /** Money taken now (cash, bank transfer, payout): a paid payment and a submitted cash-in. */
  record(input: PaymentInput): Promise<Payment>
  /** A pending payment and the gateway link the guest opens. */
  createLink(input: NewPaymentLink): Promise<PaymentLink>
  cancelLink(token: string): Promise<PaymentLink>
  /** Gives money back on a paid payment: a refund payment and a submitted cash-out. */
  refund(paymentId: string, amount: number, reason: string): Promise<Payment>
  /** Public, no session: the guest-facing view of a link. */
  checkout(token: string): Promise<PublicCheckout>
  /** Public, no session: the gateway reports the outcome; demo only. */
  settle(token: string, outcome: 'paid' | 'failed'): Promise<PublicCheckout>
}

export type Decide = Exclude<RequestStatus, 'pending'>

export interface HrPort {
  employees(): Promise<Employee[]>
  createEmployee(input: EmployeeInput): Promise<Employee>
  updateEmployee(id: string, input: EmployeeInput): Promise<Employee>
  shifts(): Promise<Shift[]>
  assignments(): Promise<ShiftAssignment[]>
  /** Sets or clears one employee's shift on one day. */
  assignShift(input: ShiftAssignmentInput): Promise<ShiftAssignment>
  attendance(): Promise<Attendance[]>
  recordAttendance(input: AttendanceInput): Promise<Attendance>
  leaves(): Promise<LeaveRequest[]>
  requestLeave(input: LeaveInput): Promise<LeaveRequest>
  decideLeave(id: string, to: Decide, note: string): Promise<LeaveRequest>
  overtime(): Promise<OvertimeRequest[]>
  requestOvertime(input: OvertimeInput): Promise<OvertimeRequest>
  decideOvertime(id: string, to: Decide, note: string): Promise<OvertimeRequest>
  loans(): Promise<Loan[]>
  requestLoan(input: LoanInput): Promise<Loan>
  decideLoan(id: string, to: Decide, note: string): Promise<Loan>
}

export interface PayrollPort {
  settings(): Promise<PayrollSettings>
  saveSettings(settings: PayrollSettings): Promise<PayrollSettings>
  periods(): Promise<PayrollPeriod[]>
  createPeriod(month: string): Promise<PayrollPeriod>
  /** Recomputes every line from the current HR data; allowed while draft or calculated. */
  calculate(id: string): Promise<PayrollPeriod>
  addAdjustment(id: string, employeeId: string, input: PayrollAdjustmentInput): Promise<PayrollPeriod>
  removeAdjustment(id: string, employeeId: string, adjustmentId: string): Promise<PayrollPeriod>
  /** Approve, close (posts the bank entry and books loan repayments) or reopen with a reason. */
  transition(id: string, to: PayrollStatus, note: string, accountId?: string): Promise<PayrollPeriod>
  publish(id: string): Promise<PayrollPeriod>
}

export interface PeoplePort {
  announcements(): Promise<Announcement[]>
  createAnnouncement(input: AnnouncementInput): Promise<Announcement>
  updateAnnouncement(id: string, input: AnnouncementInput): Promise<Announcement>
  deleteAnnouncement(id: string): Promise<void>
  kpis(): Promise<KpiReview[]>
  saveKpi(id: string | null, input: KpiInput): Promise<KpiReview>
}

export interface AccessPort {
  session(): Promise<User | null>
  login(input: LoginInput): Promise<User>
  logout(): Promise<void>
  changePassword(input: PasswordChange): Promise<void>
  users(): Promise<User[]>
  createUser(input: UserInput): Promise<User>
  updateUser(id: string, input: UserInput): Promise<User>
  setUserActive(id: string, active: boolean): Promise<User>
  permissions(): Promise<Permissions>
  savePermissions(role: Role, perms: Permissions[Role]): Promise<Permissions>
  audit(): Promise<AuditEntry[]>
}

export interface AccountPort {
  profile(): Promise<Profile>
  saveProfile(profile: Profile): Promise<Profile>
}

/** Demo only: whole-state snapshots for the guided simulation. The HTTP adapter refuses them. */
export interface DemoPort {
  available: boolean
  snapshot(): Promise<string>
  restore(id: string): Promise<void>
}

export interface Ports {
  clock: Clock
  property: PropertyPort
  airbnb: AirbnbPort
  booking: BookingPort
  guest: GuestPort
  finance: FinancePort
  service: ServicePort
  maintenance: MaintenancePort
  payment: PaymentPort
  demo: DemoPort
  hr: HrPort
  payroll: PayrollPort
  people: PeoplePort
  access: AccessPort
  account: AccountPort
}
