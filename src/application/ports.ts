import type { Profile } from '@/domain/account'
import type { AuditEntry, LoginInput, PasswordChange, Permissions, Role, User, UserInput } from '@/domain/access'
import type { AirbnbAccount, AirbnbAccountInput, Listing, ListingInput, ListingPriceInput, ListingStatus } from '@/domain/airbnb'
import type { PriceChange } from '@/domain/pricing'
import type { RatePlan, RatePlanInput } from '@/domain/ratePlan'
import type { BulkRestrictionInput, Restriction, RestrictionInput, RestrictionOverrideInput } from '@/domain/restriction'
import type { OverbookPolicy, Walk, WalkInput } from '@/domain/overbooking'
import type { Budget, BudgetInput } from '@/domain/revenue'
import type { ApprovalRule, ApprovalRuleInput } from '@/domain/approval'
import type { Attachment, ProofPolicy, UploadFile } from '@/domain/attachment'
import type { Booking, BookingSource, BookingStatus, CheckInDetails, CheckOutDetails, PaymentInput as BookingPaymentInput, UnitBlock } from '@/domain/booking'
import type { ChargeInput, FolioPosting, RebateInput } from '@/domain/folio'
import type { CashierShift, CloseShiftInput, DropInput, HandOver, OpenShiftInput, ShiftPolicy } from '@/domain/cashier'
import type { BookingGroup, GroupBilling, GroupDiscount, GroupSource, GroupStayInput } from '@/domain/group'
import type { AdjustmentInput, CashAccount, CashAccountInput, CashTransferInput, Category, Reconciliation, ReconciliationInput, Transaction, TransactionInput, TransactionKind, TransactionOrigin, TransactionStatus } from '@/domain/finance'
import type { CompanionInput, ForeignReport, Guest, GuestInput, StayCompanion } from '@/domain/guest'
import type { LostFoundSettings, LostItem, LostItemInput, LostMove } from '@/domain/lostFound'
import type { ChecklistTick, HousekeepingSettings, LaundryBatch, LaundryReturnInput, LaundrySendInput, LinenCount, LinenPar, RoomTask, TaskAction, TaskInput } from '@/domain/housekeeping'
import type { AuditRunInput, NightAudit } from '@/domain/nightAudit'
import type { GlAccount, JournalEntry, ManualJournal, ManualJournalInput, PeriodClose } from '@/domain/journal'
import type { Asset, AssetInput, ExpenseInput, HousekeepingRecord, HousekeepingState, InspectionResult, MaintenanceCategory, PlanInput, PreventivePlan, Vendor, VendorInput, WorkOrder, WorkOrderInput, WorkOrderSource, WorkOrderStatus } from '@/domain/maintenance'
import type { Attendance, AttendanceInput, Employee, EmployeeInput, LeaveInput, LeaveRequest, Loan, LoanInput, OvertimeInput, OvertimeRequest, RequestStatus, Shift, ShiftAssignment, ShiftAssignmentInput } from '@/domain/hr'
import type { PayrollAdjustmentInput, PayrollPeriod, PayrollSettings, PayrollStatus } from '@/domain/payroll'
import type { Payment, PaymentInput, PaymentLink, PaymentMethod, PaymentKind, PaymentPolicy, PublicCheckout, SettleInput } from '@/domain/payment'
import type { Announcement, AnnouncementInput, KpiInput, KpiReview } from '@/domain/people'
import type { ServiceRequest, ServiceRequestInput, ServiceStatus } from '@/domain/roomService'
import type { GuestOrderInput, MenuItem, MenuItemInput, OrderAction, OrderInput, PartnerInput, PublicMenu, ServiceOrder, ServicePartner } from '@/domain/serviceOrder'
import type { AmenityKit, CountInput, MinibarCheckInput, MinibarLink, MoveInput, ReceiptCorrection, ReceiptInput, StockCount, StockItem, StockItemInput, StockLine, StockMovement, StockReceipt } from '@/domain/stock'
import type { GroupInput, Location, LocationInput, PropertyInput, Unit, UnitGroup, UnitInput, Villa, VillaInput } from '@/domain/property'
import type { TransactionCode, TransactionCodeInput } from '@/domain/transactionCode'
import type { ContractInput, ManagementContract, OwnerStatement, OwnerStayInput, OwnerStayRequest, StatementClose, VillaOwner, VillaOwnerInput } from '@/domain/owner'
import type { Message, MessagingSettings, SendMessageInput } from '@/domain/messaging'
import type { PreCheckIn, PreCheckInInput, PublicPreCheckIn } from '@/domain/precheckin'
import type { IsoDate } from '@/lib/dates'
import type { InvoiceView } from './views'

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
  /** The wizard: villa, its room types (see wizardTypes) with their rate plans, and rooms in one transaction. Returns the new villa. */
  createProperty(input: PropertyInput): Promise<Villa>
  updateVilla(id: string, input: VillaInput): Promise<Villa>
  createGroup(input: GroupInput): Promise<UnitGroup>
  updateGroup(id: string, input: GroupInput): Promise<UnitGroup>
  /** A unit that joins a room type without a rate plan starts the plan from its base price; so does updateUnit. */
  createUnit(input: UnitInput): Promise<Unit>
  updateUnit(id: string, input: UnitInput): Promise<Unit>
  /** The fallback price list per room type, for units without a live Airbnb listing. */
  ratePlans(): Promise<RatePlan[]>
  /** Creates or replaces the room type's rate plan. Stays already booked keep their price. */
  saveRatePlan(groupId: string, input: RatePlanInput): Promise<RatePlan>
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
  /** Sells past the stay restrictions the stay breaks; a manager only, with a reason. */
  override?: RestrictionOverrideInput | null
  /** Why a manager books a blacklisted guest anyway; without it the booking is refused. */
  blacklistOverride?: string
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
  /** New nights take the listing price on a direct stay, or `channelRate` on a channel stay. New dates on a direct stay meet the stay restrictions unless overridden. */
  adjustStay(id: string, checkIn: IsoDate, checkOut: IsoDate, channelRate?: number, override?: RestrictionOverrideInput | null): Promise<Booking>
  /** Overrides the rate or discounts a direct stay. */
  setPrice(id: string, price: PriceChange): Promise<Booking>
  /** Picks the room for a stay booked against the room type, or changes it before check-in. */
  assignUnit(id: string, unitId: string): Promise<Booking>
  updateNotes(id: string, notes: string): Promise<Booking>
  setPayment(id: string, payment: BookingPaymentInput): Promise<Booking>
  addBlock(input: Omit<UnitBlock, 'id'>): Promise<UnitBlock>
  removeBlock(id: string): Promise<void>
}

