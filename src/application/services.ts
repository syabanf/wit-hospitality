import { validateProfile, type Profile } from '@/domain/account'
import { allowedVilla, can, filterAudit, MODULE_LABEL, ROLE_LABEL, validatePasswordChange, validateUser, type Action, type LoginInput, type Module, type PasswordChange, type Permissions, type Role, type User, type UserInput } from '@/domain/access'
import { DIRECT_SOURCE, sourceOptions, validateAirbnbAccount, validateListing, validateListingPrice, type AirbnbAccountInput, type ListingInput, type ListingPriceInput, type ListingStatus } from '@/domain/airbnb'
import { approvalProgress, canSignLevel, matchRule, requiredLevels, validateApprovalRule, type ApprovalRuleInput } from '@/domain/approval'
import { needsProof, validateProofPolicy, type Attachment, type ProofPolicy, type UploadFile } from '@/domain/attachment'
import {
  arrivalsOn,
  averageRate,
  bookingPayout,
  bookingTotal,
  isChannel,
  sellsRoomType,
  typeAvailability,
  unassigned,
  departuresOn,
  findConflicts,
  inHouse,
  interchangeableFree,
  lifecycleSteps,
  nightState,
  nights,
  nightsBetween,
  occupancy,
  occupies,
  revenueBetween,
  sortBookings,
  SOURCE_LABEL,
  stripDays,
  swapTargets,
  validateCheckIn,
  validateCheckOut,
  validatePayment,
  validateStay,
  type Booking,
  type CheckInDetails,
  type CheckOutDetails,
  type BookingStatus,
  type PaymentInput,
  type UnitBlock,
} from '@/domain/booking'
import { buckets, change, periodRange, type DateRange } from '@/domain/dashboard'
import { beyondDiscountLimit, stayPrice, validatePriceChange, type NightPrice, type PriceChange } from '@/domain/pricing'
import { defaultRatePlan, listNights, noPriceMessage, planNight, priceListFor, soldNights, validateRatePlan, type RatePlanInput } from '@/domain/ratePlan'
import { findById, NotFoundError, RuleError } from '@/domain/errors'
import { folioOwed, guestFolio, rebateTargets, refundable, validateCharge, validateRebate, type ChargeInput, type RebateInput } from '@/domain/folio'
import {
  awaitsApproval,
  balance,
  byCategory,
  cashSummary,
  counts,
  pettyLow,
  pettyTopUp,
  signed,
  transactionSteps,
  validateAccount,
  validateAdjustment,
  validateReconciliation,
  validateTransaction,
  validateTransfer,
  type AdjustmentInput,
  type CashAccountInput,
  type CashTransferInput,
  type ReconciliationInput,
  type Transaction,
  type TransactionInput,
  type TransactionStatus,
} from '@/domain/finance'
import { validateGuest, type GuestInput } from '@/domain/guest'
import { filterByEmployee, leaveBalance, loanOutstanding, validateAttendance, validateEmployee, validateLeave, validateLoan, validateOvertime, villaIdsOf, type AttendanceInput, type Employee, type EmployeeInput, type LeaveInput, type LoanInput, type OvertimeInput, type ShiftAssignmentInput } from '@/domain/hr'
import { costByVilla, periodLabel, periodTotals, tenureMonths, validateAdjustment as validatePayrollAdjustment, validatePayrollSettings, type PayrollAdjustmentInput, type PayrollSettings, type PayrollStatus } from '@/domain/payroll'
import { ASSET_STATUS_LABEL, canAddExpense, validateExpense, type ExpenseInput, type ExpenseKind, effectiveHousekeeping, filterWorkOrders, intervalLabel, MAINTENANCE_CATEGORY_LABEL, PLAN_STATE_LABEL, PRIORITY_LABEL, isClosedWorkOrder, isOpenWorkOrder, partsCost, planState, resolutionDays, sortWorkOrders, underWarranty, validateAsset, validatePlan, validateVendor, validateWorkOrder, workOrderCost, workOrderSteps, INSPECTION_ITEMS, type AssetInput, type HousekeepingState, type InspectionResult, type PlanInput, type VendorInput, type WorkOrder, type WorkOrderInput, type WorkOrderStatus } from '@/domain/maintenance'
import { AGING_BUCKETS, AGING_LABEL, agingBucket, balanceDueOn, cancellationTerms, filterPayments, isGateway, netPaid, PAYMENT_METHOD_LABEL, PAYMENT_METHODS, settlementLines, validatePayment as validatePaymentInput, validatePolicy, validateSettle, type Payment, type PaymentInput as GuestPaymentInput, type PaymentMethod, type PaymentPolicy, type SettleInput } from '@/domain/payment'
import { kpiScore, quarterOf, validateAnnouncement, validateKpi, type AnnouncementInput, type KpiInput } from '@/domain/people'
import { filterRequests, sortRequests, validateServiceRequest, type ServiceRequestInput, type ServiceStatus } from '@/domain/roomService'
import { deliveryDelay, filterOrders, folio, isOpenOrder, lineAmount, lineCost, MENU_CATEGORIES, MENU_CATEGORY_LABEL, ORDER_SLA_MINUTES, orderableStay, PARTNER_KIND_LABEL, partnerCosts, type MenuCategory, orderLate, orderTokenFor, orderTotals, payState, sortOrders, validateMenuItem, validateOrder, validatePartner, type GuestOrderInput, type MenuItem, type MenuItemInput, type OrderAction, type OrderInput, type PartnerInput, type ServiceOrder } from '@/domain/serviceOrder'
import { orderFlow } from '@/domain/flow'
import { chargeCodes } from '@/domain/transactionCode'
import { GL, partyBalances, statutoryRemittances } from '@/domain/journal'
import {
  buildCatalog,
  unitsIn,
  validateGroup,
  validateLocation,
  validateProperty,
  validateUnit,
  validateVilla,
  type Catalog,
  type GroupInput,
  type LocationInput,
  type PropertyInput,
  type Scope,
  type Unit,
  type UnitInput,
  type VillaInput,
} from '@/domain/property'
import { addDays, addMonths, daysBetween, eachDay, shortDay, startOfMonth, startOfWeek, type IsoDate } from '@/lib/dates'
import { createAccounting } from './accounting'
import type { BookingAction, CategoryInput, Decide, NewBooking, NewPaymentLink, NewWorkOrder, Ports, TransactionAction } from './ports'
import { createGroupServices } from './groups'
import { createNightAudit } from './nightAudit'
import { REPORTS, type ReportFilter } from './reports'
import { createStockServices } from './stock'
import type { AssetView, HousekeepingRow, InvoiceLine, InvoiceView, MenuItemView, PaymentView, PettyRow, PlanView, ReceivableRow, ServiceOrderView, VendorView, WorkOrderView } from './views'
import type { AttendanceView, BlockView, BookingView, CalendarRow, CalendarSpan, DashboardFilter, EmployeeView, GuestRow, KpiView, LeaveView, LoanView, Metric, OvertimeView, ReportResult, ReportRow, ServiceRequestView, TransactionView, UnitRow } from './views'

/** A thrown validation result: the form shows `errors` beside the fields. */
export class ValidationError extends Error {
  readonly errors: Record<string, string>
  constructor(errors: Record<string, string>) {
    super(Object.values(errors)[0] ?? 'Check the form.')
    this.name = 'ValidationError'
    this.errors = errors
  }
}

const TARGET_OCCUPANCY = 0.7
/** Throws the field map when a validator found something. */
function check(errors: Record<string, string | undefined>) {
  const found = Object.fromEntries(Object.entries(errors).filter((e): e is [string, string] => Boolean(e[1])))
  if (Object.keys(found).length) throw new ValidationError(found)
}
const metric = (value: number, previous: number): Metric => ({ value, previous, change: change(value, previous) })
const sum = (list: readonly number[]) => list.reduce((s, v) => s + v, 0)
const cap = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

