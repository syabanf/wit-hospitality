import type { Profile } from '@/domain/account'
import type { AuditEntry, LoginInput, PasswordChange, Permissions, Role, User, UserInput } from '@/domain/access'
import type { AirbnbAccount, AirbnbAccountInput, Listing, ListingInput, ListingPriceInput, ListingStatus } from '@/domain/airbnb'
import type { PriceChange } from '@/domain/pricing'
import type { ApprovalRule, ApprovalRuleInput } from '@/domain/approval'
import type { Attachment, ProofPolicy, UploadFile } from '@/domain/attachment'
import type { Booking, BookingSource, BookingStatus, CheckInDetails, CheckOutDetails, PaymentInput as BookingPaymentInput, UnitBlock } from '@/domain/booking'
import type { AdjustmentInput, CashAccount, CashAccountInput, CashTransferInput, Category, Reconciliation, ReconciliationInput, Transaction, TransactionInput, TransactionKind, TransactionOrigin, TransactionStatus } from '@/domain/finance'
import type { Guest, GuestInput } from '@/domain/guest'
import type { GlAccount, JournalEntry, ManualJournal, ManualJournalInput, PeriodClose } from '@/domain/journal'
import type { Asset, AssetInput, ExpenseInput, HousekeepingRecord, HousekeepingState, InspectionResult, PlanInput, PreventivePlan, Vendor, VendorInput, WorkOrder, WorkOrderInput, WorkOrderSource, WorkOrderStatus } from '@/domain/maintenance'
import type { Attendance, AttendanceInput, Employee, EmployeeInput, LeaveInput, LeaveRequest, Loan, LoanInput, OvertimeInput, OvertimeRequest, RequestStatus, Shift, ShiftAssignment, ShiftAssignmentInput } from '@/domain/hr'
import type { PayrollAdjustmentInput, PayrollPeriod, PayrollSettings, PayrollStatus } from '@/domain/payroll'
import type { Payment, PaymentInput, PaymentLink, PaymentMethod, PaymentKind, PaymentPolicy, PublicCheckout, SettleInput } from '@/domain/payment'
import type { Announcement, AnnouncementInput, KpiInput, KpiReview } from '@/domain/people'
import type { ServiceRequest, ServiceRequestInput, ServiceStatus } from '@/domain/roomService'
import type { GuestOrderInput, MenuItem, MenuItemInput, OrderAction, OrderInput, PartnerInput, PublicMenu, ServiceOrder, ServicePartner } from '@/domain/serviceOrder'
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
  /** Sets the base rate (the unit's rate) and per-night prices; both the listing and the unit read them. */
  setListingPrices(id: string, input: ListingPriceInput): Promise<Listing>
}

export interface NewBooking {
  guestId: string | null
  /** A guest created with the booking when `guestId` is null. */
  newGuest: GuestInput | null
  /** The room, or null when the guest books the room type of a villa where the operator assigns rooms. */
  unitId: string | null
  /** The room type, for a booking without a room yet. */
  groupId: string | null
  source: BookingSource
  airbnbAccountId: string | null
  airbnbCode: string | null
  checkIn: IsoDate
  checkOut: IsoDate
  /** What the channel sold a night for; Airbnb bookings only. Direct stays take the listing price. */
  channelRate: number | null
  /** A staff override or discount on a direct stay. */
  price: PriceChange | null
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
  /**
   * Takes the room balance, unpaid room service and departure charges in one go, then checks the guest out, all or nothing.
   * Cash and transfer close the stay at once; QRIS, VA and card return one link and the stay closes when the guest pays it.
   */
  settleAndCheckOut(id: string, input: SettleInput): Promise<{ booking: Booking; link: PaymentLink | null }>
  /** Moves the stay. A direct stay reprices from the new unit's listing, with an optional staff price; a channel stay keeps its price. */
  moveUnit(id: string, unitId: string, reason: string, price?: PriceChange): Promise<Booking>
  /** New nights take the listing price on a direct stay, or `channelRate` on a channel stay. */
  adjustStay(id: string, checkIn: IsoDate, checkOut: IsoDate, channelRate?: number): Promise<Booking>
  /** Overrides the rate or discounts a direct stay. */
  setPrice(id: string, price: PriceChange): Promise<Booking>
  /** Picks the room for a stay booked against the room type, or changes it before check-in. */
  assignUnit(id: string, unitId: string): Promise<Booking>
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
  /** Adds receipts to an entry that is not posted yet. */
  attach(id: string, files: readonly Attachment[]): Promise<Transaction>
  /** Removes one receipt from an entry that is not posted yet. */
  detach(id: string, attachmentId: string): Promise<Transaction>
  proofPolicy(): Promise<ProofPolicy>
  saveProofPolicy(policy: ProofPolicy): Promise<ProofPolicy>
}