/** Money taken once for the whole group: split over the stays in order, landing as one cash-in. */
export interface GroupPaymentInput {
  kind: 'deposit' | 'balance'
  method: PaymentMethod
  amount: number
  reference: string
  note: string
  attachments?: readonly Attachment[]
}

export interface NewBookingGroup {
  name: string
  /** The lead guest, or null with `newGuest` to add them. Every stay is booked in the lead's name. */
  guestId: string | null
  newGuest: GuestInput | null
  source: GroupSource
  billing: GroupBilling
  stays: readonly GroupStayInput[]
  discount: GroupDiscount | null
  note: string
  confirm: boolean
  deposit: GroupPaymentInput | null
  /** Sells every stay past the stay restrictions it breaks; a manager only, with a reason. */
  override?: RestrictionOverrideInput | null
}

/** Group reservations; each stay is a booking on BookingPort that points at its group. */
export interface GroupPort {
  groups(): Promise<BookingGroup[]>
  /** All or nothing: every unit is checked first and one clash refuses the whole group. A gateway deposit returns its link. */
  create(input: NewBookingGroup): Promise<{ group: BookingGroup; link: PaymentLink | null }>
  addStay(groupId: string, stay: GroupStayInput): Promise<Booking>
  /** Takes the stay out of the group; it carries on as a booking of its own. */
  removeStay(groupId: string, bookingId: string): Promise<Booking>
  /** Cash and transfer are recorded now; QRIS, VA and card return one link for every share. */
  pay(groupId: string, input: GroupPaymentInput): Promise<{ payments: Payment[]; link: PaymentLink | null }>
}

/** Stay restrictions per room type, the overbooking policy, and the guests walked off an overbooked night. */
export interface StayRulesPort {
  restrictions(): Promise<Restriction[]>
  /** Creates with a null id, else replaces. Stays already booked keep their dates. */
  saveRestriction(id: string | null, input: RestrictionInput): Promise<Restriction>
  removeRestriction(id: string): Promise<void>
  /** One restriction per room type picked, all or nothing. */
  bulkRestrictions(input: BulkRestrictionInput): Promise<Restriction[]>
  overbooking(): Promise<OverbookPolicy[]>
  /** Only a room type that sells by type may overbook. */
  setOverbooking(groupId: string, limit: number): Promise<OverbookPolicy>
  walks(): Promise<Walk[]>
  /**
   * Walks a guest arriving today off an overbooked night: moved to a unit of another villa, or cancelled
   * to an outside property. The cost goes for approval as a Guest relocation cash-out.
   */
  walk(bookingId: string, input: WalkInput): Promise<{ booking: Booking; walk: Walk }>
}