export function createServices(ports: Ports) {
  const today = () => ports.clock.today()

  /** The signed-in user; pages redirect to sign-in on UNAUTHENTICATED. */
  async function me(): Promise<User> {
    const u = await ports.access.session()
    if (!u) throw new RuleError('UNAUTHENTICATED', 'Sign in to continue.')
    return u
  }

  /** The user, the matrix and the villa scope together, loaded once per page. */
  async function access() {
    const [user, permissions] = await Promise.all([me(), ports.access.permissions()])
    return { user, permissions, can: (module: Module, action: Action) => can(permissions, user.role, module, action) }
  }

  async function allow(module: Module, action: Action) {
    const a = await access()
    if (!a.can(module, action)) throw new RuleError('FORBIDDEN', `${ROLE_LABEL[a.user.role]} cannot ${action} in ${MODULE_LABEL[module]}.`)
    return a.user
  }

  /** The catalog narrowed to the villas the signed-in user may see. */
  async function catalog(): Promise<Catalog> {
    const [user, locations, villas, units, groups] = await Promise.all([me(), ports.property.locations(), ports.property.villas(), ports.property.units(), ports.property.groups()])
    const mine = villas.filter((v) => allowedVilla(user, v))
    const villaIds = new Set(mine.map((v) => v.id))
    const locationIds = new Set(mine.map((v) => v.locationId))
    const restricted = user.locationIds.length > 0 || user.villaIds.length > 0
    return buildCatalog(
      restricted ? locations.filter((l) => locationIds.has(l.id)) : locations,
      mine,
      units.filter((u) => villaIds.has(u.villaId)),
      groups.filter((g) => villaIds.has(g.villaId)),
    )
  }

  const stock = createStockServices({ ports, today, catalog, allow, access, check })

  /** Everything a booking row needs, loaded once per page. */
  async function bookingWorld() {
    const [cat, allBookings, allBlocks, guests, accounts, listings, groups] = await Promise.all([
      catalog(),
      ports.booking.bookings(),
      ports.booking.blocks(),
      ports.guest.guests(),
      ports.airbnb.accounts(),
      ports.airbnb.listings(),
      ports.groups.groups(),
    ])
    const unitIds = new Set(cat.units.map((u) => u.id))
    const bookings = allBookings.filter((b) => unitIds.has(b.unitId))
    const blocks = allBlocks.filter((k) => unitIds.has(k.unitId))
    const describe = (b: Booking): BookingView => {
      const guest = findById(guests, b.guestId, 'guest')
      const place = cat.place(b.unitId)
      const account = b.airbnbAccountId ? findById(accounts, b.airbnbAccountId, 'Airbnb account') : null
      const group = b.bookingGroupId ? groups.find((g) => g.id === b.bookingGroupId) : undefined
      return {
        ...b,
        guest,
        guestName: guest.name,
        place,
        unitCode: b.unitAssigned ? place.unit.code : 'Unassigned',
        roomType: b.unitAssigned ? null : (place.group?.name ?? null),
        account,
        sourceLabel: account ? account.name : SOURCE_LABEL[b.source],
        nights: nights(b),
        total: bookingTotal(b),
        price: stayPrice(b),
        rate: averageRate(b),
        payout: bookingPayout(b),
        group: group ? { id: group.id, code: group.code, name: group.name, billing: group.billing } : null,
      }
    }
    return { cat, bookings, blocks, guests, accounts, listings: listings.filter((l) => unitIds.has(l.unitId)), views: bookings.map(describe), describe }
  }

  async function serviceWorld() {
    const [w, requests] = await Promise.all([bookingWorld(), ports.service.requests()])
    const unitIds = new Set(w.cat.units.map((u) => u.id))
    const mine = requests.filter((r) => unitIds.has(r.unitId))
    const describe = (r: (typeof requests)[number]): ServiceRequestView => {
      const booking = r.bookingId ? w.describe(findById(w.bookings, r.bookingId, 'booking')) : null
      const place = w.cat.place(r.unitId)
      return { ...r, place, unitCode: place.unit.code, booking, guestName: booking?.guestName ?? null }
    }
    return { ...w, requests: mine, views: mine.map(describe), describeRequest: describe }
  }

  async function financeWorld() {
    const [cat, allAccounts, categories, allTransactions, rules] = await Promise.all([catalog(), ports.finance.accounts(), ports.finance.categories(), ports.finance.transactions(), ports.finance.approvalRules()])
    const locationIds = new Set(cat.locations.map((l) => l.id))
    const villaIds = new Set(cat.villas.map((v) => v.id))
    // Petty cash follows its villa: a manager of one villa sees that box only.
    const accounts = allAccounts.filter((a) => (a.villaId ? villaIds.has(a.villaId) : a.locationId === null || locationIds.has(a.locationId)))
    const visible = new Set(accounts.map((a) => a.id))
    const transactions = allTransactions.filter((t) => locationIds.has(t.locationId) && visible.has(t.accountId))
    const describe = (t: Transaction): TransactionView => {
      const levels = requiredLevels(rules, t)
      return {
        ...t,
        category: findById(categories, t.categoryId, 'category'),
        categoryName: findById(categories, t.categoryId, 'category').name,
        account: findById(allAccounts, t.accountId, 'account'),
        accountName: findById(allAccounts, t.accountId, 'account').name,
        location: cat.location(t.locationId),
        villa: t.villaId ? cat.villa(t.villaId) : null,
        unit: t.unitId ? cat.unit(t.unitId) : null,
        levels,
        nextApprover: t.status === 'submitted' ? approvalProgress(levels, t.approvals).next : null,
      }
    }
    return { cat, accounts, allAccounts, categories, transactions, rules, views: transactions.map(describe), describe }
  }

  async function hrWorld() {
    const [cat, employees, shifts, assignments, attendance, leaves, overtime, loans] = await Promise.all([catalog(), ports.hr.employees(), ports.hr.shifts(), ports.hr.assignments(), ports.hr.attendance(), ports.hr.leaves(), ports.hr.overtime(), ports.hr.loans()])
    const villaIds = new Set(cat.villas.map((v) => v.id))
    const staff = employees.filter((e) => villaIdsOf(e).some((id) => villaIds.has(id)))
    const ids = new Set(staff.map((e) => e.id))
    const year = today().slice(0, 4)
    const name = (id: string) => staff.find((e) => e.id === id)?.name ?? 'Former employee'
    const describe = (e: Employee): EmployeeView => ({
      ...e,
      villas: e.allocations.map((a) => cat.villas.find((v) => v.id === a.villaId)).filter((v): v is NonNullable<typeof v> => Boolean(v)),
      villaNames: e.allocations.map((a) => cat.villas.find((v) => v.id === a.villaId)?.name ?? a.villaId).join(', '),
      leaveLeft: leaveBalance(e, leaves, year),
      tenureMonths: tenureMonths(e.joinedOn, today().slice(0, 7)),
      openLoan: loans.find((l) => l.employeeId === e.id && (l.status === 'active' || l.status === 'pending')) ?? null,
    })
    const shiftOf = (employeeId: string, date: IsoDate) => {
      const a = assignments.find((x) => x.employeeId === employeeId && x.date === date)
      return a?.shiftId ? (shifts.find((x) => x.id === a.shiftId) ?? null) : null
    }
    return {
      cat,
      employees: staff,
      shifts,
      assignments: assignments.filter((a) => ids.has(a.employeeId)),
      attendance: attendance.filter((a) => ids.has(a.employeeId)).map((a): AttendanceView => ({ ...a, employeeName: name(a.employeeId), shift: shiftOf(a.employeeId, a.date) })),
      leaves: leaves.filter((l) => ids.has(l.employeeId)).map((l): LeaveView => ({ ...l, employeeName: name(l.employeeId) })),
      overtime: overtime.filter((o) => ids.has(o.employeeId)).map((o): OvertimeView => ({ ...o, employeeName: name(o.employeeId), villaName: cat.villas.find((v) => v.id === o.villaId)?.name ?? o.villaId })),
      loans: loans.filter((l) => ids.has(l.employeeId)).map((l): LoanView => ({ ...l, employeeName: name(l.employeeId), outstanding: loanOutstanding(l) })),
      views: staff.map(describe),
      describe,
      name,
    }
  }

  /** Work orders, assets, vendors, plans and the housekeeping board, narrowed to the villas the user may see. */
  /** Payments with their booking and ledger entry, narrowed to the bookings the user may see. */
  async function paymentWorld() {
    const [w, fin, payments, links, policy] = await Promise.all([bookingWorld(), financeWorld(), ports.payment.payments(), ports.payment.links(), ports.payment.policy()])
    const ids = new Set(w.bookings.map((b) => b.id))
    const views: PaymentView[] = payments
      .filter((p) => ids.has(p.bookingId))
      .map((p) => {
        const b = w.describe(findById(w.bookings, p.bookingId, 'booking'))
        const t = p.transactionId ? fin.transactions.find((x) => x.id === p.transactionId) : undefined
        return { ...p, bookingCode: b.code, guestName: b.guestName, unitCode: b.unitCode, villaId: b.place.villa.id, villaName: b.place.villa.name, locationId: b.place.location.id, link: links.find((l) => l.paymentId === p.id) ?? null, transactionStatus: t?.status ?? null, transactionNumber: t?.number ?? null, proofs: t?.attachments ?? [] }
      })
    const mineLinks = links.filter((l) => ids.has(l.bookingId))
    const expected = (b: BookingView) => (b.source === 'airbnb' ? b.total - b.airbnbFee : b.total)
    const paidOn = (b: BookingView) => netPaid(payments, b.id)
    const dueOf = (b: BookingView) => (b.source === 'airbnb' ? addDays(b.checkIn, 1) : balanceDueOn(b.checkIn, policy))
    const receivable = (b: BookingView): ReceivableRow => {
      const paid = paidOn(b)
      const dueOn = dueOf(b)
      return { booking: b, expected: expected(b), paid, outstanding: Math.max(0, expected(b) - paid), dueOn, bucket: agingBucket(dueOn, today()), pendingLink: mineLinks.find((l) => l.bookingId === b.id && l.status === 'pending') ?? null }
    }
    return { w, fin, policy, payments: views, links: mineLinks, receivable, expected, dueOf }
  }

  async function maintenanceWorld() {
    const [w, workOrders, assets, vendors, plans, housekeeping, employees, transactions] = await Promise.all([bookingWorld(), ports.maintenance.workOrders(), ports.maintenance.assets(), ports.maintenance.vendors(), ports.maintenance.plans(), ports.maintenance.housekeeping(), ports.hr.employees(), ports.finance.transactions()])
    const entryOf = (id: string) => transactions.find((t) => t.id === id) ?? null
    /** Expense lines with the status of their ledger entry. */
    const expensesOf = (wo: WorkOrder) => wo.expenses.map((e) => ({ ...e, entry: entryOf(e.transactionId) }))
    const postedOf = (wo: WorkOrder) => sum(expensesOf(wo).filter((e) => e.entry?.status === 'posted').map((e) => e.amount))
    const villaIds = new Set(w.cat.villas.map((v) => v.id))
    const now = today()
    const villaName = (id: string) => w.cat.villas.find((v) => v.id === id)?.name ?? id
    const unitCode = (id: string | null) => (id ? (w.cat.units.find((u) => u.id === id)?.code ?? '') : '')
    const employeeName = (id: string | null) => (id ? (employees.find((e) => e.id === id)?.name ?? '') : '')
    const vendorName = (id: string | null) => (id ? (vendors.find((v) => v.id === id)?.name ?? '') : '')
    const assetName = (id: string | null) => (id ? (assets.find((a) => a.id === id)?.name ?? '') : '')
    const describe = (wo: WorkOrder): WorkOrderView => {
      const villa = w.cat.villa(wo.villaId)
      return {
        ...wo,
        villaName: villa.name,
        locationId: villa.locationId,
        locationName: w.cat.location(villa.locationId).name,
        unitCode: unitCode(wo.unitId),
        assetName: assetName(wo.assetId),
        assigneeName: employeeName(wo.assigneeId),
        vendorName: vendorName(wo.vendorId),
        partsTotal: partsCost(wo),
        total: workOrderCost(wo),
        spent: {
          recorded: sum(expensesOf(wo).filter((e) => e.entry?.status !== 'rejected' && e.entry?.status !== 'reversed').map((e) => e.amount)),
          approved: sum(expensesOf(wo).filter((e) => e.entry?.status === 'approved' || e.entry?.status === 'posted').map((e) => e.amount)),
          posted: postedOf(wo),
        },
        late: isOpenWorkOrder(wo) && Boolean(wo.scheduledOn && wo.scheduledOn < now),
      }
    }
    const mine = workOrders.filter((wo) => villaIds.has(wo.villaId))
    const views = sortWorkOrders(mine.map(describe))
    const describeAsset = (a: (typeof assets)[number]): AssetView => {
      const jobs = views.filter((wo) => wo.assetId === a.id)
      return { ...a, villaName: villaName(a.villaId), unitCode: unitCode(a.unitId), workOrders: jobs.length, openJobs: jobs.filter(isOpenWorkOrder).length, costToDate: sum(jobs.map((j) => j.spent.posted)), inWarranty: underWarranty(a, now) }
    }
    const describeVendor = (v: (typeof vendors)[number]): VendorView => {
      const jobs = views.filter((wo) => wo.vendorId === v.id)
      return { ...v, workOrders: jobs.length, openJobs: jobs.filter(isOpenWorkOrder).length, spend: sum(mine.flatMap((wo) => expensesOf(wo)).filter((e) => e.vendorId === v.id && e.entry?.status === 'posted').map((e) => e.amount)) }
    }
    const describePlan = (p: (typeof plans)[number]): PlanView => ({ ...p, villaName: villaName(p.villaId), unitCode: unitCode(p.unitId), assetName: assetName(p.assetId), assigneeName: employeeName(p.assigneeId), vendorName: vendorName(p.vendorId), state: planState(p, now), openWorkOrderId: views.find((wo) => wo.planId === p.id && isOpenWorkOrder(wo))?.id ?? null })
    const blockingJob = (unitId: string) => views.find((wo) => wo.unitId === unitId && wo.blockId && isOpenWorkOrder(wo) && w.blocks.some((k) => k.id === wo.blockId && k.from <= now && now < k.to)) ?? null
    const board: HousekeepingRow[] = w.cat.units.map((u) => {
      const record = housekeeping.find((h) => h.unitId === u.id) ?? null
      const job = blockingJob(u.id)
      const stays = w.views.filter((b) => b.unitId === u.id)
      return {
        place: w.cat.place(u.id),
        record,
        state: effectiveHousekeeping(record ?? undefined, Boolean(job), u.status === 'inactive'),
        blockingWorkOrder: job,
        arrival: stays.find((b) => b.status === 'confirmed' && b.checkIn <= now && now < b.checkOut) ?? null,
        departure: stays.find((b) => b.status === 'checked_in' && b.checkOut === now) ?? null,
        inHouse: stays.find((b) => b.status === 'checked_in' && b.checkOut > now) ?? null,
      }
    })
    return {
      ...w,
      workOrders: mine,
      views,
      describe,
      assets: assets.filter((a) => villaIds.has(a.villaId)).map(describeAsset),
      vendors: vendors.map(describeVendor),
      plans: plans.filter((p) => villaIds.has(p.villaId)).map(describePlan),
      board,
      employees: employees.filter((e) => e.status !== 'inactive'),
    }
  }

  /** Minutes since midnight on the device, for orders running late. */
  const minutesNow = () => {
    const d = new Date()
    return d.getHours() * 60 + d.getMinutes()
  }

  /** Room service orders, the menu and partners, narrowed to the villas the user may see. */
  async function orderWorld() {
    const [w, allOrders, allMenu, partners, payments] = await Promise.all([bookingWorld(), ports.orders.orders(), ports.orders.menu(), ports.orders.partners(), ports.payment.payments()])
    const bookingIds = new Set(w.bookings.map((b) => b.id))
    const villaIds = new Set(w.cat.villas.map((v) => v.id))
    const orders = allOrders.filter((o) => bookingIds.has(o.bookingId))
    const now = today()
    const minute = minutesNow()
    const describe = (o: ServiceOrder): ServiceOrderView => {
      const b = w.describe(findById(w.bookings, o.bookingId, 'booking'))
      const payment = o.paymentId ? payments.find((p) => p.id === o.paymentId) : undefined
      return { ...o, place: b.place, unitCode: b.unitCode, bookingCode: b.code, guestName: b.guestName, totals: orderTotals(o), payState: payState(o, payments), paymentNumber: payment?.number ?? null, late: orderLate(o, now, minute), delay: deliveryDelay(o) }
    }
    const describeItem = (i: MenuItem): MenuItemView => ({ ...i, villaName: w.cat.villas.find((v) => v.id === i.villaId)?.name ?? i.villaId, partner: partners.find((p) => p.id === i.partnerId) ?? null, margin: i.price - i.costPrice })
    return { w, orders, views: sortOrders(orders.map(describe)), describe, menu: allMenu.filter((i) => villaIds.has(i.villaId)), describeItem, partners, payments }
  }

  const inScope = (cat: Catalog, scope: Scope) => {
    const ids = new Set(unitsIn(cat, scope).map((u) => u.id))
    return (unitId: string) => ids.has(unitId)
  }
  const bySource = (source: string | undefined) => (b: Booking) =>
    !source || (source === DIRECT_SOURCE.id ? b.source === 'direct' : b.airbnbAccountId === source)

  function scopedTransactions<T extends Transaction>(views: readonly T[], scope: Scope) {
    return views.filter((t) => {
      if (scope.unitId) return t.unitId === scope.unitId
      if (scope.villaId) return t.villaId === scope.villaId
      if (scope.locationId) return t.locationId === scope.locationId
      return true
    })
  }

  const dashboard = {
    async filterOptions() {
      const [cat, accounts] = await Promise.all([catalog(), ports.airbnb.accounts()])
      return { catalog: cat, sources: sourceOptions(accounts) }
    },

    async executive(f: DashboardFilter) {
      const [w, fin, periods] = await Promise.all([bookingWorld(), financeWorld(), ports.payroll.periods()])
      const { current, previous } = periodRange(f.period, today(), f)
      const units = unitsIn(w.cat, f)
      const scoped = w.views.filter((b) => inScope(w.cat, f)(b.unitId)).filter(bySource(f.source))
      const rev = (r: DateRange) => revenueBetween(scoped, r.from, r.to)
      const sold = (r: DateRange) => nightsBetween(scoped, r.from, r.to)
      const occ = (r: DateRange) => occupancy(units, scoped, w.blocks, r.from, r.to).rate
      const avgRate = units.length ? sum(units.map((u) => u.nightlyRate)) / units.length : 0
      const activeUnits = units.filter((u) => u.status !== 'inactive').length
      const series = buckets(current, f.period).map((b) => ({
        ...b,
        revenue: rev(b),
        target: Math.round(activeUnits * daysBetween(b.from, b.to) * avgRate * TARGET_OCCUPANCY),
      }))
      const sources = sourceOptions(w.accounts).map((s) => ({
        ...s,
        value: revenueBetween(scoped.filter(bySource(s.id)), current.from, current.to),
      }))
      const byLocation = w.cat.locations.map((loc) => {
        const locUnits = units.filter((u) => w.cat.villa(u.villaId).locationId === loc.id)
        const locBookings = scoped.filter((b) => b.place.location.id === loc.id)
        return {
          location: loc,
          units: locUnits.length,
          occupancy: occupancy(locUnits, locBookings, w.blocks, current.from, current.to).rate,
          revenue: revenueBetween(locBookings, current.from, current.to),
        }
      }).filter((row) => row.units > 0)
      const horizon = addDays(today(), 7)
      const upcoming = scoped.filter((b) => b.status === 'confirmed' && b.checkIn >= today() && b.checkIn < horizon).sort((a, b) => a.checkIn.localeCompare(b.checkIn))
      const soldNow = sold(current)
      const soldPrev = sold(previous)
      const money = scopedTransactions(fin.views, f)
      const cash = cashSummary(money, current.from, current.to)
      const villaIds = new Set(units.map((u) => u.villaId))
      const payroll = sum(periods.filter((p) => p.status === 'closed' && `${p.month}-01` >= startOfMonth(current.from) && `${p.month}-01` < current.to).map((p) => sum([...costByVilla(p.lines)].filter(([id]) => villaIds.has(id)).map(([, v]) => v))))
      return {
        range: current,
        revenue: metric(rev(current), rev(previous)),
        occupancy: metric(occ(current), occ(previous)),
        adr: metric(soldNow ? rev(current) / soldNow : 0, soldPrev ? rev(previous) / soldPrev : 0),
        nightsSold: metric(soldNow, soldPrev),
        onTarget: series.filter((s) => s.revenue >= s.target).length,
        series,
        sources: sources.filter((s) => s.value > 0),
        byLocation,
        upcoming: upcoming.slice(0, 6),
        unitCount: units.length,
        cash,
        cashBalance: sum(fin.accounts.filter((a) => !f.locationId || a.locationId === f.locationId || a.locationId === null).map((a) => balance(a, fin.transactions))),
        payroll,
      }
    },

    async operational(f: DashboardFilter) {
      const w = await bookingWorld()
      const now = today()
      const units = unitsIn(w.cat, f)
      const scoped = w.views.filter((b) => inScope(w.cat, f)(b.unitId)).filter(bySource(f.source))
      const states = units.map((u) => ({ unit: u, state: nightState(u, now, w.bookings, w.blocks) }))
      const days = stripDays(now, 14)
      const strip = w.cat.locations
        .map((loc) => ({
          location: loc,
          values: days.map((d) => units.filter((u) => w.cat.villa(u.villaId).locationId === loc.id && nightState(u, d, w.bookings, w.blocks) === 'occupied').length),
        }))
        .filter((row) => sum(row.values) > 0 || units.some((u) => w.cat.villa(u.villaId).locationId === row.location.id))
      const requests = sortRequests((await serviceWorld()).views.filter((r) => inScope(w.cat, f)(r.unitId) && (r.status === 'open' || r.status === 'in_progress')))
      const blocks: BlockView[] = w.blocks
        .filter((k) => inScope(w.cat, f)(k.unitId) && k.to > now)
        .map((k) => ({ ...k, place: w.cat.place(k.unitId) }))
        .sort((a, b) => a.from.localeCompare(b.from))
      return {
        today: now,
        days,
        arrivals: arrivalsOn(scoped, now),
        departures: departuresOn(scoped, now),
        inHouse: inHouse(scoped).sort((a, b) => a.checkOut.localeCompare(b.checkOut)),
        lateArrivals: scoped.filter((b) => b.status === 'confirmed' && b.checkIn < now),
        overstays: scoped.filter((b) => b.status === 'checked_in' && b.checkOut < now),
        available: states.filter((s) => s.state === 'free').length,
        blockedTonight: states.filter((s) => s.state === 'blocked').length,
        cleaning: units.filter((u) => u.status === 'cleaning').length,
        maintenance: units.filter((u) => u.status === 'maintenance').length,
        units: units.length,
        strip: { labels: days.map((d) => shortDay(d).replace(/^\w+ /, '')), total: days.map((d) => units.filter((u) => nightState(u, d, w.bookings, w.blocks) === 'occupied').length), byLocation: strip },
        blocks,
        requests,
        /** Room service still to deliver, the late ones first. */
        orders: (await orderWorld()).views.filter((o) => isOpenOrder(o) && inScope(w.cat, f)(o.unitId)).sort((x, y) => Number(y.late) - Number(x.late)),
        notReady: (await maintenanceWorld()).board.filter((r) => r.arrival && r.state !== 'ready' && inScope(w.cat, f)(r.place.unit.id)),
      }
    },

    async financial(f: DashboardFilter) {
      const w = await financeWorld()
      const { current, previous } = periodRange(f.period, today(), f)
      const scoped = scopedTransactions(w.views, f)
      const weeks = buckets(current, f.period).map((b) => ({ ...b, ...cashSummary(scoped, b.from, b.to) }))
      const accounts = w.accounts
        .filter((a) => !f.locationId || a.locationId === f.locationId || a.locationId === null)
        .map((a) => ({ account: a, balance: balance(a, w.transactions), location: a.locationId ? w.cat.location(a.locationId) : null }))
      const pending = scoped.filter(awaitsApproval)
      return {
        range: current,
        summary: cashSummary(scoped, current.from, current.to),
        previous: cashSummary(scoped, previous.from, previous.to),
        pending: { count: pending.length, amount: sum(pending.map((t) => t.amount)) },
        weeks,
        expenses: byCategory(scoped, w.categories, 'cash_out', current.from, current.to),
        income: byCategory(scoped, w.categories, 'cash_in', current.from, current.to),
        accounts,
        totalBalance: sum(accounts.map((a) => a.balance)),
        recent: [...scoped].sort((a, b) => b.date.localeCompare(a.date) || b.number.localeCompare(a.number)).slice(0, 6),
      }
    },

    /** What the bell and the sidebar counts show. */
    async attention() {
      const [w, fin, sv, hr, a, m, ow, lowStock, journals] = await Promise.all([bookingWorld(), financeWorld(), serviceWorld(), hrWorld(), access(), maintenanceWorld(), orderWorld(), stock.lowStock(), accounting.approvalQueue()])
      const now = today()
      const pending = fin.views.filter(awaitsApproval)
      return {
        arrivals: arrivalsOn(w.views, now),
        late: w.views.filter((b) => b.status === 'confirmed' && b.checkIn < now),
        departures: departuresOn(w.views, now),
        pending,
        /** Entries the signed-in person can sign or post next. */
        mine: pending.filter((t) => (t.status === 'submitted' ? t.nextApprover !== null && canSignLevel(a.user.role, t.nextApprover) && t.createdById !== a.user.id : a.can('finance', 'post'))),
        /** Manual journals the signed-in person can sign or post next. */
        journals: journals.mine,
        requests: sortRequests(sv.views.filter((r) => r.status === 'open' || r.status === 'in_progress')),
        /** Room service waiting to be accepted, or past its requested time. */
        orders: ow.views.filter((o) => o.status === 'new' || o.late),
        hrPending: hr.leaves.filter((l) => l.status === 'pending').length + hr.overtime.filter((o) => o.status === 'pending').length + hr.loans.filter((l) => l.status === 'pending').length,
        /** Urgent jobs still open, and rooms with a guest arriving that are not ready. */
        urgentJobs: m.views.filter((wo) => isOpenWorkOrder(wo) && wo.priority === 'urgent'),
        notReady: m.board.filter((r) => r.arrival && r.state !== 'ready'),
        /** Stays booked against the room type arriving in the next two weeks without a room. */
        toAssign: unassigned(w.views).filter((b) => b.status === 'confirmed' && b.checkIn <= addDays(now, 14)),
        /** Villa store items at or under their reorder level. */
        lowStock,
        lowPetty: fin.accounts.filter((acc) => pettyLow(acc, balance(acc, fin.transactions))).map((acc) => ({ account: acc, balance: balance(acc, fin.transactions) })),
        /** The day the hotel trades on, which the night audit rolls forward. */
        businessDate: await ports.audit.businessDate(),
      }
    },
  }

  function unitRows(w: Awaited<ReturnType<typeof bookingWorld>>, units: readonly Unit[]): UnitRow[] {
    const now = today()
    return units.map((u) => {
      const listing = w.listings.find((l) => l.unitId === u.id) ?? null
      const next = w.views.filter((b) => b.unitId === u.id && b.status === 'confirmed' && b.checkIn >= now).sort((a, b) => a.checkIn.localeCompare(b.checkIn))[0] ?? null
      return {
        place: w.cat.place(u.id),
        tonight: nightState(u, now, w.bookings, w.blocks),
        listing,
        account: listing ? findById(w.accounts, listing.accountId, 'Airbnb account') : null,
        nextArrival: next,
      }
    })
  }

  const last30 = () => ({ from: addDays(today(), -29), to: addDays(today(), 1) })

  /** Saves a unit and says whether the room type it joined got its first rate plan from the unit's base price. */
  async function withNewPlan(groupId: string | null, save: () => Promise<Unit>) {
    const had = groupId !== null && (await ports.property.ratePlans()).some((p) => p.groupId === groupId)
    const unit = await save()
    const newPlan = unit.groupId && !had ? ((await ports.property.ratePlans()).find((p) => p.groupId === unit.groupId) ?? null) : null
    return { unit, newPlan }
  }

  const property = {
    async overview() {
      const w = await bookingWorld()
      const r = last30()
      const now = today()
      return {
        today: now,
        locations: w.cat.locations.map((loc) => {
          const villas = w.cat.villas.filter((v) => v.locationId === loc.id)
          const units = unitsIn(w.cat, { locationId: loc.id })
          const bookings = w.views.filter((b) => b.place.location.id === loc.id)
          return {
            location: loc,
            unitCount: units.length,
            occupiedTonight: units.filter((u) => nightState(u, now, w.bookings, w.blocks) === 'occupied').length,
            occupancy30: occupancy(units, bookings, w.blocks, r.from, r.to).rate,
            revenue30: revenueBetween(bookings, r.from, r.to),
            villas: villas.map((villa) => ({
              villa,
              groups: w.cat.groups.filter((g) => g.villaId === villa.id),
              units: unitRows(w, w.cat.units.filter((u) => u.villaId === villa.id)),
            })),
          }
        }),
      }
    },

    async villa(id: string) {
      const w = await bookingWorld()
      const villa = w.cat.villa(id)
      const r = last30()
      const units = w.cat.units.filter((u) => u.villaId === id)
      const bookings = w.views.filter((b) => b.place.villa.id === id)
      const now = today()
      return {
        villa,
        location: w.cat.location(villa.locationId),
        locations: w.cat.locations,
        groups: w.cat.groups.filter((g) => g.villaId === id).map((g) => ({ group: g, units: units.filter((u) => u.groupId === g.id) })),
        ungrouped: units.filter((u) => !u.groupId),
        units: unitRows(w, units),
        occupancy30: occupancy(units, bookings, w.blocks, r.from, r.to).rate,
        revenue30: revenueBetween(bookings, r.from, r.to),
        upcoming: bookings.filter((b) => b.status === 'confirmed' && b.checkIn >= now).sort((a, b) => a.checkIn.localeCompare(b.checkIn)).slice(0, 8),
        inHouse: inHouse(bookings),
      }
    },

    async unit(id: string) {
      const w = await bookingWorld()
      const place = w.cat.place(id)
      const r = last30()
      const now = today()
      const bookings = w.views.filter((b) => b.unitId === id)
      const listing = w.listings.find((l) => l.unitId === id) ?? null
      const plans = await ports.property.ratePlans()
      return {
        place,
        listing,
        /** The list direct stays sell at: the live listing, else the room type's rate plan, else none. */
        priceList: priceListFor(place.unit, listing, plans)?.kind ?? null,
        ratePlan: plans.find((p) => p.groupId === place.unit.groupId) ?? null,
        account: listing ? findById(w.accounts, listing.accountId, 'Airbnb account') : null,
        strip: stripDays(now, 14).map((date) => ({ date, state: nightState(place.unit, date, w.bookings, w.blocks) })),
        tonight: nightState(place.unit, now, w.bookings, w.blocks),
        occupancy30: occupancy([place.unit], bookings, w.blocks, r.from, r.to).rate,
        revenue30: revenueBetween(bookings, r.from, r.to),
        upcoming: bookings.filter((b) => occupies(b) && b.checkOut > now).sort((a, b) => a.checkIn.localeCompare(b.checkIn)),
        past: bookings.filter((b) => b.status === 'checked_out').length,
        blocks: w.blocks.filter((k) => k.unitId === id && k.to > now).sort((a, b) => a.from.localeCompare(b.from)),
        mates: place.group?.interchangeable ? w.cat.units.filter((u) => u.groupId === place.group?.id && u.id !== id) : [],
        groups: w.cat.groups.filter((g) => g.villaId === place.villa.id),
      }
    },

    async setGroupInterchangeable(id: string, interchangeable: boolean) {
      const group = findById(await ports.property.groups(), id, 'unit group')
      return ports.property.updateGroup(id, { villaId: group.villaId, name: group.name, interchangeable, operatorAssigns: interchangeable && group.operatorAssigns })
    },
    /** Guests book the room type and the operator assigns the room; only identical, interchangeable rooms qualify. */
    async setGroupRoomType(id: string, operatorAssigns: boolean) {
      await allow('property', 'edit')
      const group = findById(await ports.property.groups(), id, 'unit group')
      const input = { villaId: group.villaId, name: group.name, interchangeable: group.interchangeable, operatorAssigns }
      check(validateGroup(input))
      return ports.property.updateGroup(id, input)
    },
    /** The room type page: its rooms, which of them sell from the rate plan, and the plan's next nights. */
    async roomType(id: string, days = 14) {
      const [cat, listings, plans] = await Promise.all([catalog(), ports.airbnb.listings(), ports.property.ratePlans()])
      const group = cat.group(id)
      const plan = plans.find((p) => p.groupId === id) ?? null
      const now = today()
      const rooms = cat.units.filter((u) => u.groupId === id)
      return {
        group,
        villa: cat.villa(group.villaId),
        plan,
        /** What a new plan starts from: the first room's base price. */
        suggested: rooms[0] ? defaultRatePlan(rooms[0].nightlyRate) : null,
        units: rooms.map((unit) => ({ unit, priceList: priceListFor(unit, listings.find((l) => l.unitId === unit.id), plans)?.kind ?? null })),
        nights: plan ? eachDay(now, addDays(now, days)).map((date) => ({ date, ...planNight(plan, date) })) : [],
        mayEdit: (await access()).can('property', 'edit'),
      }
    },
    async saveRatePlan(groupId: string, input: RatePlanInput) {
      await allow('property', 'edit')
      check(validateRatePlan(input))
      return ports.property.saveRatePlan(groupId, input)
    },
    async createLocation(input: LocationInput) {
      await allow('master', 'create')
      check(validateLocation(input))
      return ports.property.createLocation(input)
    },
    async updateLocation(id: string, input: LocationInput) {
      await allow('master', 'edit')
      check(validateLocation(input))
      return ports.property.updateLocation(id, input)
    },
    async createVilla(input: VillaInput) {
      await allow('master', 'create')
      check(validateVilla(input, await ports.property.villas()))
      return ports.property.createVilla(input)
    },
    async createProperty(input: PropertyInput) {
      await allow('master', 'create')
      const [villas, units] = await Promise.all([ports.property.villas(), ports.property.units()])
      check(validateProperty(input, villas, units))
      return ports.property.createProperty(input)
    },
    async updateVilla(id: string, input: VillaInput) {
      await allow('master', 'edit')
      check(validateVilla(input, await ports.property.villas(), id))
      return ports.property.updateVilla(id, input)
    },
    async createGroup(input: GroupInput) {
      await allow('master', 'create')
      check(validateGroup(input))
      return ports.property.createGroup(input)
    },
    async updateGroup(id: string, input: GroupInput) {
      await allow('master', 'edit')
      check(validateGroup(input))
      return ports.property.updateGroup(id, input)
    },
    async createUnit(input: UnitInput) {
      await allow('master', 'create')
      return withNewPlan(input.groupId, async () => {
        const [units, groups] = await Promise.all([ports.property.units(), ports.property.groups()])
        check(validateUnit(input, units, groups))
        return ports.property.createUnit(input)
      })
    },
    async updateUnit(id: string, input: UnitInput) {
      return withNewPlan(input.groupId, async () => {
        const [units, groups] = await Promise.all([ports.property.units(), ports.property.groups()])
        check(validateUnit(input, units, groups, id))
        return ports.property.updateUnit(id, input)
      })
    },
  }

  const airbnb = {
    async overview() {
      const w = await bookingWorld()
      const r = last30()
      const now = today()
      const airbnbBookings = w.views.filter((b) => b.source === 'airbnb')
      return {
        accounts: w.accounts.map((a) => {
          const mine = airbnbBookings.filter((b) => b.airbnbAccountId === a.id)
          return {
            account: a,
            listings: w.listings.filter((l) => l.accountId === a.id).length,
            bookings30: mine.filter((b) => b.checkIn >= r.from && b.checkIn < r.to && b.status !== 'cancelled').length,
            revenue30: revenueBetween(mine, r.from, r.to),
            fee30: sum(mine.filter((b) => b.checkIn >= r.from && b.checkIn < r.to && b.status !== 'cancelled').map((b) => b.airbnbFee)),
            unpaid: mine.filter((b) => b.status !== 'cancelled' && b.status !== 'draft' && b.paymentStatus !== 'paid').length,
            upcoming: mine.filter((b) => b.status === 'confirmed' && b.checkIn >= now).length,
          }
        }),
        listings: w.listings.map((l) => ({
          listing: l,
          account: findById(w.accounts, l.accountId, 'Airbnb account'),
          place: w.cat.place(l.unitId),
          bookings30: airbnbBookings.filter((b) => b.unitId === l.unitId && b.checkIn >= r.from && b.checkIn < r.to && b.status !== 'cancelled').length,
          nextArrival: airbnbBookings.filter((b) => b.unitId === l.unitId && b.status === 'confirmed' && b.checkIn >= now).sort((a, b) => a.checkIn.localeCompare(b.checkIn))[0] ?? null,
        })),
        revenue30: revenueBetween(airbnbBookings, r.from, r.to),
        share30: (() => {
          const all = revenueBetween(w.views, r.from, r.to)
          return all ? revenueBetween(airbnbBookings, r.from, r.to) / all : 0
        })(),
      }
    },

    async account(id: string) {
      const w = await bookingWorld()
      const account = findById(w.accounts, id, 'Airbnb account')
      const bookings = sortBookings(w.views.filter((b) => b.airbnbAccountId === id), today())
      const r = last30()
      const live = bookings.filter((b) => b.status !== 'cancelled' && b.status !== 'draft')
      return {
        account,
        bookings30: bookings.filter((b) => b.checkIn >= r.from && b.checkIn < r.to && b.status !== 'cancelled').length,
        revenue30: revenueBetween(bookings, r.from, r.to),
        fees: sum(live.map((b) => b.airbnbFee)),
        payout: sum(live.map((b) => b.payout)),
        unpaid: live.filter((b) => b.paymentStatus !== 'paid'),
        upcoming: bookings.filter((b) => b.status === 'confirmed' && b.checkIn >= today()).length,
        listings: w.listings.filter((l) => l.accountId === id).map((l) => ({ listing: l, place: w.cat.place(l.unitId) })),
        bookings: bookings.slice(0, 12),
        total: bookings.length,
      }
    },

    /** The listing's price calendar: base rate and each night's price for `days` nights from `from`. */
    async listing(id: string, from = today(), days = 42) {
      const w = await bookingWorld()
      const listing = findById(w.listings, id, 'listing')
      const place = w.cat.place(listing.unitId)
      return {
        listing,
        place,
        account: findById(w.accounts, listing.accountId, 'Airbnb account'),
        baseRate: place.unit.nightlyRate,
        today: today(),
        nights: eachDay(from, addDays(from, days)).map((date) => ({ date, rate: listing.dateRates[date] ?? place.unit.nightlyRate, custom: date in listing.dateRates, state: nightState(place.unit, date, w.bookings, w.blocks) })),
      }
    },
    /** One price list: the base rate is the unit's rate, so the unit, new direct stays and the listing all move together. */
    async setListingPrices(id: string, input: ListingPriceInput) {
      await allow('airbnb', 'edit')
      check(validateListingPrice(input))
      return ports.airbnb.setListingPrices(id, input)
    },
    setListingStatus: (id: string, status: ListingStatus) => ports.airbnb.setListingStatus(id, status),
    async createAccount(input: AirbnbAccountInput) {
      check(validateAirbnbAccount(input, await ports.airbnb.accounts()))
      return ports.airbnb.createAccount(input)
    },
    async updateAccount(id: string, input: AirbnbAccountInput) {
      check(validateAirbnbAccount(input, await ports.airbnb.accounts(), id))
      return ports.airbnb.updateAccount(id, input)
    },
    async createListing(input: ListingInput) {
      check(validateListing(input, await ports.airbnb.listings()))
      return ports.airbnb.createListing(input)
    },
    async updateListing(id: string, input: ListingInput) {
      check(validateListing(input, await ports.airbnb.listings(), id))
      return ports.airbnb.updateListing(id, input)
    },
    async formOptions() {
      const [cat, accounts, listings] = await Promise.all([catalog(), ports.airbnb.accounts(), ports.airbnb.listings()])
      return { catalog: cat, accounts, listings }
    },
  }

  const booking = {
    async list() {
      const w = await bookingWorld()
      const now = today()
      const list = sortBookings(w.views, now)
      const statuses: Array<BookingStatus | 'all'> = ['all', 'draft', 'confirmed', 'checked_in', 'checked_out', 'cancelled', 'no_show']
      const counted = Object.fromEntries(statuses.map((s) => [s, s === 'all' ? list.length : list.filter((b) => b.status === s).length])) as Record<BookingStatus | 'all', number>
      return {
        today: now,
        list,
        counts: counted,
        sources: sourceOptions(w.accounts),
        arriving: arrivalsOn(list, now).length,
        inHouse: inHouse(list).length,
        departing: departuresOn(list, now).length,
        drafts: counted.draft,
        unpaid: list.filter((b) => (b.status === 'confirmed' || b.status === 'checked_in') && b.paymentStatus !== 'paid').length,
      }
    },

    async detail(id: string) {
      const w = await bookingWorld()
      const b = w.describe(findById(w.bookings, id, 'booking'))
      const requests = sortRequests((await serviceWorld()).views.filter((r) => r.bookingId === id))
      const money = (await financeWorld()).views.filter((t) => t.bookingId === id)
      const invoice = await payments.invoice(id)
      const policy = await ports.payment.policy()
      const ending = (outcome: 'cancelled' | 'no_show') => (b.source === 'direct' ? cancellationTerms(invoice.paid, invoice.expected, b.checkIn, today(), policy, outcome) : { refund: 0, retained: invoice.paid })
      const bill = await booking.folio(id)
      return {
        booking: b,
        requests,
        transactions: money,
        cashbox: (await ports.finance.accounts()).find((a) => a.kind === 'cashbox' && a.locationId === b.place.location.id) ?? null,
        housekeeping: (await maintenanceWorld()).board.find((r) => r.place.unit.id === b.unitId)?.state ?? 'ready',
        invoice,
        folio: bill.folio,
        rebates: bill.rebates,
        refunds: bill.refunds,
        /** What cancelling or a no-show would do with the money paid so far. */
        ending: { cancelled: ending('cancelled'), no_show: ending('no_show') },
        today: today(),
        steps: lifecycleSteps(b, today(), shortDay),
        swapTargets: b.unitAssigned ? swapTargets(b, w.cat, w.bookings, w.blocks) : [],
        /** For a villa that sells the room type: the rooms free for the whole stay, to assign or reassign before check-in. */
        assignable: sellsRoomType(b.place.group) && (b.status === 'confirmed' || b.status === 'draft') ? typeAvailability(w.cat, b.place.group?.id ?? '', b.checkIn, b.checkOut, w.bookings, w.blocks, b.id).units : [],
        nights: soldNights(b),
        pricing: { channel: isChannel(b), limitPct: policy.discountLimitPct, mayApprove: (await access()).can('booking', 'approve'), listing: w.listings.find((l) => l.unitId === b.unitId) ?? null },
        movements: b.movements.map((m) => ({ ...m, from: w.cat.unit(m.fromUnitId), to: w.cat.unit(m.toUnitId) })),
        others: sortBookings(w.views.filter((o) => o.guestId === b.guestId && o.id !== b.id), today()).slice(0, 4),
      }
    },

    async formOptions() {
      const w = await bookingWorld()
      return { catalog: w.cat, guests: [...w.guests].sort((a, b) => a.name.localeCompare(b.name)), accounts: w.accounts, listings: w.listings, today: today() }
    },

    /** Live check while a form is typed: conflicts, and interchangeable units that are free. */
    async availability(unitId: string, checkIn: string, checkOut: string, excludeId?: string) {
      const w = await bookingWorld()
      const problem = validateStay(checkIn, checkOut)
      if (problem) return { problem, conflicts: [], alternatives: [] as Unit[], roomTypeFull: false }
      const group = w.cat.place(unitId).group
      return {
        problem: null,
        /** In a villa that sells the room type, stays waiting for a room can fill the type while this room looks free. */
        roomTypeFull: sellsRoomType(group) && typeAvailability(w.cat, group?.id ?? '', checkIn, checkOut, w.bookings, w.blocks, excludeId).free < 1,
        conflicts: findConflicts(unitId, checkIn, checkOut, w.bookings, w.blocks, excludeId),
        alternatives: interchangeableFree(w.cat, unitId, checkIn, checkOut, w.bookings, w.blocks, excludeId),
      }
    },

    /**
     * What a stay costs before it is saved: for a direct stay the live listing's price per night, or
     * the room type's rate plan when the unit has no live listing, with the staff price on top; the
     * channel price for Airbnb. Each night says where its price came from. `limitPct` and
     * `beyondLimit` say whether the signed-in person may give that price on their own.
     */
    async quote(input: { unitId: string | null; groupId: string | null; checkIn: string; checkOut: string; source: NewBooking['source']; channelRate: number | null; price: PriceChange | null }) {
      const [cat, listings, plans, policy, a] = await Promise.all([catalog(), ports.airbnb.listings(), ports.property.ratePlans(), ports.payment.policy(), access()])
      const unit = input.unitId ? cat.unit(input.unitId) : input.groupId ? cat.units.find((u) => u.groupId === input.groupId && u.status !== 'inactive') : undefined
      if (!unit || validateStay(input.checkIn, input.checkOut)) return null
      const direct = input.source === 'direct'
      const list = direct ? priceListFor(unit, listings.find((l) => l.unitId === unit.id), plans) : null
      if (direct && !list) throw new RuleError('NO_PRICE', noPriceMessage(unit.code))
      const nights: NightPrice[] = list ? listNights(list, unit.nightlyRate, input.checkIn, input.checkOut) : eachDay(input.checkIn, input.checkOut).map((date) => ({ date, rate: input.channelRate ?? 0, source: { kind: 'channel' } }))
      const listRates = nights.map((n) => n.rate)
      const priced = { listRates, rateOverride: direct ? (input.price?.rateOverride ?? null) : null, discount: direct ? (input.price?.discount ?? null) : null }
      const price = stayPrice(priced)
      const beyondLimit = beyondDiscountLimit(price, policy.discountLimitPct)
      return { listRates, nights, priceList: list?.kind ?? null, price, limitPct: policy.discountLimitPct, beyondLimit, mayApprove: a.can('booking', 'approve') }
    },

    async create(input: NewBooking) {
      await allow('booking', 'create')
      const errors: Record<string, string> = {}
      const stay = validateStay(input.checkIn, input.checkOut)
      if (stay) errors.checkOut = stay
      if (!input.unitId && !input.groupId) errors.unitId = 'Pick a unit or a room type.'
      if (!input.guestId && !input.newGuest) errors.guestId = 'Pick a guest or add a new one.'
      if (input.newGuest) Object.assign(errors, Object.fromEntries(Object.entries(validateGuest(input.newGuest)).map(([k, v]) => [`guest.${k}`, v])))
      if (input.source === 'airbnb' && !input.airbnbAccountId) errors.airbnbAccountId = 'Pick the Airbnb account.'
      if (input.source === 'airbnb' && !(input.airbnbCode ?? '').trim()) errors.airbnbCode = 'Enter the Airbnb confirmation code.'
      if (input.source !== 'direct' && (!Number.isInteger(input.channelRate) || (input.channelRate ?? 0) <= 0)) errors.channelRate = 'Enter the nightly price the channel sold.'
      if (input.source === 'direct' && input.price) Object.assign(errors, validatePriceChange(input.price))
      if (Object.keys(errors).length) throw new ValidationError(errors)
      if (input.payment) {
        const quoted = await booking.quote(input)
        if (!Number.isInteger(input.payment.amount) || input.payment.amount <= 0) throw new ValidationError({ 'payment.amount': 'Enter the amount the guest pays now.' })
        if (quoted && input.payment.amount > quoted.price.total) throw new ValidationError({ 'payment.amount': 'More than the stay costs.' })
        if (input.payment.method === 'bank_transfer' && input.payment.reference.trim().length < 3) throw new ValidationError({ 'payment.reference': 'Enter the bank reference.' })
      }
      const created = await ports.booking.create(input)
      if (input.payment) {
        const guest = (await ports.guest.guests()).find((g) => g.id === created.guestId)?.name ?? ''
        const base = { bookingId: created.id, kind: input.payment.kind, method: input.payment.method, amount: input.payment.amount }
        if (isGateway(input.payment.method)) await ports.payment.createLink({ ...base, payer: guest })
        else await ports.payment.record({ ...base, reference: input.payment.reference, payer: guest, note: 'Taken with the booking' })
      }
      const w = await bookingWorld()
      return w.describe(findById(w.bookings, created.id, 'booking'))
    },

    /** Cancelling or a no-show closes the open payment links and, for a direct stay, refunds what the policy gives back. */
    async transition(id: string, to: BookingAction) {
      const ending = to === 'cancelled' || to === 'no_show' ? await payments.invoice(id) : null
      const b = await ports.booking.transition(id, to)
      if (ending) await settleEnding(ending, to as 'cancelled' | 'no_show')
      return (await bookingWorld()).describe(b)
    },

    /** Front-desk check-in: the record, then the deposit as a submitted cash-in on the location's cashbox. */
    async checkIn(id: string, details: CheckInDetails) {
      check(validateCheckIn(details))
      const w = await bookingWorld()
      const b = w.describe(findById(w.bookings, id, 'booking'))
      const updated = await ports.booking.checkIn(id, details)
      if (details.deposit > 0) {
        const accounts = await ports.finance.accounts()
        const cashbox = accounts.find((a) => a.kind === 'cashbox' && a.locationId === b.place.location.id) ?? accounts[0]
        if (cashbox) {
          await ports.finance.createTransaction(
            { accountId: cashbox.id, kind: 'cash_in', categoryId: 'cat-deposit', amount: details.deposit, date: today(), locationId: b.place.location.id, villaId: b.place.villa.id, unitId: b.unitId, bookingId: id, description: `Security deposit, ${b.code} ${b.guestName}`, reference: b.code, attachments: [] },
            true,
            'front_desk',
          )
        }
      }
      return (await bookingWorld()).describe(updated)
    },

    /** Front-desk check-out: deposit returned as cash out, extra charges as cash in, both submitted for approval. */
    async checkOut(id: string, details: CheckOutDetails) {
      const w = await bookingWorld()
      const b = w.describe(findById(w.bookings, id, 'booking'))
      check(validateCheckOut(details, b.arrival?.deposit ?? 0))
      const updated = await ports.booking.checkOut(id, details)
      const accounts = await ports.finance.accounts()
      const cashbox = accounts.find((a) => a.kind === 'cashbox' && a.locationId === b.place.location.id) ?? accounts[0]
      if (cashbox) {
        const base = { accountId: cashbox.id, date: today(), locationId: b.place.location.id, villaId: b.place.villa.id, unitId: b.unitId, bookingId: id, reference: b.code, attachments: [] }
        if (details.depositReturned > 0) await ports.finance.createTransaction({ ...base, kind: 'cash_out', categoryId: 'cat-other', amount: details.depositReturned, description: `Deposit returned, ${b.code} ${b.guestName}` }, true, 'front_desk')
        if (details.extraCharges > 0) await ports.finance.createTransaction({ ...base, kind: 'cash_in', categoryId: 'cat-extra', amount: details.extraCharges, description: `Departure charges, ${b.code} ${b.guestName}` }, true, 'front_desk')
      }
      await ports.maintenance.setHousekeeping(b.unitId, 'dirty', `Checked out ${b.code}`)
      return (await bookingWorld()).describe(updated)
    },
    /** The guest folio: every debit and credit on the stay with a running balance. Check-out settles from it. */
    async folio(id: string) {
      const [w, paid, served, postings] = await Promise.all([bookingWorld(), ports.payment.payments(), ports.orders.orders(), ports.folio.postings(id)])
      const b = w.describe(findById(w.bookings, id, 'booking'))
      const sources = { booking: b, payments: paid, orders: served, postings }
      const f = guestFolio({ ...sources, roomOnMaster: b.group?.billing === 'master' })
      const refunded = (p: Payment) => sum(paid.filter((r) => r.refundOf === p.id && r.status === 'paid').map((r) => r.amount))
      return {
        booking: b,
        folio: f,
        /** Posted lines a rebate can still correct; a master-billed stay's room nights count too. */
        rebates: rebateTargets(guestFolio(sources).lines),
        /** Paid money a refund can give back, up to the credit in its part of the bill. */
        refunds: f.refundDue > 0 ? paid.filter((p) => p.bookingId === id && p.kind !== 'refund' && p.kind !== 'payout' && (p.status === 'paid' || p.status === 'refunded')).map((p) => ({ payment: p, refundable: refundable(f, p, refunded(p)) })).filter((r) => r.refundable > 0) : [],
        today: today(),
      }
    },
    /**
     * What is left to take at check-out, read from the folio: room balance (none on an Airbnb stay), unpaid room service,
     * open charges less allowances, and any settle link already sent. `owed` is their sum, the folio's amount due.
     */
    async settlement(id: string) {
      const [{ booking: b, folio: f }, stay, links] = await Promise.all([booking.folio(id), orders.forStay(id), ports.payment.links()])
      const dueOn = (orderId: string) => f.due.orders.find((o) => o.orderId === orderId)?.amount ?? 0
      return {
        /** For a stay of a master-billed group: the group's open room balance, and whether this check-out is the last. */
        master: b.group?.billing === 'master' ? await groups.masterDue(b.group.id, b.id) : null,
        roomDue: f.due.room,
        orders: stay.orders.filter((o) => o.payState === 'unpaid' && dueOn(o.id) > 0).map((o) => ({ id: o.id, number: o.number, items: o.lines.map((l) => `${l.quantity} × ${l.name}`).join(', '), amount: dueOn(o.id) })),
        charges: f.due.charges,
        owed: folioOwed(f),
        /** Credit the guest has beyond a part of the bill; check-out offers it back on the folio. */
        refundDue: f.refundDue,
        /** Posted lines only, and the room nights still to post: check-out settles both. */
        balance: f.balance,
        forecast: f.forecast,
        /** Orders already on a link of their own; they block the settle path until paid or cancelled. */
        waiting: stay.orders.filter((o) => o.payState === 'pending').map((o) => o.number),
        held: b.arrival?.deposit ?? 0,
        link: links.find((l) => l.bookingId === id && l.status === 'pending' && l.checkOut) ?? null,
      }
    },
    /** Takes the whole bill and checks out in one step; see BookingPort.settleAndCheckOut. */
    async settleAndCheckOut(id: string, input: SettleInput) {
      const due = await booking.settlement(id)
      const lines = settlementLines(due.roomDue, due.orders, input.details.extraCharges, due.charges)
      if (lines.some((l) => l.kind !== 'charges')) await allow('payments', 'create')
      check({ ...validateCheckOut(input.details, due.held), ...validateSettle(input, lines) })
      if (due.master?.closes && due.master.due > 0) throw new RuleError('GROUP_MASTER_OPEN', `This is the last stay of ${due.master.code}; take the master folio balance on the group page first.`)
      const result = await ports.booking.settleAndCheckOut(id, input)
      return { booking: (await bookingWorld()).describe(result.booking), link: result.link }
    },
    /** The active charge codes the desk picks a manual charge from. */
    async chargeCodes() {
      return chargeCodes(await ports.ledger.transactionCodes())
    },
    /** A minibar, damage, late check-out or other charge on the folio of a stay in house, on its transaction code. */
    async postCharge(id: string, input: ChargeInput) {
      await allow('booking', 'edit')
      check(validateCharge(input, await ports.ledger.transactionCodes()))
      return ports.folio.postCharge(id, input)
    },
    /**
     * A rebate on one posted line with the reason, on that line's code; past the discount limit share
     * of the line it needs someone who may approve bookings.
     */
    async postRebate(id: string, input: RebateInput) {
      await allow('booking', 'edit')
      const { rebates } = await booking.folio(id)
      check(validateRebate(input, rebates.find((t) => t.line.id === input.lineId) ?? null))
      return ports.folio.postRebate(id, input)
    },
    /**
     * Gives a credit back to the guest against the payment that brought the money in: a refund line on
     * the folio and a submitted cash-out through the payments refund, signed through the approval chain.
     */
    async refund(id: string, input: { paymentId: string; amount: number; reason: string; attachments?: readonly Attachment[] }) {
      const { refunds } = await booking.folio(id)
      const target = refunds.find((r) => r.payment.id === input.paymentId)
      if (!target) throw new RuleError('REFUND_EXCEEDS_CREDIT', 'Nothing on that payment is owed back; the folio has no credit in its part of the bill.')
      if (input.amount > target.refundable) throw new RuleError('REFUND_EXCEEDS_CREDIT', `Only ${target.refundable} of ${target.payment.number} is owed back to the guest.`)
      return payments.refund(input.paymentId, input.amount, input.reason, input.attachments ?? [])
    },
    async moveUnit(id: string, unitId: string, reason: string, price?: PriceChange) {
      if (reason.trim().length < 3) throw new ValidationError({ reason: 'Say why the guest moves.' })
      if (price) check(validatePriceChange(price))
      const b = await ports.booking.moveUnit(id, unitId, reason.trim(), price)
      return (await bookingWorld()).describe(b)
    },
    async adjustStay(id: string, checkIn: string, checkOut: string, channelRate?: number) {
      const problem = validateStay(checkIn, checkOut)
      if (problem) throw new ValidationError({ checkOut: problem })
      if (channelRate !== undefined && (!Number.isInteger(channelRate) || channelRate <= 0)) throw new ValidationError({ channelRate: 'Enter the nightly price the channel charged.' })
      const b = await ports.booking.adjustStay(id, checkIn, checkOut, channelRate)
      return (await bookingWorld()).describe(b)
    },
    /** A staff rate or discount on a direct stay; the deposit and balance follow the new total. */
    async setPrice(id: string, price: PriceChange) {
      await allow('booking', 'edit')
      check(validatePriceChange(price))
      return (await bookingWorld()).describe(await ports.booking.setPrice(id, price))
    },
    /** Picks the room for a stay booked against the room type, or changes it before check-in. */
    async assignUnit(id: string, unitId: string) {
      await allow('booking', 'edit')
      if (!unitId) throw new ValidationError({ unitId: 'Pick a room.' })
      return (await bookingWorld()).describe(await ports.booking.assignUnit(id, unitId))
    },
    /** Rooms of the type still free for a stay, and the rooms an operator can assign. */
    async roomTypeAvailability(groupId: string, checkIn: string, checkOut: string, excludeId?: string) {
      const w = await bookingWorld()
      if (validateStay(checkIn, checkOut)) return null
      return typeAvailability(w.cat, groupId, checkIn, checkOut, w.bookings, w.blocks, excludeId)
    },
    async updateNotes(id: string, notes: string) {
      const b = await ports.booking.updateNotes(id, notes)
      return (await bookingWorld()).describe(b)
    },
    async setPayment(id: string, payment: PaymentInput) {
      const w = await bookingWorld()
      const b = w.describe(findById(w.bookings, id, 'booking'))
      check(validatePayment(payment, b.total, b.source))
      return (await bookingWorld()).describe(await ports.booking.setPayment(id, payment))
    },
    async addBlock(input: Omit<UnitBlock, 'id'>) {
      const problem = validateStay(input.from, input.to)
      if (problem) throw new ValidationError({ to: problem.replace('Check-out', 'The end').replace('check-in', 'the start') })
      return ports.booking.addBlock(input)
    },
    removeBlock: (id: string) => ports.booking.removeBlock(id),

    async calendar(from: IsoDate, days: number, scope: Scope) {
      const w = await bookingWorld()
      const to = addDays(from, days)
      const dayList = eachDay(from, to)
      const sources = sourceOptions(w.accounts)
      const slotOf = (b: Booking) => (b.source === 'direct' ? DIRECT_SOURCE.slot : (sources.find((s) => s.id === b.airbnbAccountId)?.slot ?? 0))
      const bookingSpan = (b: BookingView): CalendarSpan => {
        const start = Math.max(0, daysBetween(from, b.checkIn))
        const end = Math.min(days, daysBetween(from, b.checkOut))
        return { kind: 'booking', id: b.id, start, length: end - start, label: b.guestName, slot: slotOf(b), status: b.status, clippedStart: b.checkIn < from, clippedEnd: b.checkOut > to, ...(b.group ? { group: b.group.code } : {}) }
      }
      const units = unitsIn(w.cat, scope)
      const unitRowsOf: CalendarRow[] = units.map((u) => {
        const place = w.cat.place(u.id)
        const spans: CalendarSpan[] = w.views.filter((b) => b.unitId === u.id && b.unitAssigned && occupies(b) && b.checkIn < to && b.checkOut > from).map(bookingSpan)
        for (const k of w.blocks.filter((k) => k.unitId === u.id && k.from < to && k.to > from)) {
          const start = Math.max(0, daysBetween(from, k.from))
          const end = Math.min(days, daysBetween(from, k.to))
          spans.push({ kind: 'block', id: k.id, start, length: end - start, label: k.note || k.reason, slot: 0, status: k.reason, clippedStart: k.from < from, clippedEnd: k.to > to })
        }
        return { key: u.id, place, lane: null, spans: spans.sort((a, b) => a.start - b.start), states: dayList.map((d) => nightState(u, d, w.bookings, w.blocks)) }
      })
      // Stays waiting for a room sit in lanes under their villa, packed so none overlap.
      const waiting = unassigned(w.views).filter((b) => b.status === 'confirmed' && units.some((u) => u.id === b.unitId) && b.checkIn < to && b.checkOut > from)
      const lanes: CalendarRow[] = []
      for (const b of waiting) {
        const group = b.place.group
        const lane = lanes.find((r) => r.place.group?.id === group?.id && r.spans.every((x) => x.start + x.length <= bookingSpan(b).start || bookingSpan(b).start + bookingSpan(b).length <= x.start))
        if (lane) lane.spans.push(bookingSpan(b))
        else lanes.push({ key: `lane-${group?.id ?? b.place.villa.id}-${lanes.length}`, place: b.place, lane: `${group?.name ?? 'Room type'}, to assign`, spans: [bookingSpan(b)], states: dayList.map(() => 'free') })
      }
      const rows = [...unitRowsOf, ...lanes]
      const inWindow = (b: Booking) => b.checkIn < to && b.checkOut > from
      return {
        from,
        to,
        days: dayList,
        rows,
        today: today(),
        sources,
        stays: w.views.filter((b) => units.some((u) => u.id === b.unitId) && occupies(b) && inWindow(b)).sort((a, b) => a.checkIn.localeCompare(b.checkIn)),
        blocks: w.blocks.filter((k) => rows.some((r) => r.place.unit.id === k.unitId) && k.from < to && k.to > from).map((k): BlockView => ({ ...k, place: w.cat.place(k.unitId) })),
      }
    },
  }

  function guestRows(w: Awaited<ReturnType<typeof bookingWorld>>): GuestRow[] {
    return w.guests.map((g) => {
      const mine = w.views.filter((b) => b.guestId === g.id && b.status !== 'cancelled' && b.status !== 'draft' && b.status !== 'no_show')
      const done = mine.filter((b) => b.status === 'checked_out' || b.status === 'checked_in')
      return {
        ...g,
        stays: mine.length,
        nights: sum(done.map((b) => b.nights)),
        spent: sum(done.map((b) => b.total)),
        lastStay: done.map((b) => b.checkIn).sort().at(-1) ?? null,
        inHouse: mine.some((b) => b.status === 'checked_in'),
      }
    })
  }

  const guest = {
    async list() {
      const w = await bookingWorld()
      return { guests: guestRows(w).sort((a, b) => (b.lastStay ?? '').localeCompare(a.lastStay ?? '') || a.name.localeCompare(b.name)) }
    },
    async detail(id: string) {
      const w = await bookingWorld()
      const row = guestRows(w).find((g) => g.id === id)
      if (!row) throw new NotFoundError('guest', id)
      const bookings = sortBookings(w.views.filter((b) => b.guestId === id), today())
      const requests = sortRequests((await serviceWorld()).views.filter((r) => bookings.some((b) => b.id === r.bookingId)))
      return { guest: row, bookings, requests }
    },
    async create(input: GuestInput) {
      check(validateGuest(input))
      return ports.guest.create(input)
    },
    async update(id: string, input: GuestInput) {
      check(validateGuest(input))
      return ports.guest.update(id, input)
    },
  }

  /** One petty cash box: balance against the float, who holds it, what it spent and when it was last counted. */
  async function pettyRow(w: Awaited<ReturnType<typeof financeWorld>>, accountId: string): Promise<PettyRow> {
    const [employees, reconciliations] = await Promise.all([ports.hr.employees(), ports.finance.reconciliations()])
    const account = findById(w.accounts, accountId, 'account')
    const mine = w.views.filter((t) => t.accountId === accountId)
    const now = balance(account, w.transactions)
    const r = last30()
    return {
      account,
      villa: account.villaId ? w.cat.villa(account.villaId) : null,
      custodian: employees.find((e) => e.id === account.custodianId)?.name ?? 'Nobody',
      /** Where a top-up comes from by default: the location's cashbox, else the bank. */
      source: w.accounts.find((a) => a.kind === 'cashbox' && a.locationId === account.locationId) ?? w.accounts.find((a) => a.kind === 'bank') ?? null,
      balance: now,
      low: pettyLow(account, now),
      topUp: pettyTopUp(account, now),
      spent30: sum(mine.filter((t) => t.kind === 'cash_out' && t.origin !== 'transfer' && counts(t) && t.date >= r.from && t.date < r.to).map((t) => t.amount)),
      pendingSpend: sum(mine.filter((t) => t.kind === 'cash_out' && awaitsApproval(t)).map((t) => t.amount)),
      topUpPending: mine.some((t) => t.kind === 'cash_in' && t.origin === 'transfer' && awaitsApproval(t)),
      lastCount: reconciliations.filter((x) => x.accountId === accountId).sort((a, b) => b.date.localeCompare(a.date))[0] ?? null,
    }
  }

  const finance = {
    async overview() {
      const w = await financeWorld()
      const r = last30()
      const prev = { from: addDays(r.from, -30), to: r.from }
      const accounts = w.accounts.map((a) => {
        const mine = w.views.filter((t) => t.accountId === a.id && counts(t)).sort((x, y) => y.date.localeCompare(x.date))
        return { account: a, balance: balance(a, w.transactions), location: a.locationId ? w.cat.location(a.locationId) : null, lastMovement: mine[0] ?? null, in30: cashSummary(mine, r.from, r.to) }
      })
      const pending = w.views.filter(awaitsApproval).sort((a, b) => a.date.localeCompare(b.date))
      return {
        accounts,
        locations: w.cat.locations,
        total: sum(accounts.map((a) => a.balance)),
        summary: cashSummary(w.views, r.from, r.to),
        previous: cashSummary(w.views, prev.from, prev.to),
        pending,
        rejected: w.views.filter((t) => t.status === 'rejected').length,
        drafts: w.views.filter((t) => t.status === 'draft').length,
        recent: [...w.views].sort((a, b) => b.date.localeCompare(a.date) || b.number.localeCompare(a.number)).slice(0, 8),
      }
    },

    async account(id: string) {
      const [w, reconciliations] = await Promise.all([financeWorld(), ports.finance.reconciliations()])
      const account = findById(w.accounts, id, 'account')
      const mine = w.views.filter((t) => t.accountId === id).sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number))
      let running = account.openingBalance
      const ledger = mine.map((t) => {
        if (counts(t)) running += signed(t)
        return { ...t, running }
      })
      return {
        account,
        location: account.locationId ? w.cat.location(account.locationId) : null,
        locations: w.cat.locations,
        accounts: w.accounts,
        balance: running,
        petty: account.kind === 'petty' ? await pettyRow(w, account.id) : null,
        ledger: ledger.reverse(),
        reconciliations: reconciliations.filter((r) => r.accountId === id).sort((a, b) => b.date.localeCompare(a.date)),
        today: today(),
      }
    },

    /** Villas and staff for the account form: petty cash belongs to a villa and one person holds it. */
    async accountFormOptions() {
      const [cat, employees] = await Promise.all([catalog(), ports.hr.employees()])
      const villaIds = new Set(cat.villas.map((v) => v.id))
      return { villas: cat.villas, employees: employees.filter((e) => e.status === 'active' && villaIdsOf(e).some((id) => villaIds.has(id))).map((e) => ({ id: e.id, name: e.name, villaIds: villaIdsOf(e) })) }
    },
    /** Every villa's petty cash with its float, custodian, balance and last count. */
    async pettyCash() {
      const w = await financeWorld()
      const rows = await Promise.all(w.accounts.filter((a) => a.kind === 'petty').map((a) => pettyRow(w, a.id)))
      return { rows, today: today(), low: rows.filter((r) => r.low).length, total: sum(rows.map((r) => r.balance)), float: sum(rows.map((r) => r.account.floatLimit ?? 0)) }
    },

    async transactions() {
      const w = await financeWorld()
      const list = [...w.views].sort((a, b) => b.date.localeCompare(a.date) || b.number.localeCompare(a.number))
      const statuses: Array<TransactionStatus | 'all'> = ['all', 'draft', 'submitted', 'approved', 'posted', 'rejected', 'reversed']
      const counted = Object.fromEntries(statuses.map((s) => [s, s === 'all' ? list.length : list.filter((t) => t.status === s).length]))
      return { list, counts: counted as Record<string, number>, categories: w.categories, accounts: w.accounts }
    },

    /** The approval inbox: what the signed-in person can act on, and the rest of the queue. */
    async inbox() {
      const [w, a, journals] = await Promise.all([financeWorld(), access(), accounting.approvalQueue()])
      const queue = w.views.filter(awaitsApproval).sort((x, y) => x.date.localeCompare(y.date))
      const canAct = (t: TransactionView) => (t.status === 'submitted' ? t.nextApprover !== null && canSignLevel(a.user.role, t.nextApprover) && t.createdById !== a.user.id : a.can('finance', 'post'))
      return { mine: queue.filter(canAct), others: queue.filter((t) => !canAct(t)), rejected: w.views.filter((t) => t.status === 'rejected'), journals, role: a.user.role, userId: a.user.id, rules: w.rules }
    },

    async transaction(id: string) {
      const [w, b, paymentList, workOrders, requests, periods, orderList] = await Promise.all([financeWorld(), bookingWorld(), ports.payment.payments(), ports.maintenance.workOrders(), ports.service.requests(), ports.payroll.periods(), ports.orders.orders()])
      const t = w.describe(findById(w.transactions, id, 'transaction'))
      const payment = paymentList.find((p) => p.transactionId === id || p.feeTransactionId === id || p.extraTransactionIds?.includes(id))
      const order = orderList.find((o) => o.costTransactionIds.includes(id) || (payment?.orderIds ?? []).includes(o.id))
      const workOrder = workOrders.find((o) => o.expenses.some((e) => e.transactionId === id))
      const request = requests.find((r) => r.transactionId === id)
      const period = periods.find((p) => p.transactionId === id)
      const link = (ref: string | null) => (ref ? w.describe(findById(w.transactions, ref, 'transaction')) : null)
      const a = await access()
      const progress = approvalProgress(t.levels, t.approvals)
      return {
        transaction: t,
        steps: transactionSteps(t, shortDay),
        progress,
        rule: matchRule(w.rules, t),
        canSign: t.status === 'submitted' && progress.next !== null && canSignLevel(a.user.role, progress.next) && t.createdById !== a.user.id,
        canPost: t.status === 'approved' && a.can('finance', 'post'),
        canReject: t.status === 'submitted' && t.createdById !== a.user.id && a.can('approval', 'approve'),
        reversal: link(t.reversedBy),
        original: link(t.reversalOf),
        twin: t.transferId ? (w.views.find((o) => o.transferId === t.transferId && o.id !== t.id) ?? null) : null,
        booking: t.bookingId ? (b.views.find((o) => o.id === t.bookingId) ?? null) : null,
        /** Where the entry came from, so the page links back to it. */
        source: {
          payment: payment ? { id: payment.id, number: payment.number, kind: payment.kind, fee: payment.feeTransactionId === id } : null,
          workOrder: workOrder ? { id: workOrder.id, number: workOrder.number, title: workOrder.title } : null,
          request: request ? { id: request.id, number: request.number } : null,
          order: order ? { id: order.id, number: order.number } : null,
          payroll: period ? { id: period.id, month: period.month } : null,
        },
      }
    },

    async formOptions() {
      const [w, b] = await Promise.all([financeWorld(), bookingWorld()])
      const now = today()
      return {
        accounts: w.accounts,
        proof: await ports.finance.proofPolicy(),
        categories: w.categories.filter((c) => c.active),
        catalog: w.cat,
        rules: w.rules,
        bookings: b.views.filter((o) => o.status === 'confirmed' || o.status === 'checked_in' || (o.status === 'checked_out' && o.checkOut >= addDays(now, -14))),
        today: now,
      }
    },

    async createAccount(input: CashAccountInput) {
      await allow('master', 'create')
      check(validateAccount(input, await ports.finance.accounts()))
      return ports.finance.createAccount(input)
    },
    async updateAccount(id: string, input: CashAccountInput) {
      await allow('master', 'edit')
      check(validateAccount(input, await ports.finance.accounts(), id))
      return ports.finance.updateAccount(id, input)
    },

    async createTransaction(input: TransactionInput, submit: boolean) {
      await allow('finance', submit ? 'submit' : 'create')
      check(validateTransaction(input, await ports.finance.categories()))
      const [policy, accounts] = await Promise.all([ports.finance.proofPolicy(), ports.finance.accounts()])
      const petty = accounts.find((a) => a.id === input.accountId)?.kind === 'petty'
      if (submit && needsProof({ ...input, origin: 'manual' }, policy, petty))
        throw new ValidationError({ attachments: petty ? 'Attach the receipt: every petty cash spend needs one.' : `Attach the receipt or invoice: cash-outs from ${policy.threshold.toLocaleString('id-ID')} need proof before approval.` })
      const t = await ports.finance.createTransaction(input, submit)
      return (await financeWorld()).describe(t)
    },
    async transition(id: string, to: TransactionAction, note = '') {
      if (!(await financeWorld()).transactions.some((t) => t.id === id)) throw new RuleError('FORBIDDEN', 'This entry belongs to a villa outside your access.')
      if (to === 'approved' || to === 'rejected') await allow('approval', 'approve')
      if (to === 'posted') await allow('finance', 'post')
      if (to === 'submitted') await allow('finance', 'submit')
      if (to === 'rejected' && note.trim().length < 3) throw new ValidationError({ note: 'Say why the entry is rejected.' })
      const t = await ports.finance.transition(id, to, note.trim())
      return (await financeWorld()).describe(t)
    },
    async reverse(id: string, reason: string) {
      await allow('finance', 'post')
      if (reason.trim().length < 3) throw new ValidationError({ reason: 'Say why the entry is reversed.' })
      const t = await ports.finance.reverse(id, reason.trim())
      return (await financeWorld()).describe(t)
    },
    async transfer(input: CashTransferInput) {
      await allow('finance', 'submit')
      check(validateTransfer(input, await ports.finance.accounts()))
      return (await financeWorld()).describe(await ports.finance.transfer(input))
    },
    async adjust(input: AdjustmentInput) {
      await allow('finance', 'submit')
      check(validateAdjustment(input, await ports.finance.accounts()))
      return (await financeWorld()).describe(await ports.finance.adjust(input))
    },
    async reconcile(input: ReconciliationInput) {
      await allow('finance', 'submit')
      check(validateReconciliation(input, await ports.finance.accounts()))
      return ports.finance.reconcile(input)
    },

    async categories() {
      const w = await financeWorld()
      const r = last30()
      return {
        catalog: w.cat,
        categories: w.categories.map((c) => {
          const mine = w.views.filter((t) => t.categoryId === c.id && counts(t) && t.date >= r.from && t.date < r.to && !t.reversalOf)
          return { ...c, count30: mine.length, total30: sum(mine.map((t) => t.amount)), villaNames: c.villaIds.map((id) => w.cat.villas.find((v) => v.id === id)?.name ?? id).join(', ') }
        }),
      }
    },
    async createCategory(input: CategoryInput) {
      await allow('master', 'create')
      if (input.name.trim().length < 2) throw new ValidationError({ name: 'Enter the category name.' })
      const existing = await ports.finance.categories()
      if (existing.some((c) => c.name.toLowerCase() === input.name.trim().toLowerCase() && c.kind === input.kind)) throw new ValidationError({ name: `${input.name.trim()} already exists.` })
      return ports.finance.createCategory({ ...input, name: input.name.trim() })
    },
    async updateCategory(id: string, input: CategoryInput) {
      await allow('master', 'edit')
      if (input.name.trim().length < 2) throw new ValidationError({ name: 'Enter the category name.' })
      return ports.finance.updateCategory(id, { ...input, name: input.name.trim() })
    },
    setCategoryActive: (id: string, active: boolean) => ports.finance.setCategoryActive(id, active),

    async rules() {
      const [w, rules] = await Promise.all([catalog(), ports.finance.approvalRules()])
      return { rules: rules.map((r) => ({ ...r, villaName: r.villaId ? (w.villas.find((v) => v.id === r.villaId)?.name ?? r.villaId) : 'Every villa' })), catalog: w }
    },
    async createRule(input: ApprovalRuleInput) {
      await allow('approval', 'create')
      check(validateApprovalRule(input))
      return ports.finance.createRule(input)
    },
    async updateRule(id: string, input: ApprovalRuleInput) {
      await allow('approval', 'edit')
      check(validateApprovalRule(input))
      return ports.finance.updateRule(id, input)
    },
    async deleteRule(id: string) {
      await allow('approval', 'edit')
      return ports.finance.deleteRule(id)
    },
    async attach(id: string, files: readonly Attachment[]) {
      await allow('finance', 'create')
      return (await financeWorld()).describe(await ports.finance.attach(id, files))
    },
    async detach(id: string, attachmentId: string) {
      await allow('finance', 'create')
      return (await financeWorld()).describe(await ports.finance.detach(id, attachmentId))
    },
    proofPolicy: () => ports.finance.proofPolicy(),
    async saveProofPolicy(policy: ProofPolicy) {
      await allow('finance', 'edit')
      check(validateProofPolicy(policy))
      return ports.finance.saveProofPolicy(policy)
    },
  }

  /** Receipts, invoices and photos; staff upload signed in, the guest through submitProof. */
  const files = {
    async upload(file: UploadFile) {
      await me()
      return ports.files.upload(file)
    },
  }

  const service = {
    async list() {
      const w = await serviceWorld()
      const now = today()
      const list = sortRequests(w.views)
      return {
        today: now,
        list,
        open: list.filter((r) => r.status === 'open').length,
        inProgress: list.filter((r) => r.status === 'in_progress').length,
        doneToday: list.filter((r) => r.status === 'done' && r.doneOn === now).length,
        urgent: list.filter((r) => r.priority === 'urgent' && (r.status === 'open' || r.status === 'in_progress')).length,
        chargesOpen: list.filter((r) => r.charge > 0 && r.status !== 'cancelled' && !r.transactionId).reduce((s, r) => s + r.charge, 0),
      }
    },
    async detail(id: string) {
      const w = await serviceWorld()
      const r = w.describeRequest(findById(w.requests, id, 'request'))
      return { request: r, today: today(), cashbox: (await ports.finance.accounts()).find((a) => a.kind === 'cashbox' && a.locationId === r.place.location.id) ?? null }
    },
    async formOptions() {
      const w = await bookingWorld()
      return { catalog: w.cat, inHouse: inHouse(w.views), today: today() }
    },
    async create(input: ServiceRequestInput) {
      check(validateServiceRequest(input))
      const r = await ports.service.create(input)
      return (await serviceWorld()).describeRequest(r)
    },
    async update(id: string, input: ServiceRequestInput) {
      check(validateServiceRequest(input))
      return (await serviceWorld()).describeRequest(await ports.service.update(id, input))
    },
    async transition(id: string, to: Exclude<ServiceStatus, 'open'>) {
      const r = await ports.service.transition(id, to)
      return (await serviceWorld()).describeRequest(r)
    },
    async assign(id: string, assignee: string) {
      if (assignee.trim().length < 2) throw new ValidationError({ assignee: 'Enter who takes it.' })
      return (await serviceWorld()).describeRequest(await ports.service.assign(id, assignee))
    },
    /** Books the charge as a submitted cash-in on the location's cashbox and links it to the request. */
    async recordCharge(id: string) {
      const w = await serviceWorld()
      const r = w.describeRequest(findById(w.requests, id, 'request'))
      if (r.charge <= 0) throw new ValidationError({ charge: 'This request has no charge.' })
      if (r.transactionId) throw new ValidationError({ charge: 'The charge is already recorded.' })
      const accounts = await ports.finance.accounts()
      const cashbox = accounts.find((a) => a.kind === 'cashbox' && a.locationId === r.place.location.id) ?? accounts[0]
      if (!cashbox) throw new ValidationError({ charge: 'No cashbox to record the charge in.' })
      const t = await ports.finance.createTransaction(
        { accountId: cashbox.id, kind: 'cash_in', categoryId: 'cat-extra', amount: r.charge, date: today(), locationId: r.place.location.id, villaId: r.place.villa.id, unitId: r.unitId, bookingId: r.bookingId, description: `${r.number} ${r.note || r.kind}${r.guestName ? `, ${r.guestName}` : ''}`, reference: r.number, attachments: [] },
        true,
        'front_desk',
      )
      return (await serviceWorld()).describeRequest(await ports.service.linkTransaction(id, t.id))
    },
    filter: filterRequests,
  }

  /** Room service: the menu, orders from staff and guests, delivery, and the bill settled into finance. */
  const orders = {
    async board() {
      const ow = await orderWorld()
      const now = today()
      const live = ow.views.filter(isOpenOrder)
      const billed = ow.views.filter((o) => o.payState === 'unpaid' || o.payState === 'pending')
      return {
        today: now,
        list: ow.views,
        open: live.length,
        waiting: ow.views.filter((o) => o.status === 'new').length,
        late: live.filter((o) => o.late).length,
        deliveredToday: ow.views.filter((o) => o.deliveredOn === now).length,
        salesToday: sum(ow.views.filter((o) => o.deliveredOn === now).map((o) => o.totals.charge)),
        unpaid: sum(billed.map((o) => o.totals.charge)),
        unpaidCount: billed.length,
      }
    },
    async detail(id: string) {
      const [ow, fin, a, links] = await Promise.all([orderWorld(), financeWorld(), access(), ports.payment.links()])
      const o = ow.describe(findById(ow.orders, id, 'order'))
      const payment = o.paymentId ? (ow.payments.find((p) => p.id === o.paymentId) ?? null) : null
      const entry = (ref: string | null | undefined) => (ref ? (fin.views.find((t) => t.id === ref) ?? null) : null)
      const revenue = payment ? [payment.transactionId, ...(payment.extraTransactionIds ?? []), payment.feeTransactionId].map(entry).filter((t): t is TransactionView => t !== null) : []
      const costs = o.costTransactionIds.map(entry).filter((t): t is TransactionView => t !== null)
      const firstIncome = revenue.find((t) => t.kind === 'cash_in') ?? null
      return {
        order: o,
        booking: ow.w.describe(findById(ow.w.bookings, o.bookingId, 'booking')),
        payment,
        link: payment ? (links.find((l) => l.paymentId === payment.id) ?? null) : null,
        revenue,
        costs,
        partners: ow.partners.filter((p) => o.lines.some((l) => l.partnerId === p.id)),
        steps: orderFlow(o, firstIncome),
        today: today(),
        canEdit: a.can('services', 'edit'),
        canPay: a.can('payments', 'create'),
        /** A delivery voids only on the business day it happened. */
        businessDate: await ports.audit.businessDate(),
      }
    },
    async menu() {
      const [ow, a, journals] = await Promise.all([orderWorld(), access(), ports.ledger.journals()])
      const rank = (i: MenuItem) => MENU_CATEGORIES.indexOf(i.category)
      // What the books owe each partner, shown to those who may see the books.
      const owed = a.can('finance', 'view') ? partyBalances(journals, GL.partnerPayable, 'partnerId') : null
      const partners = ow.partners.map((p) => {
        const m = owed?.get(p.id)
        return { ...p, owed: owed ? (m ? m.credit - m.debit : 0) : null }
      })
      return { items: ow.menu.map(ow.describeItem).sort((x, y) => x.villaName.localeCompare(y.villaName) || rank(x) - rank(y) || x.name.localeCompare(y.name)), partners, catalog: ow.w.cat, canEdit: a.can('services', 'catalog') }
    },
    async saveItem(id: string | null, input: MenuItemInput) {
      await allow('services', 'catalog')
      check(validateMenuItem(input))
      return id ? ports.orders.updateItem(id, input) : ports.orders.createItem(input)
    },
    async savePartner(id: string | null, input: PartnerInput) {
      await allow('services', 'catalog')
      check(validatePartner(input))
      return id ? ports.orders.updatePartner(id, input) : ports.orders.createPartner(input)
    },
    async formOptions() {
      const [ow, a, policy] = await Promise.all([orderWorld(), access(), ports.payment.policy()])
      const now = today()
      return {
        stays: ow.w.views.filter((b) => orderableStay(b, now)).sort((x, y) => Number(y.status === 'checked_in') - Number(x.status === 'checked_in') || x.unitCode.localeCompare(y.unitCode)),
        menu: ow.menu.filter((i) => i.active).map(ow.describeItem),
        today: now,
        canComp: a.can('services', 'comp'),
        canDiscountPast: a.can('booking', 'approve'),
        discountLimitPct: policy.discountLimitPct,
      }
    },
    async place(input: OrderInput) {
      await allow('services', 'create')
      check(validateOrder(input))
      return (await orderWorld()).describe(await ports.orders.place(input))
    },
    async transition(id: string, to: OrderAction, note = '') {
      await allow('services', 'edit')
      if (to === 'cancelled' && note.trim().length < 3) throw new ValidationError({ note: 'Say why the order is cancelled.' })
      if (to === 'voided' && note.trim().length < 3) throw new ValidationError({ note: 'Say why the delivery is voided.' })
      return (await orderWorld()).describe(await ports.orders.transition(id, to, note))
    },
    async assign(id: string, assignee: string) {
      await allow('services', 'edit')
      if (assignee.trim().length < 2) throw new ValidationError({ assignee: 'Enter who takes it.' })
      return (await orderWorld()).describe(await ports.orders.assign(id, assignee))
    },
    /** A stay's room service: its orders and what is still owed. */
    async forStay(bookingId: string) {
      const [ow, links] = await Promise.all([orderWorld(), ports.payment.links()])
      const mine = ow.orders.filter((o) => o.bookingId === bookingId)
      const bill = folio(mine, ow.payments)
      const asked = new Set(mine.map((o) => o.paymentId))
      return { orders: sortOrders(mine.map(ow.describe)), charged: bill.charged, paid: bill.paid, pending: bill.pending, outstanding: bill.outstanding, links: links.filter((l) => l.status === 'pending' && asked.has(l.paymentId)) }
    },
    /** Takes the money for delivered orders: cash and transfer at once, QRIS, VA and card through a link. */
    async pay(input: { bookingId: string; orderIds: readonly string[]; method: PaymentMethod; reference: string; attachments?: readonly Attachment[] }) {
      await allow('payments', 'create')
      if (input.orderIds.length === 0) throw new ValidationError({ orderIds: 'Pick the orders to pay.' })
      const ow = await orderWorld()
      const list = input.orderIds.map((id) => ow.describe(findById(ow.orders, id, 'order')))
      const b = ow.w.describe(findById(ow.w.bookings, input.bookingId, 'booking'))
      // What each order still asks, its charge less any rebate, read from the folio.
      const due = (await booking.folio(b.id)).folio.due.orders
      const amount = sum(list.map((o) => due.find((d) => d.orderId === o.id)?.amount ?? o.totals.charge))
      if (isGateway(input.method)) return { link: await ports.payment.createLink({ bookingId: b.id, kind: 'extra', method: input.method, amount, payer: b.guestName, orderIds: input.orderIds }), payment: null }
      if (input.method === 'bank_transfer' && input.reference.trim().length < 3) throw new ValidationError({ reference: 'Enter the bank reference.' })
      const payment = await ports.payment.record({ bookingId: b.id, kind: 'extra', method: input.method, amount, reference: input.reference, payer: b.guestName, note: `Room service ${list.map((o) => o.number).join(', ')}`, attachments: input.attachments ?? [], orderIds: input.orderIds })
      return { payment, link: null }
    },
    /** One QR card per room; the code opens that room's menu for whoever is staying. */
    async qrCards() {
      const cat = await catalog()
      return { cards: cat.units.filter((u) => u.status !== 'inactive').map((u) => ({ unit: u, villa: cat.villa(u.villaId), token: orderTokenFor(u.code) })), catalog: cat }
    },
    /** Public: the guest's menu page, no session. */
    guestMenu: (token: string) => ports.orders.guestMenu(token),
    async guestPlace(token: string, input: GuestOrderInput) {
      check(validateOrder(input))
      return ports.orders.guestPlace(token, input)
    },
    guestPay: (token: string) => ports.orders.guestPay(token),
    filter: filterOrders,
  }

  /** A vendor line without a typed payee is paid to the vendor. */
  async function withPayee(input: ExpenseInput): Promise<ExpenseInput> {
    if (input.payee.trim() || !input.vendorId) return input
    return { ...input, payee: (await ports.maintenance.vendors()).find((v) => v.id === input.vendorId)?.name ?? '' }
  }

  /** Money on a stay that ended early: pending links close, and the policy's refund goes back newest payment first. */
  async function settleEnding(inv: InvoiceView, outcome: 'cancelled' | 'no_show') {
    for (const l of inv.links.filter((x) => x.status === 'pending')) await ports.payment.cancelLink(l.token)
    if (inv.booking.source !== 'direct') return
    const terms = cancellationTerms(inv.paid, inv.expected, inv.booking.checkIn, today(), await ports.payment.policy(), outcome)
    let left = terms.refund
    const paidIn = inv.payments.filter((p) => p.kind !== 'refund' && (p.status === 'paid' || p.status === 'refunded')).reverse()
    for (const p of paidIn) {
      if (left <= 0) break
      const back = Math.min(left, p.amount - sum(inv.payments.filter((r) => r.refundOf === p.id && r.status === 'paid').map((r) => r.amount)))
      if (back <= 0) continue
      await ports.payment.refund(p.id, back, `${inv.booking.code} cancelled; ${terms.retained > 0 ? 'deposit kept, the rest returned' : 'cancelled in time for a full refund'}`, [])
      left -= back
    }
  }

  /** Guest payments: taken at the desk, by transfer, through a gateway link, or paid out by Airbnb. */
  const payments = {
    async overview() {
      const pw = await paymentWorld()
      const now = today()
      const month = now.slice(0, 7)
      const paid = pw.payments.filter((p) => p.status === 'paid' || p.status === 'refunded')
      const inflow = paid.filter((p) => p.kind !== 'refund')
      const rows = pw.w.views.filter((b) => b.status !== 'draft' && b.status !== 'cancelled' && b.status !== 'no_show').map(pw.receivable).filter((r) => r.outstanding > 0)
      const weeks = Array.from({ length: 8 }, (_, i) => {
        const from = addDays(startOfWeek(now), (i - 7) * 7)
        return { key: from, label: shortDay(from), from, to: addDays(from, 7) }
      })
      const methods = PAYMENT_METHODS.filter((m) => inflow.some((p) => p.method === m))
      return {
        today: now,
        collectedMonth: sum(inflow.filter((p) => (p.paidOn ?? '').startsWith(month)).map((p) => p.amount)),
        refundsMonth: sum(pw.payments.filter((p) => p.kind === 'refund' && (p.paidOn ?? '').startsWith(month)).map((p) => p.amount)),
        outstanding: sum(rows.map((r) => r.outstanding)),
        overdue: rows.filter((r) => r.bucket !== 'not_due'),
        pendingLinks: pw.links.filter((l) => l.status === 'pending'),
        expiring: pw.links.filter((l) => l.status === 'pending').sort((x, y) => x.expiresAt.localeCompare(y.expiresAt)).slice(0, 6),
        weeks: weeks.map((wk) => ({ ...wk, byMethod: methods.map((m) => sum(inflow.filter((p) => p.method === m && p.paidOn !== null && p.paidOn >= wk.from && p.paidOn < wk.to).map((p) => p.amount))) })),
        methods,
        mix: methods.map((m) => ({ method: m, amount: sum(inflow.filter((p) => p.method === m && (p.paidOn ?? '') >= addDays(now, -29)).map((p) => p.amount)) })).filter((x) => x.amount > 0),
        aging: AGING_BUCKETS.map((bucket) => ({ bucket, amount: sum(rows.filter((r) => r.bucket === bucket).map((r) => r.outstanding)), count: rows.filter((r) => r.bucket === bucket).length })),
        recent: [...pw.payments].sort((x, y) => (y.paidOn ?? y.createdOn).localeCompare(x.paidOn ?? x.createdOn) || y.number.localeCompare(x.number)).slice(0, 8),
      }
    },
    async list() {
      const pw = await paymentWorld()
      return { list: [...pw.payments].sort((x, y) => (y.paidOn ?? y.createdOn).localeCompare(x.paidOn ?? x.createdOn) || y.number.localeCompare(x.number)), catalog: pw.w.cat, today: today() }
    },
    async receivables() {
      const pw = await paymentWorld()
      const rows = pw.w.views.filter((b) => b.source === 'direct' && (b.status === 'confirmed' || b.status === 'checked_in' || b.status === 'checked_out')).map(pw.receivable).filter((r) => r.outstanding > 0)
      const drafts = pw.w.views.filter((b) => b.status === 'draft' && b.source === 'direct' && daysBetween(b.createdOn, today()) >= pw.policy.autoCancelDays && netPaid(pw.payments, b.id) === 0)
      return { rows: rows.sort((x, y) => x.dueOn.localeCompare(y.dueOn)), drafts, catalog: pw.w.cat, policy: pw.policy, today: today() }
    },
    async payouts() {
      const pw = await paymentWorld()
      const rows = pw.w.views
        .filter((b) => b.source === 'airbnb' && b.status !== 'draft' && b.status !== 'cancelled' && b.checkIn <= addDays(today(), 14))
        .map((b) => {
          const r = pw.receivable(b)
          const received = pw.payments.filter((p) => p.bookingId === b.id && p.kind === 'payout' && p.status === 'paid')
          return { ...r, received: sum(received.map((p) => p.amount)), receivedOn: received.at(-1)?.paidOn ?? null }
        })
        .sort((x, y) => y.dueOn.localeCompare(x.dueOn))
      const byAccount = pw.w.accounts.map((a) => {
        const mine = rows.filter((r) => r.booking.airbnbAccountId === a.id)
        return { account: a, expected: sum(mine.map((r) => r.expected)), received: sum(mine.map((r) => r.received)), waiting: mine.filter((r) => r.outstanding > 0 && r.dueOn <= today()).length }
      })
      return { rows, byAccount, today: today() }
    },
    async invoice(bookingId: string): Promise<InvoiceView> {
      const [pw, sv, ow] = await Promise.all([paymentWorld(), serviceWorld(), orderWorld()])
      const b = pw.w.describe(findById(pw.w.bookings, bookingId, 'booking'))
      const room = b.unitAssigned ? `${b.unitCode} · ${b.place.unit.name}` : `${b.roomType ?? 'Room'} · room to be assigned`
      const lines: InvoiceLine[] = [
        b.rateOverride !== null
          ? { label: room, detail: `${b.nights} nights × ${b.rateOverride.toLocaleString('id-ID')}, staff rate (list ${b.price.list.toLocaleString('id-ID')})`, amount: b.price.subtotal }
          : { label: room, detail: `${b.nights} nights at the ${isChannel(b) ? 'channel' : 'Airbnb listing'} price`, amount: b.price.list },
      ]
      if (b.price.discount > 0 && b.discount) lines.push({ label: 'Discount', detail: b.discount.reason, amount: -b.price.discount })
      if (b.source === 'airbnb') lines.push({ label: 'Airbnb host fee', detail: 'Kept by Airbnb from the payout', amount: -b.airbnbFee })
      for (const r of sv.views.filter((x) => x.bookingId === bookingId && x.charge > 0 && x.status !== 'cancelled')) lines.push({ label: `Room service ${r.number}`, detail: r.note || r.kind, amount: r.charge, separate: true })
      const served = ow.orders.filter((o) => o.bookingId === bookingId)
      for (const o of served.filter((x) => x.status === 'delivered')) {
        const t = orderTotals(o)
        if (t.gross > 0) lines.push({ label: `Room service ${o.number}`, detail: `${o.lines.map((l) => `${l.quantity} × ${l.name}${l.comp ? ' (on the house)' : ''}`).join(', ')}${t.discount > 0 ? `, ${o.discountPct}% off` : ''}`, amount: t.charge, separate: true })
      }
      if (b.departure && b.departure.extraCharges > 0) lines.push({ label: 'Departure charges', detail: b.departure.notes || 'Charged at check-out', amount: b.departure.extraCharges, separate: true })
      const r = pw.receivable(b)
      const bill = folio(served, ow.payments)
      return { booking: b, lines, total: b.total, expected: r.expected, paid: r.paid, outstanding: r.outstanding, overpaid: Math.max(0, r.paid - r.expected), dueOn: r.dueOn, payments: pw.payments.filter((p) => p.bookingId === bookingId).sort((x, y) => x.createdOn.localeCompare(y.createdOn) || x.number.localeCompare(y.number)), links: pw.links.filter((l) => l.bookingId === bookingId), roomService: { charged: bill.charged, paid: bill.paid, outstanding: bill.outstanding } }
    },
    policy: () => ports.payment.policy(),
    async savePolicy(policy: PaymentPolicy) {
      await allow('payments', 'edit')
      check(validatePolicy(policy))
      return ports.payment.savePolicy(policy)
    },
    async record(input: GuestPaymentInput) {
      await allow('payments', 'create')
      const inv = await payments.invoice(input.bookingId)
      check(validatePaymentInput(input, inv.outstanding, inv.paid))
      return ports.payment.record(input)
    },
    async createLink(input: NewPaymentLink) {
      await allow('payments', 'create')
      const inv = await payments.invoice(input.bookingId)
      check(validatePaymentInput({ ...input, reference: '', note: '' }, inv.outstanding, inv.paid))
      return ports.payment.createLink(input)
    },
    async cancelLink(token: string) {
      await allow('payments', 'create')
      return ports.payment.cancelLink(token)
    },
    async refund(paymentId: string, amount: number, reason: string, attachments: readonly Attachment[] = []) {
      await allow('payments', 'edit')
      if (reason.trim().length < 3) throw new ValidationError({ note: 'Say why the money goes back.' })
      if (!Number.isInteger(amount) || amount <= 0) throw new ValidationError({ amount: 'Enter a whole rupiah amount above zero.' })
      return ports.payment.refund(paymentId, amount, reason, attachments)
    },
    /** Public: no session needed, the guest opens this. */
    checkout: (token: string) => ports.payment.checkout(token),
    /** Public and demo-only: stands in for the gateway's callback. */
    settle: (token: string, outcome: 'paid' | 'failed') => ports.payment.settle(token, outcome),
    /** Public: the guest uploads a transfer receipt; it lands on the cash-in once the payment clears. */
    async submitProof(token: string, file: UploadFile) {
      return ports.payment.submitProof(token, await ports.files.upload(file))
    },
    filter: filterPayments,
  }

  const groups = createGroupServices({ ports, today, allow, access, world: bookingWorld, booking, payments, check })

  const maintenance = {
    async overview() {
      const m = await maintenanceWorld()
      const now = today()
      const month = now.slice(0, 7)
      const open = m.views.filter(isOpenWorkOrder)
      const weeks = Array.from({ length: 8 }, (_, i) => {
        const from = addDays(startOfWeek(now), (i - 7) * 7)
        const to = addDays(from, 7)
        return { key: from, label: shortDay(from), opened: m.views.filter((w) => w.createdOn >= from && w.createdOn < to).length, closed: m.views.filter((w) => w.finishedOn && w.finishedOn >= from && w.finishedOn < to).length }
      })
      const closedThisMonth = m.views.filter((w) => isClosedWorkOrder(w) && (w.finishedOn ?? '').startsWith(month))
      return {
        today: now,
        open: open.length,
        urgent: open.filter((w) => w.priority === 'urgent' || w.priority === 'high'),
        late: open.filter((w) => w.late),
        overduePlans: m.plans.filter((p) => p.state === 'overdue'),
        duePlans: m.plans.filter((p) => p.state === 'due'),
        notReady: m.board.filter((r) => r.state !== 'ready' && r.place.unit.status !== 'inactive'),
        notReadyArrivals: m.board.filter((r) => r.arrival && r.state !== 'ready'),
        costMonth: sum(closedThisMonth.map((w) => w.total)),
        byStatus: (['open', 'scheduled', 'in_progress', 'on_hold', 'done', 'verified', 'cancelled'] as WorkOrderStatus[]).map((status) => ({ status, count: m.views.filter((w) => w.status === status).length })),
        costByVilla: m.cat.villas.map((v) => ({ villa: v, cost: sum(m.views.filter((w) => w.villaId === v.id && w.status !== 'cancelled' && w.createdOn >= addDays(now, -59)).map((w) => w.total)) })),
        weeks,
        blockedUnits: m.board.filter((r) => r.blockingWorkOrder).length,
      }
    },
    async workOrders() {
      const m = await maintenanceWorld()
      return { list: m.views, catalog: m.cat, vendors: m.vendors, employees: m.employees, assets: m.assets, today: today() }
    },
    filter: filterWorkOrders,
    async workOrder(id: string) {
      const [m, a] = await Promise.all([maintenanceWorld(), access()])
      const wo = m.views.find((w) => w.id === id)
      if (!wo) throw new NotFoundError('work order', id)
      const fin = await financeWorld()
      const expenses = wo.expenses.map((e) => ({ ...e, entry: fin.views.find((t) => t.id === e.transactionId) ?? null }))
      return {
        workOrder: wo,
        steps: workOrderSteps(wo, shortDay),
        asset: m.assets.find((x) => x.id === wo.assetId) ?? null,
        plan: m.plans.find((p) => p.id === wo.planId) ?? null,
        block: wo.blockId ? (m.blocks.find((k) => k.id === wo.blockId) ?? null) : null,
        expenses,
        catalog: m.cat,
        assets: m.assets,
        vendors: m.vendors,
        employees: m.employees,
        today: today(),
        canEdit: a.can('maintenance', 'edit'),
        canVerify: a.can('maintenance', 'approve'),
        canAddExpense: a.can('maintenance', 'submit') && canAddExpense(wo),
      }
    },
    async formOptions() {
      const m = await maintenanceWorld()
      return { catalog: m.cat, assets: m.assets, vendors: m.vendors.filter((v) => v.active), employees: m.employees, today: today() }
    },
    async createWorkOrder(input: NewWorkOrder) {
      await allow('maintenance', 'create')
      check(validateWorkOrder(input))
      return (await maintenanceWorld()).describe(await ports.maintenance.createWorkOrder(input))
    },
    async updateWorkOrder(id: string, input: WorkOrderInput) {
      await allow('maintenance', 'edit')
      check(validateWorkOrder(input))
      return (await maintenanceWorld()).describe(await ports.maintenance.updateWorkOrder(id, input))
    },
    async transition(id: string, to: Exclude<WorkOrderStatus, 'open'>, note = '') {
      await allow('maintenance', to === 'verified' ? 'approve' : 'edit')
      if ((to === 'on_hold' || to === 'cancelled') && note.trim().length < 3) throw new ValidationError({ note: 'Say why.' })
      return (await maintenanceWorld()).describe(await ports.maintenance.transitionWorkOrder(id, to, note))
    },
    async addNote(id: string, note: string) {
      await allow('maintenance', 'edit')
      if (note.trim().length < 2) throw new ValidationError({ note: 'Write the note.' })
      return ports.maintenance.addNote(id, note)
    },
    async setBlock(id: string, from: string | null, to: string | null) {
      await allow('maintenance', 'edit')
      if (from && to && to <= from) throw new ValidationError({ to: 'The end comes after the start.' })
      return ports.maintenance.setBlock(id, from, to)
    },
    /** Pays for part of the job: one submitted cash-out per line, through the normal approval chain. */
    async addExpense(id: string, input: ExpenseInput) {
      await allow('maintenance', 'submit')
      input = await withPayee(input)
      check(validateExpense(input))
      return (await maintenanceWorld()).describe(await ports.maintenance.addExpense(id, input))
    },
    async correctExpense(id: string, expenseId: string, input: ExpenseInput) {
      await allow('maintenance', 'submit')
      input = await withPayee(input)
      check(validateExpense(input))
      return (await maintenanceWorld()).describe(await ports.maintenance.correctExpense(id, expenseId, input))
    },
    async assets() {
      const m = await maintenanceWorld()
      return { assets: m.assets, catalog: m.cat, today: today() }
    },
    async asset(id: string) {
      const m = await maintenanceWorld()
      const asset = m.assets.find((a) => a.id === id)
      if (!asset) throw new NotFoundError('asset', id)
      return { asset, workOrders: m.views.filter((w) => w.assetId === id), plans: m.plans.filter((p) => p.assetId === id), catalog: m.cat, today: today() }
    },
    async createAsset(input: AssetInput) {
      await allow('maintenance', 'create')
      check(validateAsset(input, await ports.maintenance.assets()))
      return ports.maintenance.createAsset(input)
    },
    async updateAsset(id: string, input: AssetInput) {
      await allow('maintenance', 'edit')
      check(validateAsset(input, await ports.maintenance.assets(), id))
      return ports.maintenance.updateAsset(id, input)
    },
    async vendors() {
      const m = await maintenanceWorld()
      return { vendors: m.vendors, today: today() }
    },
    async vendor(id: string) {
      const m = await maintenanceWorld()
      const vendor = m.vendors.find((v) => v.id === id)
      if (!vendor) throw new NotFoundError('vendor', id)
      return { vendor, workOrders: m.views.filter((w) => w.vendorId === id), plans: m.plans.filter((p) => p.vendorId === id), today: today() }
    },
    async createVendor(input: VendorInput) {
      await allow('maintenance', 'create')
      check(validateVendor(input, await ports.maintenance.vendors()))
      return ports.maintenance.createVendor(input)
    },
    async updateVendor(id: string, input: VendorInput) {
      await allow('maintenance', 'edit')
      check(validateVendor(input, await ports.maintenance.vendors(), id))
      return ports.maintenance.updateVendor(id, input)
    },
    async plans() {
      const m = await maintenanceWorld()
      return { plans: [...m.plans].sort((a, b) => a.nextDue.localeCompare(b.nextDue)), catalog: m.cat, assets: m.assets, vendors: m.vendors, employees: m.employees, today: today() }
    },
    async createPlan(input: PlanInput) {
      await allow('maintenance', 'create')
      check(validatePlan(input))
      return ports.maintenance.createPlan(input)
    },
    async updatePlan(id: string, input: PlanInput) {
      await allow('maintenance', 'edit')
      check(validatePlan(input))
      return ports.maintenance.updatePlan(id, input)
    },
    async generateDue(horizonDays = 7) {
      await allow('maintenance', 'create')
      const created = await ports.maintenance.generateDue(horizonDays)
      const m = await maintenanceWorld()
      return created.map(m.describe)
    },
    async housekeeping() {
      const m = await maintenanceWorld()
      return { rows: m.board, catalog: m.cat, today: today(), items: INSPECTION_ITEMS }
    },
    async setHousekeeping(unitId: string, state: HousekeepingState, note = '') {
      await allow('maintenance', 'edit')
      return ports.maintenance.setHousekeeping(unitId, state, note)
    },
    async inspect(unitId: string, results: readonly InspectionResult[], raiseWorkOrder: boolean) {
      await allow('maintenance', 'edit')
      if (results.length === 0) throw new ValidationError({ results: 'Tick the checklist.' })
      return ports.maintenance.inspect(unitId, results, raiseWorkOrder)
    },
    /** My jobs on the phone: open work assigned to the signed-in employee, or every open job for a manager. */
    async myWork() {
      const [m, a] = await Promise.all([maintenanceWorld(), access()])
      const open = m.views.filter(isOpenWorkOrder)
      const mine = a.user.employeeId ? open.filter((w) => w.assigneeId === a.user.employeeId) : []
      return { mine, others: open.filter((w) => !mine.includes(w)), canEdit: a.can('maintenance', 'edit'), today: today() }
    },
    resolutionDays,
  }

  const hr = {
    /** Headcount, today's attendance and the pending queue, plus series for the range (default last 14 days) and villa. */
    async overview(f: { villaId?: string; from?: string; to?: string } = {}) {
      const w = await hrWorld()
      const now = today()
      const month = now.slice(0, 7)
      const from = f.from ?? addDays(now, -13)
      const to = f.to ?? now
      const staff = f.villaId ? w.views.filter((e) => villaIdsOf(e).includes(f.villaId as string)) : w.views
      const ids = new Set(staff.map((e) => e.id))
      const active = staff.filter((e) => e.status !== 'inactive')
      const todays = w.attendance.filter((a) => a.date === now && ids.has(a.employeeId))
      const inRange = w.attendance.filter((a) => ids.has(a.employeeId) && a.date >= from && a.date <= to)
      const overtimeInRange = w.overtime.filter((o) => ids.has(o.employeeId) && o.status === 'approved' && o.date >= from && o.date <= to)
      const leavesInRange = w.leaves.filter((l) => ids.has(l.employeeId) && l.from <= to && l.to >= from)
      return {
        today: now,
        from,
        to,
        catalog: w.cat,
        attendanceSeries: eachDay(from, addDays(to, 1)).map((date) => {
          const day = inRange.filter((a) => a.date === date)
          return { date, present: day.filter((a) => a.status === 'present').length, late: day.filter((a) => a.status === 'late').length, absent: day.filter((a) => a.status === 'absent').length, leave: day.filter((a) => a.status === 'leave').length }
        }),
        attendanceTotals: { present: inRange.filter((a) => a.status === 'present').length, late: inRange.filter((a) => a.status === 'late').length, absent: inRange.filter((a) => a.status === 'absent').length, leave: inRange.filter((a) => a.status === 'leave').length },
        overtimeByVilla: w.cat.villas.map((v) => ({ villa: v, hours: sum(overtimeInRange.filter((o) => o.villaId === v.id).map((o) => o.hours)) })).filter((r) => r.hours > 0),
        leaveByKind: leavesInRange.reduce<Record<string, number>>((acc, l) => ({ ...acc, [l.kind]: (acc[l.kind] ?? 0) + l.days }), {}),
        employees: active.length,
        probation: active.filter((e) => e.status === 'probation').length,
        presentToday: todays.filter((a) => a.status === 'present' || a.status === 'late').length,
        lateToday: todays.filter((a) => a.status === 'late').length,
        absentToday: todays.filter((a) => a.status === 'absent').length,
        onLeaveToday: todays.filter((a) => a.status === 'leave').length,
        pendingLeaves: w.leaves.filter((l) => l.status === 'pending' && ids.has(l.employeeId)),
        pendingOvertime: w.overtime.filter((o) => o.status === 'pending' && ids.has(o.employeeId)),
        pendingLoans: w.loans.filter((l) => l.status === 'pending' && ids.has(l.employeeId)),
        overtimeHoursMonth: sum(w.overtime.filter((o) => o.status === 'approved' && o.date.startsWith(month) && ids.has(o.employeeId)).map((o) => o.hours)),
        byDepartment: Object.entries(active.reduce<Record<string, number>>((acc, e) => ({ ...acc, [e.department]: (acc[e.department] ?? 0) + 1 }), {})).map(([department, count]) => ({ department, count })),
        byVilla: w.cat.villas.map((v) => ({ villa: v, count: active.filter((e) => villaIdsOf(e).includes(v.id)).length })).filter((r) => r.count > 0),
        payrollMonth: sum(active.map((e) => e.basicSalary + sum(e.allowances.map((a) => a.amount)))),
        recentLeaves: [...w.leaves].filter((l) => ids.has(l.employeeId)).sort((a, b) => b.requestedOn.localeCompare(a.requestedOn)).slice(0, 6),
      }
    },
    async employees() {
      const w = await hrWorld()
      return { employees: [...w.views].sort((a, b) => a.code.localeCompare(b.code)), catalog: w.cat, today: today() }
    },
    async employee(id: string) {
      const [w, periods, kpis] = await Promise.all([hrWorld(), ports.payroll.periods(), ports.people.kpis()])
      const e = w.views.find((x) => x.id === id)
      if (!e) throw new NotFoundError('employee', id)
      const now = today()
      const from = addDays(now, -29)
      const recent = w.attendance.filter((a) => a.employeeId === id && a.date >= from && a.date <= now).sort((a, b) => b.date.localeCompare(a.date))
      return {
        employee: e,
        catalog: w.cat,
        today: now,
        attendance: recent,
        attendanceSummary: {
          present: recent.filter((a) => a.status === 'present').length,
          late: recent.filter((a) => a.status === 'late').length,
          absent: recent.filter((a) => a.status === 'absent').length,
          leave: recent.filter((a) => a.status === 'leave').length,
          lateMinutes: sum(recent.map((a) => a.lateMinutes)),
        },
        roster: eachDay(startOfWeek(now), addDays(startOfWeek(now), 14)).map((date) => ({ date, assignment: w.assignments.find((a) => a.employeeId === id && a.date === date) ?? null, shift: (() => { const a = w.assignments.find((x) => x.employeeId === id && x.date === date); return a?.shiftId ? (w.shifts.find((s) => s.id === a.shiftId) ?? null) : null })() })),
        leaves: w.leaves.filter((l) => l.employeeId === id).sort((a, b) => b.from.localeCompare(a.from)),
        overtime: w.overtime.filter((o) => o.employeeId === id).sort((a, b) => b.date.localeCompare(a.date)),
        loans: w.loans.filter((l) => l.employeeId === id).sort((a, b) => b.requestedOn.localeCompare(a.requestedOn)),
        payslips: periods.filter((p) => p.lines.some((l) => l.employeeId === id)).sort((a, b) => b.month.localeCompare(a.month)).map((p) => ({ period: p, line: p.lines.find((l) => l.employeeId === id) })),
        kpis: kpis.filter((k) => k.employeeId === id).map((k): KpiView => ({ ...k, employeeName: e.name, score: kpiScore(k.items) })).sort((a, b) => b.period.localeCompare(a.period)),
        shifts: w.shifts,
      }
    },
    async createEmployee(input: EmployeeInput) {
      await allow('hr', 'create')
      check(validateEmployee(input, await ports.hr.employees()))
      return ports.hr.createEmployee(input)
    },
    async updateEmployee(id: string, input: EmployeeInput) {
      await allow('hr', 'edit')
      check(validateEmployee(input, await ports.hr.employees(), id))
      return ports.hr.updateEmployee(id, input)
    },
    /** Two weeks of shifts per employee from the Monday of `from`. */
    async roster(from: IsoDate, villaId?: string) {
      const w = await hrWorld()
      const start = startOfWeek(from)
      const days = eachDay(start, addDays(start, 14))
      const staff = w.views.filter((e) => e.status !== 'inactive' && (!villaId || villaIdsOf(e).includes(villaId)))
      return {
        start,
        days,
        shifts: w.shifts,
        catalog: w.cat,
        today: today(),
        rows: staff.map((e) => ({ employee: e, cells: days.map((date) => w.assignments.find((a) => a.employeeId === e.id && a.date === date) ?? null) })),
      }
    },
    async assignShift(input: ShiftAssignmentInput) {
      await allow('hr', 'edit')
      if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new ValidationError({ date: 'Pick the day.' })
      return ports.hr.assignShift(input)
    },
    async attendance() {
      const w = await hrWorld()
      return { rows: [...w.attendance].sort((a, b) => b.date.localeCompare(a.date) || a.employeeName.localeCompare(b.employeeName)), employees: w.views.filter((e) => e.status !== 'inactive'), shifts: w.shifts, catalog: w.cat, today: today() }
    },
    async recordAttendance(input: AttendanceInput) {
      await allow('hr', 'edit')
      check(validateAttendance(input))
      return ports.hr.recordAttendance(input)
    },
    async leaves() {
      const w = await hrWorld()
      return { rows: [...w.leaves].sort((a, b) => b.requestedOn.localeCompare(a.requestedOn) || b.number.localeCompare(a.number)), employees: w.views.filter((e) => e.status !== 'inactive'), today: today() }
    },
    async requestLeave(input: LeaveInput) {
      const [employees, leaves] = await Promise.all([ports.hr.employees(), ports.hr.leaves()])
      const e = employees.find((x) => x.id === input.employeeId)
      check(validateLeave(input, e, e ? leaveBalance(e, leaves, input.from.slice(0, 4)) : 0))
      return ports.hr.requestLeave(input)
    },
    async decideLeave(id: string, to: Decide, note: string) {
      if (to !== 'cancelled') await allow('hr', 'approve')
      if (to === 'rejected' && note.trim().length < 3) throw new ValidationError({ note: 'Say why.' })
      return ports.hr.decideLeave(id, to, note)
    },
    async overtime() {
      const w = await hrWorld()
      return { rows: [...w.overtime].sort((a, b) => b.date.localeCompare(a.date) || b.number.localeCompare(a.number)), employees: w.views.filter((e) => e.status !== 'inactive'), catalog: w.cat, today: today() }
    },
    async requestOvertime(input: OvertimeInput) {
      check(validateOvertime(input))
      return ports.hr.requestOvertime(input)
    },
    async decideOvertime(id: string, to: Decide, note: string) {
      if (to !== 'cancelled') await allow('hr', 'approve')
      if (to === 'rejected' && note.trim().length < 3) throw new ValidationError({ note: 'Say why.' })
      return ports.hr.decideOvertime(id, to, note)
    },
    async loans() {
      const w = await hrWorld()
      return { rows: [...w.loans].sort((a, b) => b.requestedOn.localeCompare(a.requestedOn)), employees: w.views.filter((e) => e.status !== 'inactive'), today: today(), nextMonth: addMonths(startOfMonth(today()), 1).slice(0, 7) }
    },
    async requestLoan(input: LoanInput) {
      const [employees, loans] = await Promise.all([ports.hr.employees(), ports.hr.loans()])
      check(validateLoan(input, employees.find((x) => x.id === input.employeeId), loans))
      return ports.hr.requestLoan(input)
    },
    async decideLoan(id: string, to: Decide, note: string) {
      if (to !== 'cancelled') await allow('payroll', 'approve')
      if (to === 'rejected' && note.trim().length < 3) throw new ValidationError({ note: 'Say why.' })
      return ports.hr.decideLoan(id, to, note)
    },
    filter: filterByEmployee,
  }

  const payroll = {
    async overview() {
      const [periods, settings, w] = await Promise.all([ports.payroll.periods(), ports.payroll.settings(), hrWorld()])
      const rows = [...periods].sort((a, b) => b.month.localeCompare(a.month)).map((p) => ({ period: p, label: periodLabel(p.month), totals: periodTotals(p.lines) }))
      const current = today().slice(0, 7)
      return {
        periods: rows,
        settings,
        today: today(),
        nextMonth: periods.some((p) => p.month === current) ? addMonths(`${current}-01`, 1).slice(0, 7) : current,
        headcount: w.views.filter((e) => e.status !== 'inactive').length,
        latest: rows[0] ?? null,
        accounts: (await ports.finance.accounts()).filter((a) => a.kind === 'bank'),
      }
    },
    async period(id: string) {
      const [periods, w, a, transactions] = await Promise.all([ports.payroll.periods(), hrWorld(), access(), ports.finance.transactions()])
      const p = findById(periods, id, 'payroll period')
      const totals = periodTotals(p.lines)
      const byVilla = [...costByVilla(p.lines)].map(([villaId, amount]) => ({ villa: w.cat.villas.find((v) => v.id === villaId) ?? null, villaId, amount })).sort((x, y) => y.amount - x.amount)
      return {
        period: p,
        label: periodLabel(p.month),
        totals,
        byVilla,
        lines: [...p.lines].sort((x, y) => x.employeeName.localeCompare(y.employeeName)),
        employees: w.views,
        accounts: (await ports.finance.accounts()).filter((acc) => acc.kind === 'bank'),
        canApprove: a.can('payroll', 'approve'),
        canClose: a.can('payroll', 'post'),
        canEdit: a.can('payroll', 'edit'),
        /** BPJS and PPh 21 the closed period owes, each with the remittance entry once one is recorded. */
        statutory: p.status === 'closed' ? statutoryRemittances(p, transactions) : [],
        today: today(),
      }
    },
    /**
     * Pay statutory: one cash-out per office for what the closed period owes and has no remittance
     * yet, from the account picked, submitted through the approval chain like any cash-out.
     */
    async payStatutory(id: string, accountId: string) {
      await allow('payroll', 'post')
      const [periods, transactions, accounts, cat] = await Promise.all([ports.payroll.periods(), ports.finance.transactions(), ports.finance.accounts(), catalog()])
      const p = findById(periods, id, 'payroll period')
      if (p.status !== 'closed') throw new RuleError('PAYROLL_INVALID_STATE', `Close payroll ${periodLabel(p.month)} before paying what it withheld.`)
      const account = accounts.find((acc) => acc.id === accountId)
      if (!account) throw new ValidationError({ accountId: 'Pick the account the remittance is paid from.' })
      const due = statutoryRemittances(p, transactions).filter((r) => r.amount > 0 && !r.entry)
      if (due.length === 0) throw new RuleError('STATUTORY_PAID', `BPJS and PPh 21 for ${periodLabel(p.month)} already have their remittance.`)
      const created = []
      for (const r of due)
        created.push(
          await ports.finance.createTransaction(
            { accountId: account.id, kind: 'cash_out', categoryId: r.categoryId, amount: r.amount, date: today(), locationId: account.locationId ?? cat.locations[0]?.id ?? '', villaId: null, unitId: null, bookingId: null, description: `${r.label} remittance for ${periodLabel(p.month)}`, reference: r.reference, attachments: [] },
            true,
            'payroll',
          ),
        )
      return created
    },
    async payslip(id: string, employeeId: string) {
      const [periods, w, settings] = await Promise.all([ports.payroll.periods(), hrWorld(), ports.payroll.settings()])
      const p = findById(periods, id, 'payroll period')
      const line = p.lines.find((l) => l.employeeId === employeeId)
      const employee = w.views.find((e) => e.id === employeeId)
      if (!line || !employee) throw new NotFoundError('payslip', employeeId)
      return { period: p, label: periodLabel(p.month), line, employee, settings, catalog: w.cat }
    },
    settings: () => ports.payroll.settings(),
    async saveSettings(settings: PayrollSettings) {
      await allow('payroll', 'edit')
      check(validatePayrollSettings(settings))
      return ports.payroll.saveSettings(settings)
    },
    async createPeriod(month: string) {
      await allow('payroll', 'create')
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new ValidationError({ month: 'Pick a month.' })
      return ports.payroll.createPeriod(month)
    },
    async calculate(id: string) {
      await allow('payroll', 'edit')
      return ports.payroll.calculate(id)
    },
    async addAdjustment(id: string, employeeId: string, input: PayrollAdjustmentInput) {
      await allow('payroll', 'edit')
      check(validatePayrollAdjustment(input))
      return ports.payroll.addAdjustment(id, employeeId, input)
    },
    async removeAdjustment(id: string, employeeId: string, adjustmentId: string) {
      await allow('payroll', 'edit')
      return ports.payroll.removeAdjustment(id, employeeId, adjustmentId)
    },
    async transition(id: string, to: PayrollStatus, note = '', accountId?: string) {
      if (to === 'approved') await allow('payroll', 'approve')
      if (to === 'closed') await allow('payroll', 'post')
      if (to === 'draft') await allow('payroll', 'edit')
      if (to === 'draft' && note.trim().length < 3) throw new ValidationError({ note: 'Say why the payroll reopens.' })
      if (to === 'closed' && !accountId) throw new ValidationError({ accountId: 'Pick the account the salaries are paid from.' })
      return ports.payroll.transition(id, to, note.trim(), accountId)
    },
    async publish(id: string) {
      await allow('payroll', 'edit')
      return ports.payroll.publish(id)
    },
  }

  /** The employee area: everything about the signed-in person. */
  const people = {
    async home() {
      const [a, w, periods, kpis, announcements] = await Promise.all([access(), hrWorld(), ports.payroll.periods(), ports.people.kpis(), ports.people.announcements()])
      const now = today()
      const month = now.slice(0, 7)
      const employee = a.user.employeeId ? (w.views.find((e) => e.id === a.user.employeeId) ?? null) : null
      const mine = <T extends { employeeId: string }>(list: readonly T[]) => (employee ? list.filter((x) => x.employeeId === employee.id) : [])
      const attendance = mine(w.attendance).filter((x) => x.date.startsWith(month))
      const published = periods.filter((p) => p.published && employee && p.lines.some((l) => l.employeeId === employee.id)).sort((x, y) => y.month.localeCompare(x.month))
      const latest = published[0] ?? null
      const review = employee ? (kpis.filter((k) => k.employeeId === employee.id && k.status === 'published').sort((x, y) => y.period.localeCompare(x.period))[0] ?? null) : null
      const villaIds = employee ? villaIdsOf(employee) : []
      return {
        user: a.user,
        employee,
        /** Month and status per payroll period, for the request flow; no amounts. */
        periods: periods.map((p) => ({ id: p.id, month: p.month, status: p.status })),
        today: now,
        attendance: {
          present: attendance.filter((x) => x.status === 'present').length,
          late: attendance.filter((x) => x.status === 'late').length,
          absent: attendance.filter((x) => x.status === 'absent').length,
          leave: attendance.filter((x) => x.status === 'leave').length,
          rows: [...attendance].sort((x, y) => y.date.localeCompare(x.date)).slice(0, 10),
        },
        leaveLeft: employee?.leaveLeft ?? 0,
        leaves: mine(w.leaves).sort((x, y) => y.requestedOn.localeCompare(x.requestedOn)),
        overtime: mine(w.overtime).sort((x, y) => y.date.localeCompare(x.date)),
        overtimeHoursMonth: sum(mine(w.overtime).filter((o) => o.status === 'approved' && o.date.startsWith(month)).map((o) => o.hours)),
        loans: mine(w.loans),
        shifts: eachDay(now, addDays(now, 7)).map((date) => {
          const asg = employee ? (w.assignments.find((x) => x.employeeId === employee.id && x.date === date) ?? null) : null
          return { date, assignment: asg, shift: asg?.shiftId ? (w.shifts.find((s) => s.id === asg.shiftId) ?? null) : null, villa: asg ? (w.cat.villas.find((v) => v.id === asg.villaId) ?? null) : null }
        }),
        payslip: latest && employee ? { period: latest, label: periodLabel(latest.month), line: latest.lines.find((l) => l.employeeId === employee.id) ?? null } : null,
        payslips: published.map((p) => ({ period: p, label: periodLabel(p.month), line: employee ? (p.lines.find((l) => l.employeeId === employee.id) ?? null) : null })),
        kpi: review ? { ...review, score: kpiScore(review.items) } : null,
        announcements: announcements.filter((n) => n.villaId === null || villaIds.includes(n.villaId)).sort((x, y) => Number(y.pinned) - Number(x.pinned) || y.publishedOn.localeCompare(x.publishedOn)),
        catalog: w.cat,
      }
    },
    async payslip(periodId: string) {
      const [a, w, periods, settings] = await Promise.all([access(), hrWorld(), ports.payroll.periods(), ports.payroll.settings()])
      const p = findById(periods, periodId, 'payroll period')
      const employee = a.user.employeeId ? w.views.find((e) => e.id === a.user.employeeId) : undefined
      const line = employee ? p.lines.find((l) => l.employeeId === employee.id) : undefined
      if (!p.published || !employee || !line) throw new NotFoundError('payslip', periodId)
      return { period: p, label: periodLabel(p.month), line, employee, settings, catalog: w.cat }
    },
    async requestLeave(input: Omit<LeaveInput, 'employeeId'>) {
      const a = await access()
      if (!a.user.employeeId) throw new ValidationError({ form: 'Your login is not linked to an employee record.' })
      return hr.requestLeave({ ...input, employeeId: a.user.employeeId })
    },
    async requestOvertime(input: Omit<OvertimeInput, 'employeeId'>) {
      const a = await access()
      if (!a.user.employeeId) throw new ValidationError({ form: 'Your login is not linked to an employee record.' })
      return hr.requestOvertime({ ...input, employeeId: a.user.employeeId })
    },
    async requestLoan(input: Omit<LoanInput, 'employeeId'>) {
      const a = await access()
      if (!a.user.employeeId) throw new ValidationError({ form: 'Your login is not linked to an employee record.' })
      return hr.requestLoan({ ...input, employeeId: a.user.employeeId })
    },
    async cancelRequest(kind: 'leave' | 'overtime' | 'loan', id: string) {
      if (kind === 'leave') return ports.hr.decideLeave(id, 'cancelled', '')
      if (kind === 'overtime') return ports.hr.decideOvertime(id, 'cancelled', '')
      return ports.hr.decideLoan(id, 'cancelled', '')
    },
    async announcements() {
      const [list, w] = await Promise.all([ports.people.announcements(), catalog()])
      return { announcements: [...list].sort((x, y) => Number(y.pinned) - Number(x.pinned) || y.publishedOn.localeCompare(x.publishedOn)), catalog: w }
    },
    async createAnnouncement(input: AnnouncementInput) {
      await allow('hr', 'create')
      check(validateAnnouncement(input))
      return ports.people.createAnnouncement(input)
    },
    async updateAnnouncement(id: string, input: AnnouncementInput) {
      await allow('hr', 'edit')
      check(validateAnnouncement(input))
      return ports.people.updateAnnouncement(id, input)
    },
    async deleteAnnouncement(id: string) {
      await allow('hr', 'edit')
      return ports.people.deleteAnnouncement(id)
    },
    async kpis() {
      const [list, w] = await Promise.all([ports.people.kpis(), hrWorld()])
      const rows = list.filter((k) => w.views.some((e) => e.id === k.employeeId)).map((k): KpiView => ({ ...k, employeeName: w.name(k.employeeId), score: kpiScore(k.items) }))
      return { rows: rows.sort((x, y) => y.period.localeCompare(x.period) || x.employeeName.localeCompare(y.employeeName)), employees: w.views.filter((e) => e.status !== 'inactive'), quarter: quarterOf(today()) }
    },
    async saveKpi(id: string | null, input: KpiInput) {
      await allow('hr', 'edit')
      check(validateKpi(input))
      return ports.people.saveKpi(id, input)
    },
  }

  const accessModule = {
    session: () => ports.access.session(),
    context: access,
    async login(input: LoginInput) {
      const errors: Record<string, string> = {}
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) errors.email = 'Enter your email address.'
      if (!input.password) errors.password = 'Enter your password.'
      check(errors)
      return ports.access.login(input)
    },
    logout: () => ports.access.logout(),
    async changePassword(input: PasswordChange) {
      check(validatePasswordChange(input))
      return ports.access.changePassword(input)
    },
    async users() {
      const [users, cat, employees] = await Promise.all([ports.access.users(), catalog(), ports.hr.employees()])
      return {
        users: [...users].sort((a, b) => a.name.localeCompare(b.name)).map((u) => ({ ...u, scope: u.villaIds.length ? u.villaIds.map((id) => cat.villas.find((v) => v.id === id)?.name ?? id).join(', ') : u.locationIds.length ? u.locationIds.map((id) => cat.locations.find((l) => l.id === id)?.name ?? id).join(', ') : 'Everything', employee: employees.find((e) => e.id === u.employeeId) ?? null })),
        catalog: cat,
        employees: employees.filter((e) => e.status !== 'inactive'),
        today: today(),
      }
    },
    async createUser(input: UserInput) {
      await allow('access', 'create')
      check(validateUser(input, await ports.access.users()))
      return ports.access.createUser(input)
    },
    async updateUser(id: string, input: UserInput) {
      await allow('access', 'edit')
      check(validateUser(input, await ports.access.users(), id))
      return ports.access.updateUser(id, input)
    },
    async setUserActive(id: string, active: boolean) {
      await allow('access', 'edit')
      return ports.access.setUserActive(id, active)
    },
    permissions: () => ports.access.permissions(),
    async savePermissions(role: Role, perms: Permissions[Role]) {
      await allow('access', 'edit')
      return ports.access.savePermissions(role, perms)
    },
    async audit() {
      const [entries, users] = await Promise.all([ports.access.audit(), ports.access.users()])
      return { entries, users, entities: [...new Set(entries.map((e) => e.entity))].sort(), today: today() }
    },
    filterAudit,
  }

  /** Every master table on one page. */
  const master = {
    async all() {
      const [cat, accounts, listings, cashAccounts, categories, rules, shifts] = await Promise.all([catalog(), ports.airbnb.accounts(), ports.airbnb.listings(), ports.finance.accounts(), ports.finance.categories(), ports.finance.approvalRules(), ports.hr.shifts()])
      return { catalog: cat, accounts, listings, cashAccounts, categories, rules, shifts, today: today() }
    },
  }

  const account = {
    profile: () => ports.account.profile(),
    async saveProfile(profile: Profile) {
      check(validateProfile(profile))
      return ports.account.saveProfile(profile)
    },
  }

  const accounting = createAccounting(ports, { access, allow, catalog, check })

  /** Typed tabular reports; the page renders any of them from `columns` and `rows`. */
  const reports = {
    list: () => REPORTS,
    async options() {
      const [cat, accounts] = await Promise.all([catalog(), ports.airbnb.accounts()])
      return { catalog: cat, sources: sourceOptions(accounts), today: today() }
    },
    async run(slug: string, f: ReportFilter): Promise<ReportResult> {
      const def = REPORTS.find((r) => r.slug === slug)
      if (!def) throw new NotFoundError('report', slug)
      await allow('reports', 'view')
      const from = f.from ?? addDays(today(), -29)
      const to = f.to ?? today()
      const end = addDays(to, 1)
      const scope: Scope = { locationId: f.locationId, villaId: f.villaId, unitId: f.unitId }
      const money = (v: number) => Math.round(v)
      let rows: ReportRow[] = []
      if (def.group === 'accounting') rows = await accounting.reportRows(slug, { ...f, from, to })

      if (def.group === 'stock') rows = await stock.reportRows(slug, from, to, scope)

      if (def.group === 'services') {
        const ow = await orderWorld()
        const inScope = (o: ServiceOrderView) => (!scope.villaId || o.villaId === scope.villaId) && (!scope.locationId || o.place.location.id === scope.locationId) && (!scope.unitId || o.unitId === scope.unitId)
        const delivered = ow.views.filter((o) => inScope(o) && o.status === 'delivered' && o.deliveredOn !== null && o.deliveredOn >= from && o.deliveredOn <= to)
        const villaName = (id: string) => ow.w.cat.villas.find((v) => v.id === id)?.name ?? id
        if (slug === 'rs-revenue') {
          const groups = new Map<string, ServiceOrderView[]>()
          for (const o of delivered) for (const c of new Set(o.lines.map((l) => l.category))) groups.set(`${o.villaId}|${c}`, [...(groups.get(`${o.villaId}|${c}`) ?? []), o])
          rows = [...groups].map(([key, list]) => {
            const [villaId = '', category = ''] = key.split('|')
            // Each order's figures are taken for its lines in this category; discounts spread pro rata.
            const part = list.map((o) => {
              const lines = o.lines.filter((l) => l.category === category)
              const t = orderTotals({ lines, discountPct: o.discountPct })
              return { ...t, paid: o.payState === 'paid' ? t.charge : 0, unpaid: o.payState === 'unpaid' || o.payState === 'pending' ? t.charge : 0 }
            })
            const total = (k: keyof (typeof part)[number]) => sum(part.map((x) => x[k]))
            // Costs print as negatives, and an empty one as zero rather than "-Rp 0".
            const less = (k: keyof (typeof part)[number]) => (total(k) ? -total(k) : 0)
            return { villa: villaName(villaId), category: MENU_CATEGORY_LABEL[category as MenuCategory], orders: list.length, gross: total('gross'), comp: less('comp'), discount: less('discount'), charged: total('charge'), cost: less('cost'), margin: total('margin'), paid: total('paid'), unpaid: total('unpaid') }
          }).sort((a, b) => a.villa.localeCompare(b.villa) || Number(b.charged) - Number(a.charged))
        }
        if (slug === 'rs-items') {
          const items = new Map<string, { item: string; category: string; villa: string; quantity: number; orders: number; sales: number; cost: number }>()
          for (const o of delivered)
            for (const l of o.lines) {
              const row = items.get(l.itemId) ?? { item: l.name, category: MENU_CATEGORY_LABEL[l.category], villa: villaName(o.villaId), quantity: 0, orders: 0, sales: 0, cost: 0 }
              row.quantity = Math.round((row.quantity + l.quantity) * 10) / 10
              row.orders += 1
              row.sales += l.comp ? 0 : Math.round(lineAmount(l) * (1 - o.discountPct / 100))
              row.cost += lineCost(l)
              items.set(l.itemId, row)
            }
          rows = [...items.values()].map((r) => ({ ...r, cost: r.cost ? -r.cost : 0, margin: r.sales - r.cost })).sort((a, b) => b.sales - a.sales || b.quantity - a.quantity)
        }
        if (slug === 'rs-delivery') {
          const requested = ow.views.filter((o) => inScope(o) && o.status !== 'cancelled' && o.requestedOn >= from && o.requestedOn <= to)
          rows = MENU_CATEGORIES.map((c) => {
            const mine = requested.filter((o) => o.lines.some((l) => l.category === c))
            const done = mine.filter((o) => o.delay !== null)
            const delays = done.map((o) => o.delay ?? 0)
            const onTime = delays.filter((d) => d <= ORDER_SLA_MINUTES).length
            return { category: MENU_CATEGORY_LABEL[c], orders: mine.length, delivered: done.length, onTime, late: done.length - onTime, rate: done.length ? onTime / done.length : 0, avgMinutes: delays.length ? Math.round(sum(delays) / delays.length) : 0, maxMinutes: delays.length ? Math.max(...delays) : 0, openLate: mine.filter((o) => o.late).length }
          }).filter((r) => r.orders > 0)
        }
        if (slug === 'rs-partners') {
          const fin = await financeWorld()
          // A delivery books one cash-out per partner, in the order partnerCosts lists them.
          const billed = delivered.flatMap((o) => partnerCosts(o).map((c, i) => ({ partnerId: c.partnerId, entry: fin.views.find((t) => t.id === o.costTransactionIds[i]) })))
          rows = ow.partners.map((p) => {
            const mine = delivered.filter((o) => o.lines.some((l) => l.partnerId === p.id))
            const entries = billed.filter((x) => x.partnerId === p.id).flatMap((x) => (x.entry ? [x.entry] : []))
            const by = (status: TransactionStatus) => sum(entries.filter((t) => t.status === status).map((t) => t.amount))
            return { partner: p.name, kind: PARTNER_KIND_LABEL[p.kind], orders: mine.length, billed: sum(entries.map((t) => t.amount)), waiting: by('submitted'), approved: by('approved'), posted: by('posted'), rejected: by('rejected') }
          }).filter((r) => r.orders > 0)
        }
      }

      if (def.group === 'finance' || slug === 'approvals') {
        const w = await financeWorld()
        const scoped = scopedTransactions(w.views, scope).filter((t) => t.date >= from && t.date <= to)
        const system = (t: TransactionView) => t.origin === 'transfer' || t.origin === 'adjustment' || t.origin === 'reconciliation'
        if (slug === 'cash-entries') {
          rows = scoped
            .filter((t) => (!f.kind || t.kind === f.kind) && (!f.status || t.status === f.status))
            .sort((a, b) => a.date.localeCompare(b.date))
            .map((t) => ({ date: t.date, number: t.number, kind: t.kind === 'cash_in' ? 'Cash in' : 'Cash out', description: t.description, category: t.categoryName, account: t.accountName, villa: t.villa?.name ?? '', unit: t.unit?.code ?? '', status: cap(t.status), reference: t.reference, amount: t.kind === 'cash_in' ? t.amount : -t.amount }))
        }
        if (slug === 'cash-flow') {
          rows = w.accounts.map((a) => {
            const opening = balance(a, w.transactions, addDays(from, -1))
            const inRange = w.transactions.filter((t) => t.accountId === a.id)
            const s = cashSummary(inRange, from, end)
            return { account: a.name, location: a.locationId ? w.cat.location(a.locationId).name : 'All', opening, cashIn: s.cashIn, cashOut: s.cashOut, net: s.net, closing: opening + s.net }
          })
        }
        if (slug === 'petty-cash') {
          const employees = await ports.hr.employees()
          const reconciliations = await ports.finance.reconciliations()
          rows = w.accounts
            .filter((a) => a.kind === 'petty' && (!scope.villaId || a.villaId === scope.villaId) && (!scope.locationId || a.locationId === scope.locationId))
            .map((a) => {
              const opening = balance(a, w.transactions, addDays(from, -1))
              const moves = w.transactions.filter((t) => t.accountId === a.id && counts(t) && t.date >= from && t.date < end)
              const topUps = sum(moves.filter((t) => t.kind === 'cash_in').map((t) => t.amount))
              const spends = moves.filter((t) => t.kind === 'cash_out')
              const closing = opening + topUps - sum(spends.map((t) => t.amount))
              return { villa: a.villaId ? w.cat.villa(a.villaId).name : a.name, custodian: employees.find((e) => e.id === a.custodianId)?.name ?? '', float: a.floatLimit ?? 0, opening, topUps, spent: -sum(spends.map((t) => t.amount)), entries: spends.length, closing, state: pettyLow(a, closing) ? 'Low, top up' : 'OK', lastCount: reconciliations.filter((r) => r.accountId === a.id).map((r) => r.date).sort().at(-1) ?? '' }
            })
        }
        if (slug === 'income' || slug === 'expense') {
          const kind = slug === 'income' ? 'cash_in' : 'cash_out'
          const lines = w.categories
            .filter((c) => c.kind === kind)
            .map((c) => {
              const mine = scoped.filter((t) => t.categoryId === c.id && counts(t) && !t.reversalOf && !t.reversedBy)
              return { category: c.name, entries: mine.length, amount: sum(mine.map((t) => t.amount)) }
            })
            .filter((r) => r.entries > 0)
          const total = sum(lines.map((r) => r.amount))
          rows = lines.map((r) => ({ ...r, share: total ? r.amount / total : 0 })).sort((a, b) => Number(b.amount) - Number(a.amount))
        }
        if (slug === 'approvals') {
          rows = scoped
            .filter((t) => t.status !== 'draft' && (!f.status || t.status === f.status))
            .sort((a, b) => a.date.localeCompare(b.date))
            .map((t) => ({ date: t.date, number: t.number, description: t.description, villa: t.villa?.name ?? '', amount: t.amount, status: cap(t.status), chain: t.levels.map((r) => ROLE_LABEL[r]).join(' › '), signed: t.approvals.map((a) => a.by).join(', '), next: t.nextApprover ? ROLE_LABEL[t.nextApprover] : '', reason: t.rejectionReason ?? '' }))
        }
        if (slug.startsWith('pnl')) {
          const [b, periods] = await Promise.all([bookingWorld(), ports.payroll.periods()])
          const closed = periods.filter((p) => p.status === 'closed' && `${p.month}-01` >= startOfMonth(from) && `${p.month}-01` <= to)
          const payrollByVilla = new Map<string, number>()
          for (const p of closed) for (const [id, v] of costByVilla(p.lines)) payrollByVilla.set(id, (payrollByVilla.get(id) ?? 0) + v)
          const villaRow = (villaId: string) => {
            const villa = b.cat.villa(villaId)
            const stays = b.views.filter((x) => x.place.villa.id === villaId)
            const mine = w.views.filter((t) => t.villaId === villaId && counts(t) && t.date >= from && t.date <= to && !system(t) && !t.reversalOf && !t.reversedBy)
            const revenue = revenueBetween(stays, from, end)
            const fees = sum(stays.filter((x) => x.source === 'airbnb' && x.checkIn >= from && x.checkIn <= to && x.status !== 'cancelled' && x.status !== 'draft').map((x) => x.airbnbFee))
            const other = sum(mine.filter((t) => t.kind === 'cash_in' && t.categoryId !== 'cat-room' && t.categoryId !== 'cat-airbnb' && t.categoryId !== 'cat-deposit').map((t) => t.amount))
            const expenses = sum(mine.filter((t) => t.kind === 'cash_out' && t.origin !== 'payroll' && t.categoryId !== 'cat-other').map((t) => t.amount)) + sum(mine.filter((t) => t.kind === 'cash_out' && t.categoryId === 'cat-other' && !t.bookingId).map((t) => t.amount))
            const payroll = payrollByVilla.get(villaId) ?? 0
            return { villa, location: b.cat.location(villa.locationId), revenue, fees, other, expenses, payroll, profit: revenue - fees + other - expenses - payroll, margin: revenue ? (revenue - fees + other - expenses - payroll) / revenue : 0 }
          }
          const villas = unitsIn(b.cat, scope).map((u) => u.villaId).filter((v, i, arr) => arr.indexOf(v) === i).map(villaRow)
          if (slug === 'pnl-villa') rows = villas.map((v) => ({ villa: v.villa.name, location: v.location.name, revenue: v.revenue, fees: -v.fees, other: v.other, expenses: -v.expenses, payroll: -v.payroll, profit: v.profit, margin: v.margin }))
          if (slug === 'pnl-location')
            rows = b.cat.locations
              .map((loc) => {
                const mine = villas.filter((v) => v.location.id === loc.id)
                const unmapped = sum(w.views.filter((t) => t.locationId === loc.id && !t.villaId && t.kind === 'cash_out' && counts(t) && t.date >= from && t.date <= to && !system(t) && t.origin !== 'payroll' && !t.reversalOf && !t.reversedBy).map((t) => t.amount))
                const revenue = sum(mine.map((v) => v.revenue))
                const profit = sum(mine.map((v) => v.profit)) - unmapped
                return { location: loc.name, villas: mine.length, revenue, fees: -sum(mine.map((v) => v.fees)), other: sum(mine.map((v) => v.other)), expenses: -(sum(mine.map((v) => v.expenses)) + unmapped), payroll: -sum(mine.map((v) => v.payroll)), profit, margin: revenue ? profit / revenue : 0 }
              })
              .filter((r) => Number(r.villas) > 0)
          if (slug === 'pnl-portfolio') {
            const months = eachDay(startOfMonth(from), end).filter((d) => d.endsWith('-01'))
            rows = months.map((m) => {
              const mEnd = addMonths(m, 1)
              const mFrom = m < from ? from : m
              const mTo = mEnd > end ? end : mEnd
              const stays = b.views.filter((x) => unitsIn(b.cat, scope).some((u) => u.id === x.unitId))
              const mine = scopedTransactions(w.views, scope).filter((t) => counts(t) && t.date >= mFrom && t.date < mTo && !system(t) && !t.reversalOf && !t.reversedBy)
              const revenue = revenueBetween(stays, mFrom, mTo)
              const fees = sum(stays.filter((x) => x.source === 'airbnb' && x.checkIn >= mFrom && x.checkIn < mTo && x.status !== 'cancelled' && x.status !== 'draft').map((x) => x.airbnbFee))
              const other = sum(mine.filter((t) => t.kind === 'cash_in' && t.categoryId !== 'cat-room' && t.categoryId !== 'cat-airbnb' && t.categoryId !== 'cat-deposit').map((t) => t.amount))
              const expenses = sum(mine.filter((t) => t.kind === 'cash_out' && t.origin !== 'payroll').map((t) => t.amount))
              const payroll = sum(closed.filter((p) => p.month === m.slice(0, 7)).map((p) => periodTotals(p.lines).cost))
              const profit = revenue - fees + other - expenses - payroll
              return { month: periodLabel(m.slice(0, 7)), revenue, fees: -fees, other, expenses: -expenses, payroll: -payroll, profit, margin: revenue ? profit / revenue : 0 }
            })
          }
        }
      }

      if (def.group === 'revenue' || def.group === 'operations') {
        const b = await bookingWorld()
        const units = unitsIn(b.cat, scope)
        const unitIds = new Set(units.map((u) => u.id))
        const stays = b.views.filter((x) => unitIds.has(x.unitId)).filter(bySource(f.source))
        const live = (x: BookingView) => x.status !== 'cancelled' && x.status !== 'draft'
        const touching = stays.filter((x) => live(x) && x.checkIn < end && x.checkOut > from)
        if (slug === 'revenue-source') {
          const lines = sourceOptions(b.accounts).map((src) => {
            const mine = touching.filter(bySource(src.id))
            const revenue = revenueBetween(mine, from, end)
            const fees = sum(mine.filter((x) => x.checkIn >= from).map((x) => x.airbnbFee))
            return { source: src.label, bookings: mine.length, nights: nightsBetween(mine, from, end), revenue, fees: -fees, payout: revenue - fees }
          })
          const total = sum(lines.map((r) => r.revenue))
          rows = lines.map((r) => ({ ...r, share: total ? r.revenue / total : 0 })).filter((r) => r.bookings > 0)
        }
        if (slug === 'revenue-account') {
          rows = b.accounts.map((a) => {
            const mine = touching.filter((x) => x.airbnbAccountId === a.id)
            const revenue = revenueBetween(mine, from, end)
            const fees = sum(mine.filter((x) => x.checkIn >= from).map((x) => x.airbnbFee))
            return { account: a.name, listings: b.listings.filter((l) => l.accountId === a.id).length, bookings: mine.length, nights: nightsBetween(mine, from, end), revenue, fees: -fees, payout: revenue - fees, unpaid: mine.filter((x) => x.paymentStatus !== 'paid').length }
          })
        }
        if (slug === 'revenue-listing') {
          rows = b.listings
            .filter((l) => unitIds.has(l.unitId))
            .map((l) => {
              const mine = touching.filter((x) => x.unitId === l.unitId && x.source === 'airbnb')
              const revenue = revenueBetween(mine, from, end)
              return { unit: b.cat.unit(l.unitId).code, listing: l.title, account: b.accounts.find((a) => a.id === l.accountId)?.name ?? '', status: cap(l.status), bookings: mine.length, nights: nightsBetween(mine, from, end), revenue, adr: nightsBetween(mine, from, end) ? revenue / nightsBetween(mine, from, end) : 0 }
            })
            .sort((x, y) => Number(y.revenue) - Number(x.revenue))
        }
        if (slug === 'discounts') {
          const policy = await ports.payment.policy()
          const priced = touching.filter((x) => x.source === 'direct' && x.priceSetBy && x.price.total < x.price.list && x.checkIn >= from && x.checkIn < end)
          const keys = [...new Set(priced.map((x) => `${x.place.villa.name}|${x.priceSetBy?.by ?? ''}`))].sort()
          rows = keys.map((k) => {
            const [villa = '', by = ''] = k.split('|')
            const mine = priced.filter((x) => x.place.villa.name === villa && x.priceSetBy?.by === by)
            const list = sum(mine.map((x) => x.price.list))
            const total = sum(mine.map((x) => x.total))
            return { villa, by, bookings: mine.length, nights: sum(mine.map((x) => x.nights)), list, discount: -(list - total), total, share: list ? (list - total) / list : 0, approved: mine.filter((x) => beyondDiscountLimit(x.price, policy.discountLimitPct)).length }
          })
        }
        if (slug === 'occupancy') {
          rows = units.map((u) => {
            const mine = stays.filter((x) => x.unitId === u.id)
            const occ = occupancy([u], mine, b.blocks, from, end)
            const revenue = revenueBetween(mine, from, end)
            return { unit: u.code, villa: b.cat.villa(u.villaId).name, location: b.cat.location(b.cat.villa(u.villaId).locationId).name, sellable: occ.unitNights - occ.blockedNights, blocked: occ.blockedNights, sold: occ.occupiedNights, rate: occ.rate, revenue, adr: occ.occupiedNights ? revenue / occ.occupiedNights : 0 }
          })
        }
        if (slug === 'bookings') {
          rows = stays
            .filter((x) => x.checkIn < end && x.checkOut > from && (!f.status || x.status === f.status))
            .sort((x, y) => x.checkIn.localeCompare(y.checkIn))
            .map((x) => ({ code: x.code, guest: x.guestName, unit: x.unitCode, villa: x.place.villa.name, checkIn: x.checkIn, checkOut: x.checkOut, nights: x.nights, source: x.sourceLabel, status: cap(x.status.replace('_', ' ')), payment: cap(x.paymentStatus), total: x.total, fee: -x.airbnbFee, payout: x.payout }))
        }
        if (slug === 'unit-movement') {
          rows = stays
            .flatMap((x) => x.movements.map((m) => ({ stay: x, m })))
            .filter(({ m }) => m.on >= from && m.on <= to)
            .sort((p, q) => p.m.on.localeCompare(q.m.on))
            .map(({ stay, m }) => ({ date: m.on, code: stay.code, guest: stay.guestName, requested: b.cat.unit(stay.requestedUnitId).code, from: b.cat.unit(m.fromUnitId).code, to: b.cat.unit(m.toUnitId).code, actual: stay.unitCode, reason: m.reason, by: m.by, status: cap(stay.status.replace('_', ' ')) }))
        }
        if (slug === 'guest-history') {
          rows = b.guests
            .map((g) => {
              const mine = stays.filter((x) => x.guestId === g.id && live(x) && x.checkIn >= from && x.checkIn <= to)
              return { guest: g.name, nationality: g.nationality, stays: mine.length, nights: sum(mine.map((x) => x.nights)), spent: sum(mine.map((x) => x.total)), lastStay: mine.map((x) => x.checkIn).sort().at(-1) ?? '' }
            })
            .filter((r) => Number(r.stays) > 0)
            .sort((x, y) => Number(y.spent) - Number(x.spent))
        }
      }

      if (def.group === 'maintenance') {
        const m = await maintenanceWorld()
        const unitIds = new Set(unitsIn(m.cat, scope).map((u) => u.id))
        const villaIds = new Set(unitsIn(m.cat, scope).map((u) => u.villaId))
        const inScopeJob = (w: WorkOrderView) => (w.unitId ? unitIds.has(w.unitId) : villaIds.has(w.villaId))
        const jobs = m.views.filter((w) => inScopeJob(w) && w.createdOn >= from && w.createdOn <= to && w.status !== 'cancelled')
        if (slug === 'maint-cost') {
          const ledger = await ports.finance.transactions()
          const posted = (list: readonly WorkOrderView[], kind: ExpenseKind) => sum(list.flatMap((w) => w.expenses).filter((e) => e.kind === kind && ledger.find((t) => t.id === e.transactionId)?.status === 'posted').map((e) => e.amount))
          const keys = [...new Set(jobs.map((w) => `${w.villaId}|${w.unitId ?? ''}`))]
          rows = keys
            .map((key) => {
              const mine = jobs.filter((w) => `${w.villaId}|${w.unitId ?? ''}` === key)
              const first = mine[0]
              return { villa: first?.villaName ?? '', unit: first?.unitCode || 'Shared', jobs: mine.length, open: mine.filter(isOpenWorkOrder).length, estimate: sum(mine.map((w) => w.total)), parts: posted(mine, 'parts'), labour: posted(mine, 'labour'), vendor: posted(mine, 'vendor'), total: sum(mine.map((w) => w.spent.posted)), pending: sum(mine.map((w) => w.spent.recorded - w.spent.posted)) }
            })
            .sort((a, b) => b.total - a.total)
        }
        if (slug === 'maint-downtime') {
          rows = unitsIn(m.cat, scope)
            .map((u) => {
              const blocks = m.blocks.filter((k) => k.unitId === u.id && k.reason === 'maintenance' && k.from < end && k.to > from)
              const nights = sum(blocks.map((k) => Math.max(0, daysBetween(k.from < from ? from : k.from, k.to > end ? end : k.to))))
              return { unit: u.code, villa: m.cat.villa(u.villaId).name, blocks: blocks.length, nights, rate: u.nightlyRate, lost: nights * u.nightlyRate }
            })
            .filter((r) => r.blocks > 0)
            .sort((a, b) => b.lost - a.lost)
        }
        if (slug === 'maint-resolution') {
          const keys = [...new Set(jobs.map((w) => `${w.category}|${w.priority}`))]
          rows = keys.map((key) => {
            const mine = jobs.filter((w) => `${w.category}|${w.priority}` === key)
            const days = mine.map(resolutionDays).filter((d): d is number => d !== null)
            const first = mine[0]
            return { category: first ? MAINTENANCE_CATEGORY_LABEL[first.category] : '', priority: first ? PRIORITY_LABEL[first.priority] : '', reported: mine.length, closed: days.length, open: mine.filter(isOpenWorkOrder).length, avgDays: days.length ? Math.round((sum(days) / days.length) * 10) / 10 : 0, maxDays: days.length ? Math.max(...days) : 0 }
          })
        }
        if (slug === 'maint-assets') {
          rows = m.assets
            .filter((a) => (a.unitId ? unitIds.has(a.unitId) : villaIds.has(a.villaId)))
            .map((a) => ({ code: a.code, asset: a.name, place: a.unitCode || a.villaName, status: ASSET_STATUS_LABEL[a.status], jobs: a.workOrders, cost: a.costToDate, purchase: a.purchaseCost, warranty: a.warrantyUntil ?? '' }))
            .sort((a, b) => b.jobs - a.jobs || b.cost - a.cost)
        }
        if (slug === 'maint-preventive') {
          rows = m.plans
            .filter((p) => villaIds.has(p.villaId))
            .map((p) => {
              const mine = m.views.filter((w) => w.planId === p.id && w.scheduledOn && w.scheduledOn >= from && w.scheduledOn <= to)
              const done = mine.filter((w) => w.finishedOn)
              const onTime = done.filter((w) => w.finishedOn && w.scheduledOn && w.finishedOn <= w.scheduledOn).length
              return { plan: p.title, villa: p.villaName, interval: intervalLabel(p), due: mine.length, onTime, late: done.length - onTime, state: PLAN_STATE_LABEL[p.state], nextDue: p.nextDue }
            })
        }
      }

      if (def.group === 'payroll' || def.group === 'hr') {
        const [w, periods] = await Promise.all([hrWorld(), ports.payroll.periods()])
        const inRange = periods.filter((p) => `${p.month}-01` >= startOfMonth(from) && `${p.month}-01` <= to && p.status !== 'draft')
        const villaIds = new Set(unitsIn(w.cat, scope).map((u) => u.villaId))
        if (slug === 'payroll-villa') {
          rows = inRange.flatMap((p) => [...costByVilla(p.lines)].filter(([id]) => villaIds.has(id)).map(([id, amount]) => ({ period: periodLabel(p.month), villa: w.cat.villas.find((v) => v.id === id)?.name ?? id, status: cap(p.status), employees: p.lines.filter((l) => l.allocation.some((a) => a.villaId === id)).length, cost: amount })))
        }
        if (slug === 'payroll-location') {
          rows = inRange.flatMap((p) =>
            w.cat.locations
              .map((loc) => {
                const ids = w.cat.villas.filter((v) => v.locationId === loc.id && villaIds.has(v.id)).map((v) => v.id)
                const cost = sum([...costByVilla(p.lines)].filter(([id]) => ids.includes(id)).map(([, v]) => v))
                return { period: periodLabel(p.month), location: loc.name, status: cap(p.status), villas: ids.length, cost }
              })
              .filter((r) => Number(r.cost) > 0),
          )
        }
        if (slug === 'payroll-summary') {
          rows = inRange.map((p) => {
            const t = periodTotals(p.lines)
            const s = (pick: (l: (typeof p.lines)[number]) => number) => sum(p.lines.map(pick))
            return { period: periodLabel(p.month), status: cap(p.status), employees: t.employees, basic: s((l) => l.basic), allowances: s((l) => l.allowances), overtime: s((l) => l.overtimePay), serviceCharge: s((l) => l.serviceCharge), thr: s((l) => l.thr), bonus: s((l) => l.bonus + l.reimbursement), gross: t.gross, bpjs: s((l) => l.bpjsHealth + l.bpjsEmployment), pph21: s((l) => l.pph21), loans: s((l) => l.loanDeduction), otherDeductions: s((l) => l.lateDeduction + l.absentDeduction + l.otherDeduction), net: t.net, companyBpjs: t.companyBpjs, cost: t.cost }
          })
        }
        if (slug === 'attendance') {
          rows = w.views
            .filter((e) => e.status !== 'inactive' && villaIdsOf(e).some((id) => villaIds.has(id)))
            .map((e) => {
              const mine = w.attendance.filter((a) => a.employeeId === e.id && a.date >= from && a.date <= to)
              const working = mine.filter((a) => a.status !== 'off')
              return { employee: e.name, position: e.position, villas: e.villaNames, present: mine.filter((a) => a.status === 'present').length, late: mine.filter((a) => a.status === 'late').length, absent: mine.filter((a) => a.status === 'absent').length, leave: mine.filter((a) => a.status === 'leave').length, lateMinutes: sum(mine.map((a) => a.lateMinutes)), rate: working.length ? (working.length - mine.filter((a) => a.status === 'absent').length) / working.length : 0 }
            })
        }
        if (slug === 'leave') {
          rows = w.leaves
            .filter((l) => l.from <= to && l.to >= from && (!f.status || l.status === f.status))
            .sort((x, y) => x.from.localeCompare(y.from))
            .map((l) => ({ number: l.number, employee: l.employeeName, kind: cap(l.kind), from: l.from, to: l.to, days: l.days, status: cap(l.status), decidedBy: l.decidedBy, reason: l.reason }))
        }
        if (slug === 'overtime') {
          rows = w.overtime
            .filter((o) => o.date >= from && o.date <= to && (!f.status || o.status === f.status))
            .sort((x, y) => x.date.localeCompare(y.date))
            .map((o) => ({ number: o.number, employee: o.employeeName, date: o.date, villa: o.villaName, hours: o.hours, status: cap(o.status), reason: o.reason, decidedBy: o.decidedBy }))
        }
      }

      if (slug === 'group-bookings') rows = await groups.reportRows(from, end, scope)

      if (slug === 'payments-collected' || slug === 'receivables-aging' || slug === 'airbnb-payouts' || slug === 'refunds') {
        const pw = await paymentWorld()
        const unitIds = new Set(unitsIn(pw.w.cat, scope).map((u) => u.id))
        const views = pw.payments.filter((p) => unitIds.has(pw.w.bookings.find((b) => b.id === p.bookingId)?.unitId ?? ''))
        const inRange = (iso: string | null) => iso !== null && iso >= from && iso <= to
        if (slug === 'payments-collected') {
          const got = views.filter((p) => p.kind !== 'refund' && (p.status === 'paid' || p.status === 'refunded') && inRange(p.paidOn))
          const keys = [...new Set(got.map((p) => `${p.villaName}|${p.method}`))].sort()
          rows = keys.map((k) => {
            const [villa, method] = k.split('|') as [string, PaymentMethod]
            const mine = got.filter((p) => p.villaName === villa && p.method === method)
            const amount = sum(mine.map((p) => p.amount))
            const fees = sum(mine.map((p) => p.gatewayFee))
            return { villa, method: PAYMENT_METHOD_LABEL[method], payments: mine.length, amount, fees: -fees, net: amount - fees }
          })
        }
        if (slug === 'receivables-aging') {
          rows = pw.w.views
            .filter((b) => unitIds.has(b.unitId) && b.source === 'direct' && (b.status === 'confirmed' || b.status === 'checked_in' || b.status === 'checked_out'))
            .map(pw.receivable)
            .filter((r) => r.outstanding > 0)
            .sort((x, y) => x.dueOn.localeCompare(y.dueOn))
            .map((r) => ({ code: r.booking.code, guest: r.booking.guestName, villa: r.booking.place.villa.name, checkIn: r.booking.checkIn, dueOn: r.dueOn, aging: AGING_LABEL[r.bucket], expected: r.expected, paid: r.paid, outstanding: r.outstanding }))
        }
        if (slug === 'airbnb-payouts') {
          rows = pw.w.views
            .filter((b) => unitIds.has(b.unitId) && b.source === 'airbnb' && b.status !== 'draft' && b.status !== 'cancelled' && inRange(addDays(b.checkIn, 1)))
            .map((b) => {
              const r = pw.receivable(b)
              return { code: b.code, account: b.account?.name ?? '', unit: b.unitCode, checkIn: b.checkIn, dueOn: r.dueOn, expected: r.expected, received: r.paid, difference: r.paid - r.expected, status: r.outstanding === 0 ? 'Received' : r.dueOn > today() ? 'Not due' : 'Waiting' }
            })
        }
        if (slug === 'refunds') {
          rows = views
            .filter((p) => p.kind === 'refund' && inRange(p.paidOn))
            .map((p) => ({ date: p.paidOn, number: p.number, original: p.reference, code: p.bookingCode, guest: p.guestName, method: PAYMENT_METHOD_LABEL[p.method], amount: p.amount, reason: p.note }))
        }
      }

      return { slug, title: def.title, blurb: def.blurb, columns: def.columns, rows: rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'number' && def.columns.find((c) => c.key === k)?.kind === 'money' ? money(v) : v]))), from, to }
    },
  }


  const nightAudit = createNightAudit({ ports, today, allow, access, world: bookingWorld, markNoShow: (id) => booking.transition(id, 'no_show') })

  return { clock: ports.clock, files, dashboard, property, airbnb, booking, groups, guest, finance, service, orders, maintenance, stock, payments, hr, payroll, people, access: accessModule, master, account, reports, accounting, nightAudit }
}

export type Services = ReturnType<typeof createServices>