/** The double-entry books: journals the cash ledger writes on posting, manual adjustments and month closing. */
export interface LedgerPort {
  /** The base chart plus one GL account per cash account. */
  chart(): Promise<GlAccount[]>
  /** Category id to GL account id. */
  categoryAccounts(): Promise<Record<string, string>>
  mapCategory(categoryId: string, accountId: string): Promise<Record<string, string>>
  journals(): Promise<JournalEntry[]>
  manualJournals(): Promise<ManualJournal[]>
  createManualJournal(input: ManualJournalInput, submit: boolean): Promise<ManualJournal>
  /** Same chain as a cash entry: submit, sign each level, post. Posting writes the journal entry. */
  transitionManualJournal(id: string, to: TransactionAction, note?: string): Promise<ManualJournal>
  periodCloses(): Promise<PeriodClose[]>
  closePeriod(month: string, note: string): Promise<PeriodClose>
  reopenPeriod(month: string, reason: string): Promise<void>
}

/** Stores a picked file and returns where it opens. Works without a session for the guest checkout. */
export interface FilePort {
  upload(file: UploadFile): Promise<Attachment>
}

export interface ServicePort {
  requests(): Promise<ServiceRequest[]>
  create(input: ServiceRequestInput): Promise<ServiceRequest>
  update(id: string, input: ServiceRequestInput): Promise<ServiceRequest>
  transition(id: string, to: Exclude<ServiceStatus, 'open'>): Promise<ServiceRequest>
  assign(id: string, assignee: string): Promise<ServiceRequest>
  linkTransaction(id: string, transactionId: string): Promise<ServiceRequest>
}

/** The room service menu and the orders placed from it, by staff or by the guest from the room's QR code. */
export interface OrderPort {
  menu(): Promise<MenuItem[]>
  createItem(input: MenuItemInput): Promise<MenuItem>
  updateItem(id: string, input: MenuItemInput): Promise<MenuItem>
  partners(): Promise<ServicePartner[]>
  createPartner(input: PartnerInput): Promise<ServicePartner>
  updatePartner(id: string, input: PartnerInput): Promise<ServicePartner>
  orders(): Promise<ServiceOrder[]>
  place(input: OrderInput): Promise<ServiceOrder>
  /** Delivering books each partner's cost as a submitted cash-out. */
  transition(id: string, to: OrderAction, note: string): Promise<ServiceOrder>
  assign(id: string, assignee: string): Promise<ServiceOrder>
  /** Public, no session: the room's menu and the current stay's orders. */
  guestMenu(token: string): Promise<PublicMenu>
  /** Public, no session: the guest orders for the stay in that room. */
  guestPlace(token: string, input: GuestOrderInput): Promise<PublicMenu>
  /** Public, no session: a QRIS link for everything delivered and still unpaid. */
  guestPay(token: string): Promise<PaymentLink>
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
  /** Room service orders the link settles, in full. */
  orderIds?: readonly string[]
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
  refund(paymentId: string, amount: number, reason: string, attachments: readonly Attachment[]): Promise<Payment>
  /** Public, no session: the guest-facing view of a link. */
  checkout(token: string): Promise<PublicCheckout>
  /** Public, no session: the gateway reports the outcome; demo only. */
  settle(token: string, outcome: 'paid' | 'failed'): Promise<PublicCheckout>
  /** Public, no session: the guest adds a transfer receipt to a pending link. */
  submitProof(token: string, file: Attachment): Promise<PublicCheckout>
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

export interface Ports {
  clock: Clock
  property: PropertyPort
  airbnb: AirbnbPort
  booking: BookingPort
  guest: GuestPort
  finance: FinancePort
  ledger: LedgerPort
  service: ServicePort
  orders: OrderPort
  maintenance: MaintenancePort
  payment: PaymentPort
  files: FilePort
  hr: HrPort
  payroll: PayrollPort
  people: PeoplePort
  access: AccessPort
  account: AccountPort
}