/** Manual lines on a stay's folio; everything else on it reads from bookings, payments and orders. */
export interface FolioPort {
  postings(bookingId: string): Promise<FolioPosting[]>
  /** Minibar, damage, late check-out or other; taken with the bill at check-out. */
  postCharge(bookingId: string, input: ChargeInput): Promise<FolioPosting>
  /**
   * Corrects one posted line on its own code, a negative charge that reverses the revenue on the same
   * account; past the discount limit share of the line it needs someone who may approve bookings.
   */
  postRebate(bookingId: string, input: RebateInput): Promise<FolioPosting>
}

export interface GuestPort {
  guests(): Promise<Guest[]>
  create(input: GuestInput): Promise<Guest>
  update(id: string, input: GuestInput): Promise<Guest>
  /** Sets the blacklist with a reason, or clears it with null. Needs approve in the guest module. */
  setBlacklist(id: string, reason: string | null): Promise<Guest>
  /** Moves every stay, group, order and payment of `dropId` onto `keepId` and deletes the dropped profile. */
  merge(keepId: string, dropId: string): Promise<Guest>
  /** Everyone registered on a stay besides the lead guest. */
  companions(): Promise<StayCompanion[]>
  addCompanion(bookingId: string, input: CompanionInput): Promise<StayCompanion>
  updateCompanion(id: string, input: CompanionInput): Promise<StayCompanion>
  removeCompanion(id: string): Promise<void>
  /** Foreign guests sent to Immigration (APOA), one line per person and stay. */
  foreignReports(): Promise<ForeignReport[]>
  markReported(bookingId: string, personIds: readonly string[], reference: string): Promise<ForeignReport[]>
}

/** Items found in the villas, from the find to the owner or the end of the holding period. */
export interface LostFoundPort {
  items(): Promise<LostItem[]>
  create(input: LostItemInput): Promise<LostItem>
  update(id: string, input: LostItemInput): Promise<LostItem>
  move(id: string, move: LostMove): Promise<LostItem>
  settings(): Promise<LostFoundSettings>
  saveSettings(settings: LostFoundSettings): Promise<LostFoundSettings>
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
  /** Refuses a guest revenue category with CATEGORY_FOLLOWS_CODE: its account comes from its transaction code. */
  mapCategory(categoryId: string, accountId: string): Promise<Record<string, string>>
  /** Folio transaction codes; a charge code names the revenue account its lines book to. */
  transactionCodes(): Promise<TransactionCode[]>
  createTransactionCode(input: TransactionCodeInput): Promise<TransactionCode>
  /** A new account applies to postings from then on; posted journals stay as they are. */
  updateTransactionCode(id: string, input: TransactionCodeInput): Promise<TransactionCode>
  /** A code taken out of use stays on the lines it already posted. */
  setTransactionCodeActive(id: string, active: boolean): Promise<TransactionCode>
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
  /** Delivering books each partner's cost as a submitted cash-out. Voiding a delivery on its business day reverses its revenue, partner bills and stock sale. */
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

/** Minibar goods, guest amenities and linen per villa store; on hand comes from the movements. */
export interface StockPort {
  items(): Promise<StockItem[]>
  createItem(input: StockItemInput): Promise<StockItem>
  updateItem(id: string, input: StockItemInput): Promise<StockItem>
  movements(): Promise<StockMovement[]>
  receipts(): Promise<StockReceipt[]>
  /** Books the goods in, moves the average cost, and submits the purchase as a cash-out for approval. */
  receive(input: ReceiptInput): Promise<StockReceipt>
  /**
   * Fixes a receipt whose cash-out was rejected and resubmits the same cash-out: the old receipt comes out of the
   * movements and the average cost, the corrected one goes in. Only the author or someone who approves maintenance.
   */
  correctReceipt(id: string, input: ReceiptCorrection): Promise<StockReceipt>
  /** Gives up a rejected purchase: its stock leaves the store again (STOCK_SHORT when already used) and the cash-out stays rejected. */
  cancelReceipt(id: string, reason: string): Promise<StockReceipt>
  /** Issue to a unit, transfer to another villa store, or write off; never more than the store holds. */
  move(input: MoveInput): Promise<StockMovement[]>
  counts(): Promise<StockCount[]>
  /** Posts each difference against the expected quantity as a count adjustment in the counter's name. */
  count(input: CountInput): Promise<StockCount>
  kits(): Promise<AmenityKit[]>
  /** The kit that marking a unit of that room type ready issues; an empty list removes it. */
  saveKit(groupId: string, lines: readonly StockLine[]): Promise<AmenityKit>
  minibarLinks(): Promise<MinibarLink[]>
  /** Links a minibar menu item to the stock it sells, or unlinks it with null. */
  linkMinibar(menuItemId: string, stockItemId: string | null): Promise<MinibarLink[]>
  /** What the guest took from the in-room minibar: a delivered minibar order on the stay, plus the restock when asked. */
  minibarCheck(input: MinibarCheckInput): Promise<ServiceOrder>
}

/** A fault the attendant found in the room; it opens a work order through the maintenance path. */
export interface TaskIssueInput {
  category: MaintenanceCategory
  title: string
  description: string
  urgent: boolean
}

/** Room attendant tasks, linen per villa and laundry batches. Discards and laundry losses post as stock write-offs. */
export interface HousekeepingPort {
  settings(): Promise<HousekeepingSettings>
  saveSettings(settings: HousekeepingSettings): Promise<HousekeepingSettings>
  tasks(): Promise<RoomTask[]>
  /** Adds the day's missing departure, stayover and turndown tasks from the stays and the board; returns the new ones. */
  planDay(date: string): Promise<RoomTask[]>
  addTask(input: TaskInput): Promise<RoomTask>
  /** Gives tasks to an attendant on shift that day, or back to unassigned with null. */
  assign(taskIds: readonly string[], attendantId: string | null): Promise<RoomTask[]>
  /** Spreads the day's unassigned tasks over the attendants on shift by villa, up to the daily quota. */
  autoAssign(date: string): Promise<RoomTask[]>
  /** Start, pause, resume, done (with the ticked checklist), do not disturb, service refused or cancel. Only the attendant or a supervisor. */
  workTask(id: string, action: TaskAction, input: { checklist?: readonly ChecklistTick[]; note?: string }): Promise<RoomTask>
  reportIssue(id: string, input: TaskIssueInput): Promise<{ task: RoomTask; workOrderId: string }>
  noteLostFound(id: string, note: string, ref: string | null): Promise<RoomTask>
  linenPars(): Promise<LinenPar[]>
  saveLinenPar(groupId: string, input: Pick<LinenPar, 'sets' | 'lines'>): Promise<LinenPar>
  linenSoiled(): Promise<LinenCount[]>
  /** Takes pieces out of soiled or clean and writes them off the villa store. */
  discardLinen(input: { villaId: string; from: 'soiled' | 'clean'; lines: readonly StockLine[]; reason: string }): Promise<StockMovement[]>
  laundryBatches(): Promise<LaundryBatch[]>
  /** Soiled to at laundry; refused when the villa holds fewer soiled pieces. */
  sendLaundry(input: LaundrySendInput): Promise<LaundryBatch>
  /** Back to clean; missing and damaged pieces are written off and the vendor's bill goes for approval as a cash-out. */
  returnLaundry(id: string, input: LaundryReturnInput): Promise<LaundryBatch>
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

/**
 * Front desk cashier shifts on a cashbox. While a shift is open, cash entries on its cashbox and the
 * desk's guest payments and refunds at that location carry its id.
 */
export interface CashierPort {
  /** Oldest first. */
  shifts(): Promise<CashierShift[]>
  handOvers(): Promise<HandOver[]>
  policy(): Promise<ShiftPolicy>
  savePolicy(policy: ShiftPolicy): Promise<ShiftPolicy>
  /** One open shift per cashbox (SHIFT_ALREADY_OPEN); the cashier is on the roster or a manager (SHIFT_NOT_ROSTERED). */
  open(input: OpenShiftInput): Promise<CashierShift>
  /**
   * Counts the drawer against the float plus cash in less cash out. Within the tolerance the shift
   * closes and a difference posts through the cash count reconciliation; past it the shift waits for
   * a sign-off.
   */
  close(id: string, input: CloseShiftInput): Promise<CashierShift>
  /** A manager or finance approver signs the difference and the reconciliation posts it. */
  signOff(id: string, note: string): Promise<CashierShift>
  /** Takes counted cash to the safe or the bank as a cash transfer. */
  drop(id: string, input: DropInput): Promise<CashierShift>
}

/** The business date, apart from the calendar date, and the night audit that closes it. */
export interface AuditPort {
  businessDate(): Promise<IsoDate>
  /** Oldest first. */
  audits(): Promise<NightAudit[]>
  /**
   * Closes the business date: posts the night's room on every stay in house (catching up nights a
   * late check-in missed), records the audit with the checks and no-shows it was given, and rolls
   * the business date a day forward. A rerun of a closed date is refused with AUDIT_ALREADY_RUN.
   */
  run(input: AuditRunInput): Promise<NightAudit>
}

/** Revenue budgets per villa and year; the actuals they meet come from stays and posted entries. */
export interface BudgetPort {
  budgets(): Promise<Budget[]>
  /** Creates or replaces the villa's budget for the year. */
  save(input: BudgetInput): Promise<Budget>
}

/**
 * Guest messages. `send` hands the message to the provider: the mock queues it and marks it sent, then
 * delivered; a WhatsApp gateway (Fonnte, Qontak or WhatsApp Cloud API) or an email service plugs in here.
 * Triggers (confirmation, payment link, receipt, pre-arrival, welcome, reminder, thank you) send on their own.
 */
export interface MessagingPort {
  /** Every outbound message; reading it also sends the time triggers that fell due. */
  messages(): Promise<Message[]>
  settings(): Promise<MessagingSettings>
  saveSettings(settings: MessagingSettings): Promise<MessagingSettings>
  send(input: SendMessageInput): Promise<Message>
  /** Queues a failed message again, to the guest's current contact. */
  resend(id: string): Promise<Message>
  /** Public, no session: the stay invoice behind an e-invoice link. */
  invoice(token: string): Promise<InvoiceView>
}

/** Online check-in: the guest fills it in before arrival, the front desk verifies it against the ID. */
export interface PreCheckInPort {
  /** Pre-check-ins the guests have sent; a stay without one has not started. */
  preCheckIns(): Promise<PreCheckIn[]>
  /** Copies the data onto the guest profile and the stay and records who verified it. */
  verify(bookingId: string): Promise<PreCheckIn>
  /** Public, no session: the stay and the form behind the link. */
  guestView(token: string): Promise<PublicPreCheckIn>
  /** Public, no session: the guest sends or updates the form. */
  submit(token: string, input: PreCheckInInput): Promise<PublicPreCheckIn>
  /** Public, no session: a QRIS, VA or card link for the room balance. */
  payBalance(token: string, method: PaymentMethod): Promise<PaymentLink>
}

export interface AccountPort {
  profile(): Promise<Profile>
  saveProfile(profile: Profile): Promise<Profile>
}

/**
 * Villa owners, their management contracts, the monthly owner statements and owner stays. A villa
 * owner signed in sees only their own records here.
 */
export interface OwnerPort {
  owners(): Promise<VillaOwner[]>
  createOwner(input: VillaOwnerInput): Promise<VillaOwner>
  updateOwner(id: string, input: VillaOwnerInput): Promise<VillaOwner>
  contracts(): Promise<ManagementContract[]>
  createContract(input: ContractInput): Promise<ManagementContract>
  updateContract(id: string, input: ContractInput): Promise<ManagementContract>
  statements(): Promise<OwnerStatement[]>
  /** Applies the contract to the month's books, keeps the figures and the lines behind them, and writes the close journal. */
  closeStatement(input: StatementClose): Promise<OwnerStatement>
  /** The operator's owner signs it; the closer cannot. The villa owner sees it from then on. */
  approveStatement(id: string, note: string): Promise<OwnerStatement>
  /** Submits the payout as a cash-out from `accountId` through the approval chain; posting it pays the owner. */
  payStatement(id: string, accountId: string): Promise<OwnerStatement>
  stayRequests(): Promise<OwnerStayRequest[]>
  requestStay(input: OwnerStayInput): Promise<OwnerStayRequest>
  /** Approving blocks `unitId` for the stay as an owner stay; declining needs a note. */
  decideStay(id: string, decision: { approve: true; unitId: string; note: string } | { approve: false; note: string }): Promise<OwnerStayRequest>
}

export interface Ports {
  clock: Clock
  property: PropertyPort
  airbnb: AirbnbPort
  booking: BookingPort
  groups: GroupPort
  stayRules: StayRulesPort
  folio: FolioPort
  guest: GuestPort
  lostFound: LostFoundPort
  finance: FinancePort
  ledger: LedgerPort
  service: ServicePort
  orders: OrderPort
  maintenance: MaintenancePort
  stock: StockPort
  housekeeping: HousekeepingPort
  payment: PaymentPort
  files: FilePort
  hr: HrPort
  payroll: PayrollPort
  people: PeoplePort
  access: AccessPort
  account: AccountPort
  audit: AuditPort
  cashier: CashierPort
  budget: BudgetPort
  messaging: MessagingPort
  precheckin: PreCheckInPort
  owners: OwnerPort
}
