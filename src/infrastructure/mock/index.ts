import type { Clock, NewBooking, Ports } from '@/application/ports'
import { can, ROLE_LABEL, validatePasswordChange, validateUser, type AuditAction, type User } from '@/domain/access'
import { validateAirbnbAccount, validateListing, validateListingPrice } from '@/domain/airbnb'
import { approvalProgress, canSignLevel, requiredLevels, validateApprovalRule } from '@/domain/approval'
import { MAX_ATTACHMENTS, needsProof, uploadProblem, validateProofPolicy, type Attachment } from '@/domain/attachment'
import { canTransition, findConflicts, isChannel, occupies, sellsRoomType, typeAvailability, validateCheckIn, validateCheckOut, validatePayment, validateStay, type Booking, type CheckOutDetails, type UnitBlock } from '@/domain/booking'
import { beyondDiscountLimit, repriceNights, stayPrice, validatePriceChange, type NightPrice, type PriceChange } from '@/domain/pricing'
import { defaultRatePlan, listNight, noPriceMessage, priceListFor, soldNights, validateRatePlan, type RatePlan } from '@/domain/ratePlan'
import { canEditRequest, canTransitionService, validateServiceRequest, type ServiceRequest } from '@/domain/roomService'
import { canTransitionOrder, folio, itemProblem, ORDER_ARRIVAL_DAYS, ORDER_STATUS_LABEL, orderableStay, orderSummary, orderTokenFor, orderTotals, PARTNER_COST_CATEGORY, partnerCosts, payState, revenueSplit, validateMenuItem, validateOrder, validatePartner, type OrderInput, type PublicMenu, type ServiceOrder } from '@/domain/serviceOrder'
import { findById, NotFoundError, RuleError } from '@/domain/errors'
import { folioOwed, guestFolio, postingGross, rebateBeyondLimit, rebateTarget, rebateTax, validateCharge, validateRebate, type FolioPosting } from '@/domain/folio'
import { closesGroup, masterFolio } from '@/domain/group'
import { auditProblem, nightsAmount, nightsToPost, postedNights, type NightAudit } from '@/domain/nightAudit'
import { openShiftOn } from '@/domain/cashier'
import { balance, canTransitionTransaction, isSystemCategory, validateAccount, validateAdjustment, validateReconciliation, validateTransaction, validateTransfer, type CashAccount, type CashTransferInput, type Reconciliation, type Transaction, type TransactionEvent } from '@/domain/finance'
import { lateMinutes, leaveBalance, leaveDays, loanInstalment, REQUEST_TRANSITIONS, validateAttendance, validateEmployee, validateLeave, validateLoan, validateOvertime, type Attendance, type Employee, type LeaveRequest, type Loan, type OvertimeRequest, type ShiftAssignment } from '@/domain/hr'
import { canTransitionPayroll, computeLine, periodTotals, serviceChargeShare, validateAdjustment as validatePayrollAdjustment, validatePayrollSettings, type PayrollAdjustment, type PayrollLine, type PayrollPeriod } from '@/domain/payroll'
import { advanceDue, canAddExpense, canMoveHousekeeping, EXPENSE_KIND_LABEL, expenseReference, validateExpense, type ExpenseInput, type WorkOrderExpense, canTransitionWorkOrder, INSPECTION_CATEGORY, INSPECTION_LABEL, isOpenWorkOrder, validateAsset, validatePlan, validateVendor, validateWorkOrder, WORK_ORDER_STATUS_LABEL, type HousekeepingRecord, type WorkOrder, type WorkOrderEvent } from '@/domain/maintenance'
import { validateAnnouncement, validateKpi, type Announcement, type KpiReview } from '@/domain/people'
import { bookingTotal } from '@/domain/booking'
import { GL, payableBilled } from '@/domain/journal'
import { modeFor, ratesOn, stayMode, stayTax, taxNote, taxSplit } from '@/domain/tax'
import { balanceDueOn, forOrders, gatewayFee, isGateway, netPaid, PAYMENT_KIND_LABEL, PAYMENT_METHOD_LABEL, qrPayloadFor, settledStatus, settlementLines, validatePayment as validateGuestPayment, validatePolicy, validateSettle, vaNumberFor, type Payment, type PaymentKind, type PaymentLink, type PaymentMethod, type PublicCheckout } from '@/domain/payment'
import { overbookLimit } from '@/domain/overbooking'
import { mergeNotes, unitRestrictions } from '@/domain/restriction'
import { unregisteredAdults } from '@/domain/guest'
import { interchangeableWith, validateGroup, validateLocation, validateProperty, validateUnit, validateVilla, wizardTypes, type Unit } from '@/domain/property'
import { addDays, daysBetween, eachDay } from '@/lib/dates'
import { createBudgetPort } from './budget'
import { createGroupPort } from './groups'
import { createStayRules } from './restrictions'
import { wait } from './helpers'
import { createLedger } from './ledger'
import { createMessagingAdapter } from './messaging'
import { airbnbCode, buildState, restore, snapshot, type Snapshot } from './state'
import { createStockAdapter } from './stock'
import { createCashierPort } from './cashier'
import { createGuestAdapter } from './guests'
import { createHousekeepingAdapter } from './housekeeping'
import { createOwnerAdapter } from './owners'

/**
 * In-memory stand-in for the Go API. It enforces the same rules the backend owns
 * (overlap, lifecycle, posted money, approval levels, sessions) and answers with the API's error codes.
 */
/** Where the demo keeps its changes for the day; the seed is rebuilt on a new day or a new seed version. */
export const DEMO_STORAGE_KEY = 'wit-demo-state'
const SEED_VERSION = 17
/** Uploaded files kept in the saved state, in characters of data URL; past this they keep their name only. */
const STORED_FILE_BUDGET = 3_000_000

interface Store {
  load(): Snapshot | null
  save(s: Snapshot): void
}

function browserStore(today: string): Store | null {
  if (typeof localStorage === 'undefined') return null
  return {
    load() {
      try {
        const raw = localStorage.getItem(DEMO_STORAGE_KEY)
        if (!raw) return null
        const parsed = JSON.parse(raw) as { version: number; today: string; state: Snapshot }
        return parsed.version === SEED_VERSION && parsed.today === today ? parsed.state : null
      } catch {
        return null
      }
    },
    save(state) {
      let budget = STORED_FILE_BUDGET
      const keepFiles = (key: string, value: unknown) => {
        if (key !== 'url' || typeof value !== 'string' || !value.startsWith('data:')) return value
        budget -= value.length
        return budget >= 0 ? value : ''
      }
      try {
        localStorage.setItem(DEMO_STORAGE_KEY, JSON.stringify({ version: SEED_VERSION, today, state }, keepFiles))
      } catch {
        // Storage full or blocked: the demo keeps running in memory.
      }
    },
  }
}

/** A file as a data URL, without FileReader so it runs under Node too. */
async function dataUrl(blob: Blob, type: string) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return `data:${type};base64,${btoa(binary)}`
}

export function createMockPorts(clock: Clock, latency = 240, store: Store | null = browserStore(clock.today())): Ports {
  const s = buildState(clock.today())
  const saved = store?.load()
  if (saved) restore(s, saved)
  let pending = false
  /** Writes the tables once per tick, after the mutation that asked for it. */
  const persist = () => {
    if (!store || pending) return
    pending = true
    setTimeout(() => {
      pending = false
      store.save(snapshot(s))
    }, 0)
  }
  const later = async <T>(value: () => T): Promise<T> => {
    await wait(latency)
    const result = value()
    persist()
    return result
  }
  const copy = <T>(v: T): T => structuredClone(v)
  const today = () => clock.today()
  const catalog = () => s.catalog()
  const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const seq = (key: string) => {
    const n = s.next[key] ?? 1
    s.next[key] = n + 1
    return n
  }
  const newId = (prefix: string, text: string) => `${prefix}-${slug(text) || 'x'}-${seq('entity')}`
  /** The first field error as the API would return it. */
  const refuse = (errors: Record<string, string | undefined>) => {
    const first = Object.values(errors).find(Boolean)
    if (first) throw new RuleError('VALIDATION_ERROR', first)
  }
  const user = (): User => {
    const u = s.sessionUserId ? s.users.find((x) => x.id === s.sessionUserId) : undefined
    if (!u) throw new RuleError('UNAUTHENTICATED', 'Sign in to continue.')
    return u
  }
  const clockNow = () => {
    const now = new Date()
    return `${today()}T${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`
  }
  /** One audit line per mutation, in the signed-in user's name. */
  const log = (action: AuditAction, entity: string, entityId: string, summary: string, before: Record<string, unknown> | null = null, after: Record<string, unknown> | null = null, actor: User = user()) => {
    s.audit.unshift({ id: `aud-${seq('audit')}`, at: clockNow(), userId: actor.id, userName: actor.name, role: actor.role, action, entity, entityId, summary, before, after })
  }
  const event = (kind: TransactionEvent['kind'], note = '', actor: User = user()): TransactionEvent => ({ kind, by: actor.name, role: actor.role, on: today(), note })
  const ledger = createLedger({ s, later, copy, today, seq, user, event, refuse, log })
  /** The payment gateway acts without a session; the audit trail names it. */
  const GUEST: User = { id: 'usr-guest', name: 'Guest', email: '', role: 'staff', status: 'active', locationIds: [], villaIds: [], employeeId: null, lastLoginOn: null, createdOn: '2026-01-01' }
  const GATEWAY: User = { id: 'usr-gateway', name: 'Payment gateway', email: 'gateway@balivillas.id', role: 'admin', status: 'active', locationIds: [], villaIds: [], employeeId: null, lastLoginOn: null, createdOn: '2026-01-01' }

  const guests = createGuestAdapter({ s, later, today, clockNow, user, seq, refuse, log })
  const { createGuest } = guests

  function assertFree(unitId: string, checkIn: string, checkOut: string, excludeId?: string) {
    const unit = catalog().unit(unitId)
    if (unit.status === 'inactive') throw new RuleError('UNIT_UNAVAILABLE', `${unit.code} is inactive.`)
    const conflicts = findConflicts(unitId, checkIn, checkOut, s.bookings, s.blocks, excludeId)
    const first = conflicts[0]
    if (first) throw new RuleError('BOOKING_OVERLAP', `${unit.code} is held by ${first.label} from ${first.from} to ${first.to}.`)
    if (unit.groupId) assertTypeRoom(unit.groupId, checkIn, checkOut, excludeId)
  }

  /** In a villa that sells the room type, stays still waiting for a room count against every night too. */
  function assertTypeRoom(groupId: string, checkIn: string, checkOut: string, excludeId?: string) {
    const group = catalog().group(groupId)
    if (!sellsRoomType(group)) return
    if (typeAvailability(catalog(), groupId, checkIn, checkOut, s.bookings, s.blocks, excludeId, overbookLimit(s.overbooking, groupId)).sellable < 1)
      throw new RuleError('ROOM_TYPE_FULL', `Every ${group.name} room is taken on at least one of those nights.`)
  }

  /** Where a stay holds its nights: the room when it has one, the room type while it waits. */
  function assertStayFree(b: Pick<Booking, 'unitId' | 'unitAssigned'>, checkIn: string, checkOut: string, excludeId?: string) {
    if (b.unitAssigned) return assertFree(b.unitId, checkIn, checkOut, excludeId)
    assertTypeRoom(catalog().unit(b.unitId).groupId ?? '', checkIn, checkOut, excludeId)
  }

  /** A unit joining a room type without a rate plan starts one from its base price. */
  function startPlan(unit: Unit) {
    if (!unit.groupId || s.ratePlans.some((p) => p.groupId === unit.groupId)) return
    s.ratePlans.push({ groupId: unit.groupId, ...defaultRatePlan(unit.nightlyRate) })
    log('create', 'rate_plan', unit.groupId, `Started the ${catalog().group(unit.groupId).name} rate plan from ${unit.code}'s base price`)
  }

  /** A direct stay's list price on one night: the live listing, else the room type's rate plan. Refuses only a night it has to price. */
  const directPrice = (unitId: string) => {
    const unit = catalog().unit(unitId)
    const list = priceListFor(unit, s.listings.find((l) => l.unitId === unitId), s.ratePlans)
    return (date: string): NightPrice => {
      if (!list) throw new RuleError('NO_PRICE', noPriceMessage(unit.code))
      return listNight(list, unit.nightlyRate, date)
    }
  }
  const channelPrice = (rate: number) => (date: string): NightPrice => ({ date, rate, source: { kind: 'channel' } })
  const setNights = (b: Booking, nights: readonly NightPrice[]) => {
    b.listRates = nights.map((n) => n.rate)
    b.listSources = nights.map((n) => n.source)
  }

  /**
   * Applies a staff price to a direct stay. Going further under the list than the policy allows
   * needs someone who may approve bookings; their name goes on the discount.
   */
  function applyPrice(b: Booking, price: PriceChange) {
    if (isChannel(b)) throw new RuleError('CHANNEL_PRICE_LOCKED', `${b.code} keeps the price ${b.source === 'airbnb' ? 'Airbnb' : 'the channel'} sold it for.`)
    refuse(validatePriceChange(price))
    const me = user()
    const next = { listRates: b.listRates, rateOverride: price.rateOverride, discount: price.discount ? { ...price.discount, reason: price.discount.reason.trim() } : null }
    const quoted = stayPrice(next)
    const beyond = beyondDiscountLimit(quoted, s.paymentPolicy.discountLimitPct)
    if (beyond && !can(s.permissions, me.role, 'booking', 'approve'))
      throw new RuleError('DISCOUNT_LIMIT', `${Math.round(quoted.reduction * 100)}% under the list is past the ${s.paymentPolicy.discountLimitPct}% limit. Ask a villa manager to give it.`)
    b.rateOverride = next.rateOverride
    b.discount = next.discount
    b.priceSetBy = next.rateOverride === null && !next.discount ? null : { by: me.name, byId: me.id, on: today(), reason: price.reason.trim(), approvedBy: beyond ? me.name : null }
    return quoted
  }

  const stayRules = createStayRules({ s, later, atomically, copy, seq, user, today, log, refuse, assertFree, recordStay: (b) => ledger.recordStay(b), newTransaction })

  /** A new stay, draft or confirmed; a group passes its id and the party size of the unit. */
  function createStay(input: NewBooking, extra: Pick<Booking, 'bookingGroupId' | 'partySize'> = {}): Booking {
    const problem = validateStay(input.checkIn, input.checkOut)
    if (problem) throw new RuleError('VALIDATION_ERROR', problem)
    // Without a room the guest books the room type; a placeholder room keeps the villa on the stay.
    const group = !input.unitId && input.groupId ? findById(s.groups, input.groupId, 'room type') : null
    if (group && !sellsRoomType(group)) throw new RuleError('VALIDATION_ERROR', `${group.name} rooms are booked one by one. Pick a unit.`)
    const placeholder = group ? s.units.find((u) => u.groupId === group.id && u.status !== 'inactive') : null
    const unitId = input.unitId ?? placeholder?.id
    if (!unitId) throw new RuleError('VALIDATION_ERROR', 'Pick a unit or a room type.')
    // A draft may sit on held nights; confirming it runs the exclusion check.
    if (input.confirm) assertStayFree({ unitId, unitAssigned: !group }, input.checkIn, input.checkOut)
    if (input.source !== 'direct' && (!Number.isInteger(input.channelRate) || (input.channelRate ?? 0) <= 0)) throw new RuleError('VALIDATION_ERROR', 'Enter the nightly price the channel sold.')
    if (input.source !== 'direct' && input.price) throw new RuleError('CHANNEL_PRICE_LOCKED', 'A channel booking keeps the price the channel sold it for.')
    const restrictionNote = stayRules.checkStay({ groupId: group?.id ?? catalog().unit(unitId).groupId, unitId: group ? null : unitId, checkIn: input.checkIn, checkOut: input.checkOut }, input.source, input.override, `${group ? group.name : catalog().unit(unitId).code}, ${input.checkIn} to ${input.checkOut},`)
    const guestId = input.guestId ?? (input.newGuest ? createGuest(input.newGuest).id : null)
    if (!guestId) throw new RuleError('VALIDATION_ERROR', 'A booking needs a guest.')
    guests.assertBookable(guestId, input.blacklistOverride)
    const nights = eachDay(input.checkIn, input.checkOut).map(input.source === 'direct' ? directPrice(unitId) : channelPrice(input.channelRate ?? 0))
    const n = seq('booking')
    const booking: Booking = {
      id: `bk-${n}`,
      code: `BK-${n}`,
      guestId,
      unitId,
      unitAssigned: !group,
      requestedUnitId: unitId,
      source: input.source,
      airbnbAccountId: input.source === 'airbnb' ? input.airbnbAccountId : null,
      airbnbCode: input.source === 'airbnb' ? (input.airbnbCode?.trim() || airbnbCode(n)) : null,
      checkIn: input.checkIn,
      checkOut: input.checkOut,
      listRates: nights.map((night) => night.rate),
      listSources: nights.map((night) => night.source),
      rateOverride: null,
      discount: null,
      priceSetBy: null,
      status: input.confirm ? 'confirmed' : 'draft',
      notes: input.notes.trim(),
      paymentStatus: 'unpaid',
      paidAmount: 0,
      airbnbFee: 0,
      priceMode: modeFor(input.source, s.tax),
      movements: [],
      createdOn: today(),
      checkedInOn: null,
      checkedOutOn: null,
      arrival: null,
      departure: null,
      ...extra,
      ...(restrictionNote ? { restrictionNote } : {}),
    }
    if (input.price) applyPrice(booking, input.price)
    s.bookings.push(booking)
    guestMessages.onStatus(booking)
    log('create', 'booking', booking.code, `${input.confirm ? 'Confirmed' : 'Drafted'} ${booking.code} in ${group ? `${group.name}, room to assign` : catalog().unit(unitId).code}`)
    if (restrictionNote?.kind === 'override') log('update', 'booking', booking.code, `Sold ${booking.code} past stay restrictions: ${restrictionNote.reason}`, null, { rules: restrictionNote.rules.join(', ') })
    return booking
  }

  const workEvent = (kind: WorkOrderEvent['kind'], note = ''): WorkOrderEvent => ({ kind, by: user().name, on: today(), note })

  /** A maintenance block through the booking rules: guests on those nights refuse it. */
  function blockFor(w: WorkOrder, from: string, to: string) {
    if (!w.unitId) throw new RuleError('VALIDATION_ERROR', 'Only a job on a unit can block it.')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to <= from) throw new RuleError('VALIDATION_ERROR', 'The block needs a start and a later end.')
    const unit = catalog().unit(w.unitId)
    const clash = s.bookings.find((b) => b.unitId === w.unitId && occupies(b) && b.checkIn < to && from < b.checkOut)
    if (clash) throw new RuleError('BLOCK_OVERLAP', `${unit.code} has ${clash.code} on those nights. Move the guest before blocking.`)
    const block: UnitBlock = { id: `blk-${seq('block')}`, unitId: w.unitId, from, to, reason: 'maintenance', note: `${w.number} ${w.title}` }
    s.blocks.push(block)
    return block
  }

  /** Keeps the nights already lost for the downtime report and frees the rest. */
  function releaseBlock(w: WorkOrder) {
    const block = s.blocks.find((k) => k.id === w.blockId)
    w.blockId = null
    if (!block) return
    if (block.from >= today()) s.blocks = s.blocks.filter((k) => k.id !== block.id)
    else if (block.to > today()) block.to = today()
  }

  function newWorkOrder(input: Omit<WorkOrder, 'id' | 'number' | 'status' | 'createdOn' | 'startedOn' | 'finishedOn' | 'verifiedOn' | 'blockId' | 'expenses' | 'history' | 'reportedBy'>, reportedBy = user().name): WorkOrder {
    const n = seq('workOrder')
    const w: WorkOrder = { ...input, id: `wo-${n}`, number: `WO-${500 + n}`, status: input.scheduledOn ? 'scheduled' : 'open', createdOn: today(), startedOn: null, finishedOn: null, verifiedOn: null, blockId: null, expenses: [], reportedBy, history: [workEvent('created', input.description)] }
    s.workOrders.push(w)
    log('create', 'work-order', w.number, `Opened ${w.number}, ${w.title}`)
    return w
  }

  const housekeepingRecord = (unitId: string): HousekeepingRecord => {
    let record = s.housekeeping.find((h) => h.unitId === unitId)
    if (!record) {
      record = { unitId, state: 'ready', updatedOn: today(), updatedBy: user().name, note: '', lastInspection: null }
      s.housekeeping.push(record)
    }
    return record
  }

  /** Large hand-written cash-outs, and every petty cash spend, go for approval only with a receipt attached. */
  function assertProof(t: Pick<Transaction, 'accountId' | 'kind' | 'amount' | 'origin' | 'attachments'>) {
    const petty = s.cashAccounts.find((a) => a.id === t.accountId)?.kind === 'petty'
    if (needsProof(t, s.proofPolicy, petty)) throw new RuleError('PROOF_REQUIRED', petty ? 'Attach the receipt: every petty cash spend needs one.' : `Attach a receipt or invoice: cash-outs from Rp ${s.proofPolicy.threshold.toLocaleString('id-ID')} need proof before approval.`)
  }

  function assertFiles(files: readonly Attachment[]) {
    if (files.length > MAX_ATTACHMENTS) throw new RuleError('ATTACHMENT_COUNT', `Attach at most ${MAX_ATTACHMENTS} files.`)
    for (const f of files) {
      const problem = f.size > 0 || f.url ? uploadProblem(f) : null
      if (problem) throw new RuleError(problem.code, problem.message)
    }
  }

  function newTransaction(fields: Omit<Transaction, 'id' | 'number' | 'status' | 'approvals' | 'history' | 'rejectionReason' | 'reversalOf' | 'reversedBy' | 'createdBy' | 'createdById' | 'createdOn'>, submit: boolean, me: User = user()): Transaction {
    assertFiles(fields.attachments)
    if (submit) assertProof(fields)
    // An entry on a cashbox with a shift open carries the shift; the count's own adjustment stays off it.
    const shift = fields.shiftId === undefined && fields.origin !== 'reconciliation' ? openShiftOn(s.cashierShifts, fields.accountId) : null
    const n = seq('transaction')
    const t: Transaction = {
      ...fields,
      ...(shift ? { shiftId: shift.id } : {}),
      id: `tx-${n}`,
      number: `TX-${2400 + n}`,
      status: submit ? 'submitted' : 'draft',
      approvals: [],
      history: submit ? [event('created', '', me), event('submitted', '', me)] : [event('created', '', me)],
      rejectionReason: null,
      reversalOf: null,
      reversedBy: null,
      createdBy: me.name,
      createdById: me.id,
      createdOn: today(),
    }
    s.transactions.push(t)
    log('create', 'transaction', t.number, `${submit ? 'Submitted' : 'Drafted'} ${t.number}, ${t.description}`, null, { amount: t.amount, kind: t.kind }, me)
    return t
  }

  /** Puts corrected fields on a rejected cash-out and sends it back to the first approval level. */
  function resubmit(t: Transaction, fields: Partial<Transaction>, note: string, me: User = user()) {
    if (t.status !== 'rejected') throw new RuleError('TRANSACTION_INVALID_STATE', `${t.number} is ${t.status}; only a rejected cash-out can be corrected.`)
    const next = { ...t, ...fields }
    assertFiles(next.attachments)
    assertProof(next)
    Object.assign(t, fields)
    t.status = 'submitted'
    t.approvals = []
    t.rejectionReason = null
    t.history = [...t.history, event('resubmitted', note, me)]
  }

  /** Both halves of a transfer move together through approval and posting. */
  function syncTwin(t: Transaction) {
    if (!t.transferId) return
    const twin = s.transactions.find((o) => o.transferId === t.transferId && o.id !== t.id)
    if (!twin) return
    twin.status = t.status
    twin.approvals = copy(t.approvals)
    twin.history = copy(t.history)
    twin.rejectionReason = t.rejectionReason
  }

  /** A work order expense shows the receipts of its ledger entry. */
  function syncReceipts(t: Transaction) {
    for (const w of s.workOrders) {
      if (w.expenses.some((e) => e.transactionId === t.id)) w.expenses = w.expenses.map((e) => (e.transactionId === t.id ? { ...e, receipts: [...t.attachments] } : e))
    }
  }

  const employee = (id: string) => findById(s.employees, id, 'employee')
  const shiftFor = (employeeId: string, date: string) => {
    const a = s.assignments.find((x) => x.employeeId === employeeId && x.date === date)
    return a?.shiftId ? (s.shifts.find((x) => x.id === a.shiftId) ?? null) : null
  }
  const decide = <T extends { status: string; decidedOn: string | null; decidedBy: string; decisionNote: string; number: string }>(row: T, to: 'approved' | 'rejected' | 'cancelled', note: string, entity: string) => {
    if (!REQUEST_TRANSITIONS[row.status as keyof typeof REQUEST_TRANSITIONS]?.includes(to)) throw new RuleError('REQUEST_INVALID_STATE', `${row.number} is ${row.status}; it can no longer change.`)
    if (to === 'rejected' && note.trim().length < 3) throw new RuleError('VALIDATION_ERROR', 'Say why the request is rejected.')
    const before = row.status
    row.status = to
    row.decidedOn = today()
    row.decidedBy = user().name
    row.decisionNote = note.trim()
    log(to === 'approved' ? 'approve' : to === 'rejected' ? 'reject' : 'status', entity, row.number, `${to.charAt(0).toUpperCase() + to.slice(1)} ${row.number}`, { status: before }, { status: to })
  }

  function computePeriodLines(p: PayrollPeriod, keepAdjustments: readonly PayrollLine[] = p.lines): PayrollLine[] {
    const from = `${p.month}-01`
    const staff = s.employees.filter((e) => e.status !== 'inactive' || (e.leftOn && e.leftOn > from))
    const eligible = staff.filter((e) => e.serviceChargeEligible).length
    // The pool is the service charge the books collected in the month, on Service charge payable.
    const pool = payableBilled(s.journals, GL.servicePayable, p.month)
    const share = serviceChargeShare(pool, s.payrollSettings, eligible)
    p.revenueBase = pool
    return staff.map((e) => computeLine({ employee: e, settings: s.payrollSettings, month: p.month, attendance: s.attendance, overtime: s.overtime, loans: s.loans, adjustments: keepAdjustments.find((l) => l.employeeId === e.id)?.adjustments ?? [], serviceCharge: share }))
  }



  /** The ledger fields of a work order expense: cash from the location cashbox, transfers from the bank. */
  function expenseFields(w: WorkOrder, input: ExpenseInput) {
    const villa = catalog().villa(w.villaId)
    const box = s.cashAccounts.find((a) => a.kind === 'cashbox' && a.locationId === villa.locationId)
    const bank = s.cashAccounts.find((a) => a.kind === 'bank')
    const account = input.method === 'cash' ? (box ?? bank) : (bank ?? box)
    if (!account) throw new RuleError('VALIDATION_ERROR', 'No account to pay from.')
    return { accountId: account.id, amount: input.amount, date: input.paidOn, locationId: villa.locationId, villaId: w.villaId, unitId: w.unitId, description: `${w.number} ${EXPENSE_KIND_LABEL[input.kind].toLowerCase()}: ${input.description.trim()}, ${input.payee.trim()}`, attachments: [...input.receipts] }
  }
  /** Payment rules that need the whole table: totals, derived booking fields, ledger entries. */
  /** What the guest pays for the room: the price with service and PB1 added when it reads net. */
  const stayTotal = (b: Booking) => stayTax(b, s.tax).total
  const expectedOf = (b: Booking) => (b.source === 'airbnb' ? stayTotal(b) - b.airbnbFee : stayTotal(b))
  const paidOf = (b: Booking) => netPaid(s.payments, b.id)
  /** Keeps the booking's paymentStatus and paidAmount in step with its payments. */
  function syncBooking(bookingId: string) {
    const b = findById(s.bookings, bookingId, 'booking')
    const total = stayTotal(b)
    const paid = b.source === 'airbnb' ? (paidOf(b) >= expectedOf(b) ? total : paidOf(b)) : paidOf(b)
    b.paidAmount = Math.max(0, paid)
    b.paymentStatus = settledStatus(b.paidAmount, total)
  }
  const accountFor = (b: Booking, method: PaymentMethod) => {
    const locationId = catalog().place(b.unitId).location.id
    const box = s.cashAccounts.find((a) => a.kind === 'cashbox' && a.locationId === locationId)
    const bank = s.cashAccounts.find((a) => a.kind === 'bank') ?? s.cashAccounts[0]
    const account = method === 'cash' ? (box ?? bank) : bank
    if (!account) throw new RuleError('VALIDATION_ERROR', 'No account to record the money in.')
    return account
  }
  /** The money of a paid payment lands in the ledger: cash-in (or cash-out for a refund), plus the gateway fee. */
  function bookMoney(p: Payment, actor: User, attachments: readonly Attachment[] = []) {
    const b = findById(s.bookings, p.bookingId, 'booking')
    const place = catalog().place(b.unitId)
    const guest = s.guests.find((g) => g.id === b.guestId)?.name ?? ''
    const account = accountFor(b, p.method)
    const base = { accountId: account.id, date: today(), locationId: place.location.id, villaId: place.villa.id, unitId: b.unitId, bookingId: b.id, reference: p.number, transferId: null }
    const refund = p.kind === 'refund'
    const origin = p.method === 'cash' ? 'front_desk' : 'payment'
    if (forOrders(p) && !refund) {
      // Room service income lands per category, so the P&L shows food, spa and tours apart.
      const orders = (p.orderIds ?? []).map((id) => findById(s.orders, id, 'order'))
      const split = new Map<string, number>()
      for (const o of orders) for (const r of revenueSplit(o)) split.set(r.categoryId, (split.get(r.categoryId) ?? 0) + r.amount)
      // A rebate before payment leaves less to pay than the charge: each category takes its share of what was paid.
      const charged = [...split.values()].reduce((sum, v) => sum + v, 0)
      if (charged !== p.amount && charged > 0) {
        const parts = [...split].map(([categoryId, amount]) => [categoryId, Math.floor((amount * p.amount) / charged)] as const)
        const [first] = parts
        split.clear()
        parts.forEach(([categoryId, amount]) => split.set(categoryId, amount + (categoryId === first?.[0] ? p.amount - parts.reduce((sum, x) => sum + x[1], 0) : 0)))
        for (const [categoryId, amount] of split) if (amount <= 0) split.delete(categoryId)
      }
      const ids = [...split].map(([categoryId, amount], i) => newTransaction({ ...base, attachments: i === 0 ? attachments : [], kind: 'cash_in', categoryId, amount, description: `Room service ${orders.map((o) => o.number).join(', ')}, ${b.code} ${guest}`, origin }, true, actor).id)
      p.transactionId = ids[0] ?? null
      p.extraTransactionIds = ids.slice(1)
    } else {
      const t = newTransaction({ ...base, attachments, kind: refund ? 'cash_out' : 'cash_in', categoryId: refund ? 'cat-other' : p.method === 'airbnb_payout' ? 'cat-airbnb' : 'cat-room', amount: p.amount, description: `${PAYMENT_KIND_LABEL[p.kind]} ${p.number}, ${b.code} ${guest}`, origin }, true, actor)
      p.transactionId = t.id
    }
    if (p.gatewayFee > 0) {
      const fee = newTransaction({ ...base, attachments: [], kind: 'cash_out', categoryId: 'cat-fees', amount: p.gatewayFee, description: `${PAYMENT_METHOD_LABEL[p.method]} fee on ${p.number}`, origin: 'payment' }, true, actor)
      p.feeTransactionId = fee.id
    }
  }
  /** The shares of one group payment land as one cash-in, the money the group paid, and one fee entry. */
  function bookBatch(shares: readonly Payment[], actor: User, attachments: readonly Attachment[] = []) {
    const [first] = shares
    if (!first) return
    const b = findById(s.bookings, first.bookingId, 'booking')
    const group = groupOf(b)
    const place = catalog().place(b.unitId)
    const account = accountFor(b, first.method)
    const base = { accountId: account.id, date: today(), locationId: place.location.id, villaId: place.villa.id, unitId: null, bookingId: b.id, reference: first.batch ?? first.number, transferId: null, origin: first.method === 'cash' ? ('front_desk' as const) : ('payment' as const) }
    const codes = shares.map((p) => findById(s.bookings, p.bookingId, 'booking').code).join(', ')
    const t = newTransaction({ ...base, attachments, kind: 'cash_in', categoryId: 'cat-room', amount: shares.reduce((sum, p) => sum + p.amount, 0), description: `Group ${PAYMENT_KIND_LABEL[first.kind].toLowerCase()} ${first.batch}, ${group?.code ?? ''} ${group?.name ?? ''}: ${codes}` }, true, actor)
    const fee = shares.reduce((sum, p) => sum + p.gatewayFee, 0)
    const feeEntry = fee > 0 ? newTransaction({ ...base, attachments: [], kind: 'cash_out', categoryId: 'cat-fees', amount: fee, description: `${PAYMENT_METHOD_LABEL[first.method]} fee on ${first.batch}`, origin: 'payment' }, true, actor) : null
    for (const p of shares) {
      p.transactionId = t.id
      p.feeTransactionId = feeEntry?.id ?? null
    }
  }
  /** Pending links past their expiry turn expired when read. */
  function expireLinks() {
    const now = clockNow()
    for (const l of s.paymentLinks) {
      if (l.status !== 'pending' || l.expiresAt > now) continue
      l.status = 'expired'
      for (const p of linkPayments(l)) {
        if (p.status !== 'pending') continue
        p.status = 'expired'
        p.history = [...p.history, { kind: 'expired', by: GATEWAY.name, at: now, note: 'Link expired unpaid' }]
      }
    }
  }
  /** Every payment a link pays: its own, then those bundled into a settle link. */
  const linkPayments = (l: PaymentLink) => [l.paymentId, ...(l.bundle ?? [])].map((id) => findById(s.payments, id, 'payment'))
  /** A settle link still waiting for the guest; the stay checks out when it is paid. */
  const pendingSettle = (bookingId: string) => s.paymentLinks.find((l) => l.bookingId === bookingId && l.status === 'pending' && l.checkOut)
  /** The group a stay belongs to, when it has one. */
  const groupOf = (b: Pick<Booking, 'bookingGroupId'>) => (b.bookingGroupId ? s.bookingGroups.find((g) => g.id === b.bookingGroupId) : undefined)
  /** The stay's folio, read from the live tables; a master-billed group carries its room lines. */
  const folioOf = (b: Booking, whole = false) => guestFolio({ booking: b, payments: s.payments, orders: s.orders, postings: s.folioPostings, roomOnMaster: !whole && groupOf(b)?.billing === 'master', tax: s.tax })
  /** The last stay of a master-billed group leaves only once the master folio is paid. */
  function assertMasterSettled(b: Booking) {
    const group = groupOf(b)
    if (group?.billing !== 'master') return
    const stays = s.bookings.filter((x) => x.bookingGroupId === group.id)
    if (!closesGroup(stays, b.id)) return
    const { due } = masterFolio(stays.map((x) => ({ booking: x, folio: folioOf(x, true) })), s.payments)
    if (due > 0) throw new RuleError('GROUP_MASTER_OPEN', `${b.code} is the last stay of ${group.code}; the master folio still has Rp ${due.toLocaleString('id-ID')} to pay. Take it on the group page first.`)
  }
  /** Postings go on a stay in house whose bill is not out on a check-out link. */
  function folioStay(bookingId: string) {
    const b = findById(s.bookings, bookingId, 'booking')
    if (b.status !== 'checked_in') throw new RuleError('BOOKING_INVALID_STATE', `${b.code} is not in house; post to the folio during the stay.`)
    if (pendingSettle(b.id)) throw new RuleError('SETTLEMENT_PENDING', `${b.code} has a check-out link waiting for the guest; cancel it before changing the bill.`)
    return b
  }
  function addPosting(b: Booking, fields: Pick<FolioPosting, 'kind' | 'code' | 'description' | 'amount' | 'service' | 'pb1' | 'approvedBy' | 'part' | 'lineId' | 'orderId'>, me: User) {
    const posting: FolioPosting = { ...fields, id: `fp-${seq('folio')}`, bookingId: b.id, description: fields.description.trim(), date: today(), postedBy: me.name, postedById: me.id, postedAt: clockNow(), transactionId: null }
    ledger.recordCharge(b, posting)
    s.folioPostings.push(posting)
    log('create', 'folio', b.code, `Posted a ${fields.code} ${fields.kind} of ${fields.amount} on ${b.code}${fields.lineId ? ` against ${fields.lineId}` : ''}: ${posting.description}`, null, { amount: fields.amount, code: fields.code }, me)
    return copy(posting)
  }
  /** What an order still asks of the guest: its charge less the rebates posted on it. */
  const orderDue = (o: ServiceOrder) => orderTotals(o).charge - s.folioPostings.filter((p) => p.kind === 'rebate' && p.orderId === o.id).reduce((sum, p) => sum + postingGross(p), 0)
  /** Runs a multi-step change all or nothing: a refusal halfway puts every table back. */
  function atomically<T>(change: () => T): T {
    const saved = structuredClone(snapshot(s))
    try {
      return change()
    } catch (error) {
      restore(s, saved)
      throw error
    }
  }
  /** Closes a stay: departure record, deposit back from the cashbox, departure charges in, room to housekeeping. */
  function closeStay(b: Booking, details: CheckOutDetails, actor: User, paidBy?: PaymentMethod) {
    const place = catalog().place(b.unitId)
    const guest = s.guests.find((g) => g.id === b.guestId)?.name ?? ''
    const cashbox = accountFor(b, 'cash')
    const base = { date: today(), locationId: place.location.id, villaId: place.villa.id, unitId: b.unitId, bookingId: b.id, reference: b.code, transferId: null, attachments: [] }
    b.status = 'checked_out'
    b.checkedOutOn = today()
    b.departure = { ...details, notes: details.notes.trim() }
    if (details.depositReturned > 0) newTransaction({ ...base, accountId: cashbox.id, kind: 'cash_out', categoryId: 'cat-other', amount: details.depositReturned, description: `Deposit returned, ${b.code} ${guest}`, origin: 'front_desk' }, true, actor)
    const account = paidBy ? accountFor(b, paidBy) : cashbox
    const extra = { ...base, accountId: account.id, kind: 'cash_in' as const, categoryId: 'cat-extra', origin: account.kind === 'bank' ? ('payment' as const) : ('front_desk' as const) }
    if (details.extraCharges > 0) newTransaction({ ...extra, amount: details.extraCharges, description: `Departure charges, ${b.code} ${guest}` }, true, actor)
    // Folio charges less their rebates land the same way as departure charges, one cash-in for what is open.
    const open = s.folioPostings.filter((p) => p.bookingId === b.id && p.part === 'charges' && !p.transactionId)
    const folioCharges = folioOf(b).due.charges
    if (folioCharges > 0) {
      const t = newTransaction({ ...extra, amount: folioCharges, description: `Folio charges, ${b.code} ${guest}: ${open.filter((p) => p.kind === 'charge').map((p) => p.description).join(', ')}` }, true, actor)
      for (const p of open) Object.assign(p, { transactionId: t.id, paidBy: paidBy ?? 'cash' })
    }
    ledger.recordStay(b)
    guestMessages.onStatus(b)
    const record = housekeepingRecord(b.unitId)
    if (record.state === 'dirty' || canMoveHousekeeping(record.state, 'dirty')) Object.assign(record, { state: 'dirty', updatedOn: today(), updatedBy: actor.name, note: `Checked out ${b.code}` })
    log('status', 'booking', b.code, `Checked out ${b.code}`, { status: 'checked_in' }, { status: 'checked_out', extraCharges: details.extraCharges }, actor)
  }
  function newPayment(b: Booking, fields: Pick<Payment, 'kind' | 'method' | 'amount' | 'status' | 'reference' | 'payer' | 'note'> & Partial<Payment>, actor: User): Payment {
    // Money the desk takes or gives back goes on the shift open at the stay's cashbox; the guest paying online does not.
    const desk = actor.id === GUEST.id || actor.id === GATEWAY.id ? null : openShiftOn(s.cashierShifts, accountFor(b, 'cash').id)
    const n = seq('payment')
    const p: Payment = {
      ...(desk ? { shiftId: desk.id } : {}),
      id: `pay-${n}-${b.id}`,
      number: `PAY-${5000 + n}`,
      bookingId: b.id,
      dueOn: null,
      paidOn: null,
      transactionId: null,
      feeTransactionId: null,
      gatewayFee: 0,
      refundOf: null,
      createdBy: actor.name,
      createdOn: today(),
      history: [{ kind: 'created', by: actor.name, at: clockNow(), note: '' }],
      ...fields,
    }
    // An order payment records what it pays for each order, after any rebate.
    if (p.orderIds?.length && p.kind !== 'refund' && !p.orderAmounts) p.orderAmounts = p.orderIds.map((id) => orderDue(findById(s.orders, id, 'order')))
    s.payments.push(p)
    return p
  }
  function checkoutOf(l: PaymentLink): PublicCheckout {
    const b = findById(s.bookings, l.bookingId, 'booking')
    const p = findById(s.payments, l.paymentId, 'payment')
    const place = catalog().place(b.unitId)
    // A group link pays every stay's share at once: it shows the group and the whole amount.
    const group = p.groupId ? s.bookingGroups.find((g) => g.id === p.groupId) : undefined
    return {
      link: copy(l),
      paymentNumber: p.number,
      paymentStatus: p.status,
      kind: p.kind,
      guestName: s.guests.find((g) => g.id === b.guestId)?.name ?? '',
      villaName: place.villa.name,
      locationName: place.location.name,
      unitCode: place.unit.code,
      unitName: place.unit.name,
      checkIn: b.checkIn,
      checkOut: b.checkOut,
      nights: daysBetween(b.checkIn, b.checkOut),
      bookingCode: group ? `${group.code} ${group.name}` : b.code,
      total: l.checkOut || group ? l.amount : forOrders(p) ? p.amount : stayTotal(b),
      paidBefore: l.checkOut || group || forOrders(p) ? 0 : b.paidAmount - (p.status === 'paid' ? p.amount : 0),
      paidOn: p.paidOn,
      reference: p.reference,
      ...(forOrders(p) ? { orderNumbers: (p.orderIds ?? []).map((id) => findById(s.orders, id, 'order').number) } : {}),
      ...(l.checkOut ? { lines: settleLinesOf(linkPayments(l), l.checkOut.details.extraCharges, l.checkOut.folioCharges) } : {}),
      ...(forOrders(p) ? {} : { taxNote: taxNote(stayTax(b, s.tax)) }),
    }
  }
  /** What a set of payments covers, as the check-out bill reads. */
  function settleLinesOf(payments: readonly Payment[], charges: number, folioCharges = 0) {
    const room = payments.filter((p) => !forOrders(p)).reduce((sum, p) => sum + p.amount, 0)
    const orders = payments.flatMap((p) => (p.orderIds ?? []).map((id) => findById(s.orders, id, 'order')))
    const paidFor = new Map(payments.flatMap((p) => (p.orderIds ?? []).map((id, i) => [id, p.orderAmounts?.[i] ?? p.amount] as const)))
    return settlementLines(room, orders.map((o) => ({ number: o.number, items: o.lines.map((x) => `${x.quantity} × ${x.name}`).join(', '), amount: paidFor.get(o.id) ?? orderDue(o) })), charges, folioCharges)
  }

  /** A pending payment and its gateway link; the guest pays it at /pay/:token. */
  /** A group share names its own stay and carries the group's id and batch. */
  type LinkPart = { kind: PaymentKind; amount: number; orderIds?: readonly string[]; bookingId?: string; group?: Pick<Payment, 'groupId' | 'batch'> }
  /**
   * `settle` pays further parts with the same token. With `checkOut` it is a check-out link that checks the stay out
   * once paid, departure charges riding on the first part's fee; without, it pays the shares of a group payment.
   */
  function openLink(b: Booking, input: LinkPart & { method: PaymentMethod; payer: string }, actor: User, settle?: { also: readonly LinkPart[]; checkOut?: NonNullable<PaymentLink['checkOut']> }): PaymentLink {
    const n = seq('link')
    const token = `pl${n}${b.id.replace(/[^a-z0-9]/gi, '')}${(n * 2654435761 % 1_000_000).toString(36)}`
    const charges = (settle?.checkOut?.details.extraCharges ?? 0) + (settle?.checkOut?.folioCharges ?? 0)
    const parts = [input, ...(settle?.also ?? [])]
    const payments = parts.map((part, i) => {
      const fee = gatewayFee(input.method, part.amount + (i === 0 ? charges : 0), s.paymentPolicy)
      const stay = part.bookingId ? findById(s.bookings, part.bookingId, 'booking') : b
      const p = newPayment(stay, { kind: part.kind, method: input.method, amount: part.amount, status: 'pending', reference: input.method === 'virtual_account' ? vaNumberFor(token) : '', payer: input.payer.trim(), note: '', dueOn: part.kind === 'balance' && !settle ? balanceDueOn(b.checkIn, s.paymentPolicy) : today(), gatewayFee: fee, ...(part.orderIds?.length ? { orderIds: [...part.orderIds] } : {}), ...part.group }, actor)
      p.history = [...p.history, { kind: 'link_sent', by: actor.name, at: clockNow(), note: `/pay/${token}` }]
      for (const id of part.orderIds ?? []) findById(s.orders, id, 'order').paymentId = p.id
      return p
    })
    const p = payments[0]!
    const amount = parts.reduce((sum, x) => sum + x.amount, 0) + charges
    const link: PaymentLink = {
      token,
      bookingId: b.id,
      paymentId: p.id,
      method: input.method,
      amount,
      createdAt: clockNow(),
      expiresAt: new Date(Date.parse(`${clockNow()}Z`) + s.paymentPolicy.linkExpiryHours * 3_600_000).toISOString().slice(0, 19),
      status: 'pending',
      vaBank: input.method === 'virtual_account' ? 'BCA' : '',
      vaNumber: input.method === 'virtual_account' ? vaNumberFor(token) : '',
      qrPayload: input.method === 'qris' ? qrPayloadFor(token, amount) : '',
      gatewayFee: payments.reduce((sum, x) => sum + x.gatewayFee, 0),
      proofs: [],
      ...(settle ? { bundle: payments.slice(1).map((x) => x.id), ...(settle.checkOut ? { checkOut: settle.checkOut } : {}) } : {}),
    }
    s.paymentLinks.push(link)
    log('create', 'payment', p.number, `Sent a ${PAYMENT_METHOD_LABEL[input.method]} link for ${p.number} on ${b.code}`, null, null, actor)
    return link
  }

  /** Minutes since midnight now, for lead times and late orders. */
  const minuteNow = () => {
    const now = new Date()
    return now.getHours() * 60 + now.getMinutes()
  }

  /** Two linked entries, submitted together; returns the cash-out half. `shiftId: null` keeps them off any open shift. */
  function transferCash(input: CashTransferInput, shiftId?: string | null) {
    refuse(validateTransfer(input, s.cashAccounts))
    const from = findById(s.cashAccounts, input.fromAccountId, 'account')
    const to = findById(s.cashAccounts, input.toAccountId, 'account')
    const transferId = `trf-${seq('transfer')}`
    const locationId = from.locationId ?? to.locationId ?? s.locations[0]?.id ?? ''
    const base = { amount: input.amount, date: input.date, locationId, villaId: null, unitId: null, bookingId: null, description: input.description.trim(), reference: input.reference.trim(), attachments: [], origin: 'transfer' as const, transferId, ...(shiftId === undefined ? {} : { shiftId }) }
    const out = newTransaction({ ...base, accountId: from.id, kind: 'cash_out', categoryId: 'cat-transfer-out' }, true)
    const back = newTransaction({ ...base, accountId: to.id, kind: 'cash_in', categoryId: 'cat-transfer-in' }, true)
    back.approvals = out.approvals
    return out
  }

  /** A cash count against what the account should hold; the difference may go for approval as an adjustment. */
  function recordCount(account: CashAccount, input: { date: string; expected: number; counted: number; note: string; adjust: boolean; by: string; shiftId?: string }) {
    const difference = input.counted - input.expected
    let adjustmentId: string | null = null
    if (input.adjust && difference !== 0) {
      const kind = difference > 0 ? 'cash_in' : 'cash_out'
      adjustmentId = newTransaction({ accountId: account.id, kind, categoryId: kind === 'cash_in' ? 'cat-adjust-in' : 'cat-adjust-out', amount: Math.abs(difference), date: input.date, locationId: account.locationId ?? s.locations[0]?.id ?? '', villaId: null, unitId: null, bookingId: null, description: `Cash count ${difference > 0 ? 'over' : 'short'} on ${input.date}${input.note.trim() ? `: ${input.note.trim()}` : ''}`, reference: '', attachments: [], origin: 'reconciliation', transferId: null }, true).id
    }
    const r: Reconciliation = { id: `rec-${seq('reconciliation')}`, accountId: account.id, date: input.date, expected: input.expected, counted: input.counted, difference, note: input.note.trim(), by: input.by, adjustmentId, ...(input.shiftId ? { shiftId: input.shiftId } : {}) }
    s.reconciliations.push(r)
    log('create', 'reconciliation', r.id, `Counted ${account.name}: ${difference === 0 ? 'matched' : difference > 0 ? `over by ${difference}` : `short by ${-difference}`}`)
    return r
  }

  const stock = createStockAdapter({ s, later, today, clockNow, minuteNow, user, seq, refuse, log, newTransaction, resubmit, event })
  const housekeeping = createHousekeepingAdapter({ s, later, atomically, today, clockNow, user, seq, refuse, log, newTransaction, newWorkOrder, housekeepingRecord, writeOff: stock.writeOff, logLostItem: guests.logFind })
  const guestMessages = createMessagingAdapter({ s, later, copy, today, clockNow, seq, user, refuse, log, owedOn: (b) => expectedOf(b) - paidOf(b), openLink, guestActor: GUEST, ports: () => ports })

  function assertMenuEditor() {
    const me = user()
    if (!can(s.permissions, me.role, 'services', 'catalog')) throw new RuleError('FORBIDDEN', `${ROLE_LABEL[me.role]} cannot edit the room service menu.`)
    return me
  }

  /** The delivered, unpaid orders a payment settles; the amount must be what they still ask, their charge less rebates. */
  function ordersToSettle(b: Booking, orderIds: readonly string[], amount: number) {
    const list = orderIds.map((id) => findById(s.orders, id, 'order'))
    for (const o of list) {
      if (o.bookingId !== b.id) throw new RuleError('VALIDATION_ERROR', `${o.number} belongs to another stay.`)
      const state = payState(o, s.payments)
      if (state !== 'unpaid' || orderDue(o) <= 0) throw new RuleError('ORDER_NOT_BILLABLE', state === 'not_due' ? `${o.number} is not delivered yet.` : state === 'paid' ? `${o.number} is already paid.` : state === 'pending' ? `${o.number} already has a payment link open.` : `${o.number} has nothing to pay.`)
    }
    const due = list.reduce((sum, o) => sum + orderDue(o), 0)
    if (amount !== due) throw new RuleError('VALIDATION_ERROR', `The orders come to ${due}; take that amount.`)
    return list
  }

  /**
   * A delivery made by mistake, undone on its business day: the revenue and partner costs reversed,
   * the partner bills withdrawn and the minibar stock back in the store. Later, only a rebate corrects it.
   */
  function voidDelivery(o: ServiceOrder, note: string, me: User) {
    if (note.trim().length < 3) throw new RuleError('VALIDATION_ERROR', 'Say why the delivery is voided.')
    if (o.deliveredOn !== s.businessDate) throw new RuleError('VOID_DAY_CLOSED', `${o.number} was delivered on ${o.deliveredOn}, a business day already closed; post a rebate on its line instead.`)
    const state = payState(o, s.payments)
    if (state === 'paid' || state === 'pending') throw new RuleError('ORDER_VOID_PAID', `${o.number} is ${state === 'paid' ? 'paid' : 'on a payment link'}; post a rebate and refund the guest instead.`)
    if (s.folioPostings.some((p) => p.orderId === o.id)) throw new RuleError('ORDER_VOID_PAID', `${o.number} already has a rebate; post another rebate instead.`)
    const bills = o.costTransactionIds.map((id) => findById(s.transactions, id, 'transaction'))
    if (bills.some((t) => t.status === 'posted')) throw new RuleError('ORDER_VOID_PAID', `A partner bill of ${o.number} is already paid; post a rebate instead.`)
    for (const t of bills) Object.assign(t, { status: 'rejected', rejectionReason: `${o.number} voided`, history: [...t.history, event('rejected', `${o.number} voided: ${note.trim()}`, me)] })
    stock.unsell(o, me)
    ledger.recordVoid(o)
  }

  function markOrdersPaid(p: Payment, actor: User) {
    for (const id of p.orderIds ?? []) {
      const o = findById(s.orders, id, 'order')
      o.paymentId = p.id
      o.history = [...o.history, { kind: 'paid', by: actor.name, at: clockNow(), note: `${p.number}, ${PAYMENT_METHOD_LABEL[p.method]}` }]
    }
  }

  /** Staff and guests order through the same rules: a stay in house, items served at that time, free items only with permission. */
  function placeOrder(input: OrderInput, actor: User, placedBy: 'guest' | 'staff'): ServiceOrder {
    refuse(validateOrder(input))
    const b = findById(s.bookings, input.bookingId, 'booking')
    if (!orderableStay(b, today())) throw new RuleError('ORDER_NO_STAY', `${b.code} is not in house or arriving within ${ORDER_ARRIVAL_DAYS} days; room service is for staying guests.`)
    if (input.requestedOn > b.checkOut) throw new RuleError('ORDER_NO_STAY', `${b.code} checks out on ${b.checkOut}; pick a time during the stay.`)
    const place = catalog().place(b.unitId)
    const now = minuteNow()
    const lines = input.lines.map((l) => {
      const item = findById(s.menu, l.itemId, 'menu item')
      if (item.villaId !== place.villa.id) throw new RuleError('ITEM_UNAVAILABLE', `${item.name} is not on the ${place.villa.name} menu.`)
      const problem = itemProblem(item, input.requestedOn, input.requestedAt, today(), now)
      if (problem) throw new RuleError(problem.code, problem.message)
      return { itemId: item.id, name: item.name, category: item.category, unit: item.unit, price: item.price, quantity: l.quantity, costPrice: item.costPrice, partnerId: item.partnerId, comp: placedBy === 'staff' && Boolean(l.comp) }
    })
    if (lines.some((l) => l.comp) && !can(s.permissions, actor.role, 'services', 'comp')) throw new RuleError('COMP_FORBIDDEN', `${ROLE_LABEL[actor.role]} cannot give items for free. Ask a villa manager.`)
    if (input.discountPct > 0) {
      if (placedBy === 'guest') throw new RuleError('FORBIDDEN', 'Guests order at menu prices.')
      if (input.discountPct > s.paymentPolicy.discountLimitPct && !can(s.permissions, actor.role, 'booking', 'approve'))
        throw new RuleError('DISCOUNT_LIMIT', `${input.discountPct}% off is past the ${s.paymentPolicy.discountLimitPct}% limit. Ask a villa manager to give it.`)
    }
    const n = seq('order')
    const order: ServiceOrder = {
      id: `so-${n}`,
      number: `SO-${700 + n}`,
      bookingId: b.id,
      unitId: b.unitId,
      villaId: place.villa.id,
      lines,
      note: input.note.trim(),
      requestedOn: input.requestedOn,
      requestedAt: input.requestedAt,
      priority: input.priority,
      status: 'new',
      assignee: '',
      placedBy,
      createdOn: today(),
      deliveredOn: null,
      deliveredAt: null,
      discountPct: input.discountPct,
      discountReason: input.discountPct > 0 ? input.discountReason.trim() : '',
      compReason: lines.some((l) => l.comp) ? input.compReason.trim() : '',
      paymentId: null,
      costTransactionIds: [],
      history: [{ kind: 'placed', by: actor.name, at: clockNow(), note: input.note.trim() }],
    }
    s.orders.push(order)
    log('create', 'service-order', order.number, `${placedBy === 'guest' ? 'Guest ordered' : 'Ordered'} ${orderSummary(order)} for ${b.code}`, null, { charge: orderTotals(order).charge }, actor)
    return order
  }

  /** The stay a room's QR code orders for: the guest in house, else the next arrival within the ordering window. */
  function stayInRoom(unitId: string): Booking | null {
    const mine = s.bookings.filter((b) => b.unitId === unitId && b.unitAssigned && orderableStay(b, today()))
    return mine.find((b) => b.status === 'checked_in') ?? [...mine].sort((a, b) => a.checkIn.localeCompare(b.checkIn))[0] ?? null
  }

  function roomByToken(token: string) {
    const unit = s.units.find((u) => orderTokenFor(u.code) === token)
    if (!unit) throw new NotFoundError('room menu', token)
    return unit
  }

  function publicMenu(token: string): PublicMenu {
    const unit = roomByToken(token)
    const place = catalog().place(unit.id)
    const stay = stayInRoom(unit.id)
    const orders = stay ? s.orders.filter((o) => o.bookingId === stay.id) : []
    const pending = stay ? s.paymentLinks.find((l) => l.bookingId === stay.id && l.status === 'pending' && forOrders(findById(s.payments, l.paymentId, 'payment'))) : undefined
    const guest = stay ? (s.guests.find((g) => g.id === stay.guestId)?.name ?? '') : ''
    return {
      token,
      villaName: place.villa.name,
      locationName: place.location.name,
      unitCode: unit.code,
      unitName: unit.name,
      stay: stay ? { bookingCode: stay.code, guestName: guest.split(' ')[0] ?? guest, checkIn: stay.checkIn, checkOut: stay.checkOut, status: stay.status } : null,
      items: copy(s.menu.filter((i) => i.villaId === unit.villaId && i.active)),
      orders: [...orders].reverse().map((o) => ({ number: o.number, status: o.status, lines: copy(o.lines), requestedOn: o.requestedOn, requestedAt: o.requestedAt, note: o.note, charge: orderTotals(o).charge, payState: payState(o, s.payments) })),
      outstanding: folio(orders, s.payments).unpaid.reduce((sum, o) => sum + Math.max(0, orderDue(o)), 0),
      payToken: pending?.token ?? null,
      today: today(),
    }
  }

  const ports: Ports = {
    clock,
    stock: stock.port,
    cashier: createCashierPort({ s, later, today, clockNow, user, seq, refuse, log, recordCount, transferCash }),
    housekeeping,
    budget: createBudgetPort({ s, later, today, user, refuse, log }),
    messaging: guestMessages.messaging,
    precheckin: guestMessages.precheckin,
    owners: createOwnerAdapter({ s, later, copy, today, seq, user, refuse, log, newTransaction: (fields, submit) => newTransaction(fields, submit), assertFree }),
    property: {
      locations: () => later(() => copy(s.locations)),
      villas: () => later(() => copy(s.villas)),
      units: () => later(() => copy(s.units)),
      groups: () => later(() => copy(s.groups)),
      createLocation: (input) =>
        later(() => {
          refuse(validateLocation(input))
          const location = { id: newId('loc', input.name), name: input.name.trim(), area: input.area.trim() }
          s.locations.push(location)
          log('create', 'location', location.id, `Added location ${location.name}`)
          return copy(location)
        }),
      updateLocation: (id, input) =>
        later(() => {
          refuse(validateLocation(input))
          const location = findById(s.locations, id, 'location')
          const before = { ...location }
          Object.assign(location, { name: input.name.trim(), area: input.area.trim() })
          log('update', 'location', id, `Edited location ${location.name}`, before, { ...location })
          return copy(location)
        }),
      createVilla: (input) =>
        later(() => {
          refuse(validateVilla(input, s.villas))
          findById(s.locations, input.locationId, 'location')
          const villa = { id: newId('vil', input.name), ...input, name: input.name.trim(), description: input.description.trim() }
          s.villas.push(villa)
          log('create', 'villa', villa.id, `Added villa ${villa.name}`)
          return copy(villa)
        }),
      createProperty: (input) =>
        later(() => {
          refuse(validateProperty(input, s.villas, s.units))
          findById(s.locations, input.villa.locationId, 'location')
          const villa = { id: newId('vil', input.villa.name), ...input.villa, name: input.villa.name.trim(), description: input.villa.description.trim() }
          const types = wizardTypes(input).map((t) => ({ ...t, group: { id: newId('grp', t.name), villaId: villa.id, name: t.name, interchangeable: t.interchangeable, operatorAssigns: t.operatorAssigns } }))
          const units = input.rooms.map((r, i) => ({
            id: `unit-${r.code.toLowerCase()}`,
            villaId: villa.id,
            groupId: types.find((t) => t.rooms.includes(i))?.group.id ?? null,
            code: r.code,
            name: r.name.trim(),
            bedrooms: r.bedrooms,
            nightlyRate: r.nightlyRate,
            status: 'active' as const,
            amenities: r.amenities,
          }))
          s.villas.push(villa)
          s.groups.push(...types.map((t) => t.group))
          s.units.push(...units)
          s.ratePlans.push(...types.map((t) => ({ groupId: t.group.id, ...t.plan, seasons: t.plan.seasons.map((x) => ({ ...x, name: x.name.trim() })) })))
          log('create', 'villa', villa.id, `Added villa ${villa.name} with ${units.length} units`)
          return copy(villa)
        }),
      updateVilla: (id, input) =>
        later(() => {
          refuse(validateVilla(input, s.villas, id))
          const villa = findById(s.villas, id, 'villa')
          const before = { ...villa }
          Object.assign(villa, { ...input, name: input.name.trim(), description: input.description.trim() })
          log('update', 'villa', id, `Edited villa ${villa.name}`, before, { ...villa })
          return copy(villa)
        }),
      createGroup: (input) =>
        later(() => {
          refuse(validateGroup(input))
          findById(s.villas, input.villaId, 'villa')
          const group = { id: newId('grp', input.name), ...input, name: input.name.trim() }
          s.groups.push(group)
          return copy(group)
        }),
      updateGroup: (id, input) =>
        later(() => {
          refuse(validateGroup(input))
          const group = findById(s.groups, id, 'unit group')
          const waiting = s.bookings.filter((b) => !b.unitAssigned && (b.status === 'confirmed' || b.status === 'draft') && catalog().unit(b.unitId).groupId === id)
          if (group.operatorAssigns && !input.operatorAssigns && waiting.length)
            throw new RuleError('ROOMS_TO_ASSIGN', `${waiting.map((b) => b.code).join(', ')} still wait for a room. Assign them first.`)
          Object.assign(group, { ...input, name: input.name.trim() })
          return copy(group)
        }),
      createUnit: (input) =>
        later(() => {
          refuse(validateUnit(input, s.units, s.groups))
          findById(s.villas, input.villaId, 'villa')
          const unit = { id: `unit-${input.code.toLowerCase()}`, ...input, name: input.name.trim() }
          s.units.push(unit)
          startPlan(unit)
          log('create', 'unit', unit.id, `Added unit ${unit.code}`)
          return copy(unit)
        }),
      updateUnit: (id, input) =>
        later(() => {
          refuse(validateUnit(input, s.units, s.groups, id))
          const unit = findById(s.units, id, 'unit')
          if (input.status === 'inactive' && unit.status !== 'inactive' && s.bookings.some((b) => b.unitId === id && b.unitAssigned && occupies(b) && b.checkOut > today()))
            throw new RuleError('UNIT_IN_USE', `${unit.code} still has confirmed stays. Move or cancel them first.`)
          const before = { status: unit.status, nightlyRate: unit.nightlyRate, name: unit.name }
          Object.assign(unit, { ...input, name: input.name.trim() })
          startPlan(unit)
          log('update', 'unit', id, `Edited unit ${unit.code}`, before, { status: unit.status, nightlyRate: unit.nightlyRate, name: unit.name })
          return copy(unit)
        }),
      ratePlans: () => later(() => copy(s.ratePlans)),
      saveRatePlan: (groupId, input) =>
        later(() => {
          const me = user()
          if (!can(s.permissions, me.role, 'property', 'edit')) throw new RuleError('FORBIDDEN', `${ROLE_LABEL[me.role]} cannot edit rate plans.`)
          refuse(validateRatePlan(input))
          const group = findById(s.groups, groupId, 'room type')
          const plan = { groupId, weekdayRate: input.weekdayRate, weekendRate: input.weekendRate, seasons: input.seasons.map((x) => ({ ...x, name: x.name.trim() })) }
          const before = s.ratePlans.find((p) => p.groupId === groupId)
          const summary = (p: RatePlan) => ({ weekdayRate: p.weekdayRate, weekendRate: p.weekendRate, seasons: p.seasons.length })
          s.ratePlans = [...s.ratePlans.filter((p) => p.groupId !== groupId), plan]
          log('update', 'rate_plan', groupId, `Priced ${group.name}: weekday ${plan.weekdayRate}, weekend ${plan.weekendRate}, ${plan.seasons.length} seasons`, before ? summary(before) : null, summary(plan))
          return copy(plan)
        }),
    },
    airbnb: {
      accounts: () => later(() => copy(s.accounts)),
      listings: () => later(() => copy(s.listings)),
      setListingStatus: (id, status) =>
        later(() => {
          const l = findById(s.listings, id, 'listing')
          l.status = status
          return copy(l)
        }),
      createAccount: (input) =>
        later(() => {
          refuse(validateAirbnbAccount(input, s.accounts))
          const account = { id: newId('acc', input.name), ...input, name: input.name.trim(), slot: Math.min(5, s.accounts.length + 2) }
          s.accounts.push(account)
          return copy(account)
        }),
      updateAccount: (id, input) =>
        later(() => {
          refuse(validateAirbnbAccount(input, s.accounts, id))
          const account = findById(s.accounts, id, 'Airbnb account')
          Object.assign(account, { ...input, name: input.name.trim() })
          return copy(account)
        }),
      createListing: (input) =>
        later(() => {
          refuse(validateListing(input, s.listings))
          findById(s.accounts, input.accountId, 'Airbnb account')
          const unit = catalog().unit(input.unitId)
          const listing = { id: `lst-${unit.code.toLowerCase()}`, ...input, title: input.title.trim(), dateRates: {} }
          s.listings.push(listing)
          return copy(listing)
        }),
      updateListing: (id, input) =>
        later(() => {
          refuse(validateListing(input, s.listings, id))
          const listing = findById(s.listings, id, 'listing')
          Object.assign(listing, { ...input, title: input.title.trim() })
          return copy(listing)
        }),
      setListingPrices: (id, input) =>
        later(() => {
          refuse(validateListingPrice(input))
          const listing = findById(s.listings, id, 'listing')
          const unit = findById(s.units, listing.unitId, 'unit')
          const before = { baseRate: unit.nightlyRate }
          unit.nightlyRate = input.baseRate
          const rates = { ...listing.dateRates }
          for (const [date, rate] of Object.entries(input.dateRates)) {
            if (rate === null || rate === input.baseRate) delete rates[date]
            else rates[date] = rate
          }
          listing.dateRates = rates
          log('update', 'listing', listing.id, `Priced ${unit.code}: base ${input.baseRate}, ${Object.keys(input.dateRates).length} nights changed`, before, { baseRate: input.baseRate })
          return copy(listing)
        }),
    },
    booking: {
      bookings: () => later(() => copy(s.bookings)),
      blocks: () => later(() => copy(s.blocks)),
      create: (input) => later(() => copy(createStay(input))),
      transition: (id, to) =>
        later(() => {
          const b = findById(s.bookings, id, 'booking')
          if (!canTransition(b, to)) throw new RuleError('BOOKING_INVALID_STATE', `A ${b.status.replace('_', ' ')} booking cannot become ${to.replace('_', ' ')}.`)
          if (to === 'confirmed') assertStayFree(b, b.checkIn, b.checkOut, b.id)
          if (to === 'checked_in' && !b.unitAssigned) throw new RuleError('UNIT_UNASSIGNED', `Assign a room to ${b.code} before checking in.`)
          if (to === 'checked_in') guests.assertCheckInReady(b)
          const before = b.status
          b.status = to
          if (to === 'checked_in') b.checkedInOn = today()
          if (to === 'checked_out') b.checkedOutOn = today()
          if (to === 'checked_out' || to === 'cancelled' || to === 'no_show') ledger.recordStay(b)
          guestMessages.onStatus(b)
          log('status', 'booking', b.code, `${b.code} ${before.replace('_', ' ')} to ${to.replace('_', ' ')}`, { status: before }, { status: to })
          return copy(b)
        }),
      checkIn: (id, details) =>
        later(() => {
          const b = findById(s.bookings, id, 'booking')
          if (!canTransition(b, 'checked_in')) throw new RuleError('BOOKING_INVALID_STATE', `A ${b.status.replace('_', ' ')} booking cannot be checked in.`)
          if (!b.unitAssigned) throw new RuleError('UNIT_UNASSIGNED', `Assign a room to ${b.code} before checking in.`)
          refuse(validateCheckIn(details))
          guests.assertCheckInReady(b)
          // Fewer adults registered than arrive is a warning on the audit trail, never a refusal.
          const unregistered = unregisteredAdults(details.adults, 1 + s.companions.filter((c) => c.bookingId === b.id && c.adult).length)
          b.status = 'checked_in'
          b.checkedInOn = today()
          b.arrival = { ...details, notes: details.notes.trim() }
          guestMessages.onStatus(b)
          log('status', 'booking', b.code, `Checked in ${b.code}${unregistered ? `; ${unregistered} of ${details.adults} adults not registered` : ''}`, { status: 'confirmed' }, { status: 'checked_in', deposit: details.deposit })
          return copy(b)
        }),
      checkOut: (id, details) =>
        later(() => {
          const b = findById(s.bookings, id, 'booking')
          if (!canTransition(b, 'checked_out')) throw new RuleError('BOOKING_INVALID_STATE', `A ${b.status.replace('_', ' ')} booking cannot be checked out.`)
          refuse(validateCheckOut(details, b.arrival?.deposit ?? 0))
          if (pendingSettle(b.id)) throw new RuleError('SETTLEMENT_PENDING', `${b.code} waits for the guest to pay the check-out link; the stay closes as soon as it is paid.`)
          const owed = folio(s.orders.filter((o) => o.bookingId === b.id), s.payments).unpaid.filter((o) => orderDue(o) > 0)
          if (owed.length > 0)
            throw new RuleError('SERVICE_UNPAID', `Room service of Rp ${owed.reduce((sum, o) => sum + orderDue(o), 0).toLocaleString('id-ID')} is unpaid on ${b.code} (${owed.map((o) => o.number).join(', ')}). Take the payment before check-out.`)
          assertMasterSettled(b)
          const due = folioOwed(folioOf(b))
          if (due > 0) throw new RuleError('FOLIO_UNSETTLED', `The folio of ${b.code} still has Rp ${due.toLocaleString('id-ID')} to pay. Settle the bill at check-out.`)
          b.status = 'checked_out'
          b.checkedOutOn = today()
          b.departure = { ...details, notes: details.notes.trim() }
          ledger.recordStay(b)
          guestMessages.onStatus(b)
          log('status', 'booking', b.code, `Checked out ${b.code}`, { status: 'checked_in' }, { status: 'checked_out', extraCharges: details.extraCharges })
          return copy(b)
        }),
      settleAndCheckOut: (id, input) =>
        later(() =>
          atomically(() => {
            const me = user()
            const b = findById(s.bookings, id, 'booking')
            if (!canTransition(b, 'checked_out')) throw new RuleError('BOOKING_INVALID_STATE', `A ${b.status.replace('_', ' ')} booking cannot be checked out.`)
            refuse(validateCheckOut(input.details, b.arrival?.deposit ?? 0))
            if (pendingSettle(b.id)) throw new RuleError('SETTLEMENT_PENDING', `${b.code} already has a check-out link waiting for the guest.`)
            assertMasterSettled(b)
            const mine = s.orders.filter((o) => o.bookingId === b.id)
            const waiting = mine.filter((o) => payState(o, s.payments) === 'pending')
            if (waiting.length) throw new RuleError('SETTLEMENT_PENDING', `${waiting.map((o) => o.number).join(', ')} has a payment link open; cancel it or wait for the guest.`)
            // The folio holds the bill: room balance (none on an Airbnb stay, which Airbnb pays out), unpaid orders, open charges.
            const due = folioOf(b).due
            const unpaid = mine.filter((o) => payState(o, s.payments) === 'unpaid' && orderDue(o) > 0)
            const ordersDue = unpaid.reduce((sum, o) => sum + orderDue(o), 0)
            refuse(validateSettle(input, settlementLines(due.room, unpaid.map((o) => ({ number: o.number, items: '', amount: orderDue(o) })), input.details.extraCharges, due.charges)))
            const payer = s.guests.find((g) => g.id === b.guestId)?.name ?? ''
            const parts: LinkPart[] = [...(unpaid.length ? [{ kind: 'extra' as const, amount: ordersDue, orderIds: unpaid.map((o) => o.id) }] : []), ...(due.room > 0 ? [{ kind: 'balance' as const, amount: due.room }] : [])]
            const [first, ...also] = parts
            if (first && isGateway(input.method)) {
              const link = openLink(b, { ...first, method: input.method, payer }, me, { also, checkOut: { details: { ...input.details, notes: input.details.notes.trim() }, by: me.id, folioCharges: due.charges } })
              log('update', 'booking', b.code, `Sent a check-out link for ${b.code}: ${link.amount}`)
              return { booking: copy(b), link: copy(link) }
            }
            parts.forEach((part, i) => {
              const p = newPayment(b, { kind: part.kind, method: input.method, amount: part.amount, status: 'paid', reference: input.reference.trim(), payer, note: 'Settled at check-out', paidOn: today(), ...(part.orderIds ? { orderIds: [...part.orderIds] } : {}) }, me)
              p.history = [...p.history, { kind: 'paid', by: me.name, at: clockNow(), note: PAYMENT_METHOD_LABEL[input.method] }]
              bookMoney(p, me, i === 0 ? input.attachments : [])
              if (part.orderIds) markOrdersPaid(p, me)
              log('create', 'payment', p.number, `Recorded ${PAYMENT_KIND_LABEL[p.kind].toLowerCase()} ${p.number} on ${b.code} at check-out: ${p.amount}`, null, null, me)
            })
            syncBooking(b.id)
            closeStay(b, input.details, me, input.method)
            return { booking: copy(b), link: null }
          }),
        ),
      moveUnit: (id, unitId, reason, price) =>
        later(() => {
          const b = findById(s.bookings, id, 'booking')
          if (b.status === 'checked_out' || b.status === 'cancelled' || b.status === 'no_show') throw new RuleError('BOOKING_INVALID_STATE', 'This stay is over; nothing to move.')
          if (!b.unitAssigned) throw new RuleError('UNIT_UNASSIGNED', `${b.code} has no room yet. Assign one instead.`)
          const target = catalog().unit(unitId)
          if (!interchangeableWith(catalog(), b.unitId).some((u) => u.id === unitId))
            throw new RuleError('UNIT_NOT_INTERCHANGEABLE', `${target.code} is not interchangeable with ${catalog().unit(b.unitId).code}.`)
          if (price && isChannel(b)) throw new RuleError('CHANNEL_PRICE_LOCKED', `${b.code} keeps the price the channel sold it for.`)
          assertFree(unitId, b.checkIn, b.checkOut, b.id)
          // A direct stay sells at the new room's price list; a channel stay keeps what the guest paid the channel.
          const nights = isChannel(b) ? null : eachDay(b.checkIn, b.checkOut).map(directPrice(unitId))
          const from = catalog().unit(b.unitId).code
          const before = { unit: from, total: bookingTotal(b) }
          b.movements = [...b.movements, { fromUnitId: b.unitId, toUnitId: unitId, on: today(), reason, by: user().name }]
          b.unitId = unitId
          if (nights) setNights(b, nights)
          if (price) applyPrice(b, price)
          syncBooking(b.id)
          ledger.recordRepost(b)
          log('update', 'booking', b.code, `Moved ${b.code} from ${from} to ${target.code}: ${reason}`, before, { unit: target.code, total: bookingTotal(b) })
          return copy(b)
        }),
      setPrice: (id, price) =>
        later(() => {
          const b = findById(s.bookings, id, 'booking')
          if (b.status === 'checked_out' || b.status === 'cancelled' || b.status === 'no_show') throw new RuleError('BOOKING_INVALID_STATE', 'This stay is over; the price is final.')
          const before = { total: bookingTotal(b), rateOverride: b.rateOverride, discount: b.discount?.value ?? null }
          const quoted = applyPrice(b, price)
          syncBooking(b.id)
          ledger.recordRepost(b)
          log('update', 'booking', b.code, `Repriced ${b.code}${b.discount ? `: ${b.discount.reason}` : price.reason.trim() ? `: ${price.reason.trim()}` : ''}`, before, { total: quoted.total, rateOverride: b.rateOverride, discount: b.discount?.value ?? null })
          return copy(b)
        }),
      assignUnit: (id, unitId, override) =>
        later(() => {
          const b = findById(s.bookings, id, 'booking')
          if (b.status !== 'draft' && b.status !== 'confirmed') throw new RuleError('BOOKING_INVALID_STATE', 'Rooms are assigned before check-in.')
          const current = catalog().unit(b.unitId)
          const target = catalog().unit(unitId)
          if (!current.groupId || target.groupId !== current.groupId || !sellsRoomType(catalog().group(current.groupId)))
            throw new RuleError('UNIT_NOT_INTERCHANGEABLE', `${target.code} is not a room of the type ${b.code} booked.`)
          if (target.status !== 'active') throw new RuleError('UNIT_UNAVAILABLE', `${target.code} is ${target.status}.`)
          assertFree(unitId, b.checkIn, b.checkOut, b.id)
          // The type's rules held at booking; the room meets its own, such as a stop sell on that unit.
          const restrictionNote = stayRules.checkStay({ groupId: current.groupId, unitId, checkIn: b.checkIn, checkOut: b.checkOut }, b.source, override, `${target.code} for ${b.code}, ${b.checkIn} to ${b.checkOut},`, unitRestrictions(s.restrictions, unitId))
          if (restrictionNote) b.restrictionNote = mergeNotes(b.restrictionNote, restrictionNote)
          const nights = isChannel(b) ? null : repriceNights({ checkIn: b.checkIn, listRates: soldNights(b) }, b.checkIn, b.checkOut, directPrice(unitId))
          const before = { unit: b.unitAssigned ? current.code : 'Unassigned' }
          b.unitId = unitId
          b.requestedUnitId = b.unitAssigned ? b.requestedUnitId : unitId
          b.unitAssigned = true
          if (nights) setNights(b, nights)
          syncBooking(b.id)
          log('update', 'booking', b.code, `Assigned ${target.code} to ${b.code}`, before, { unit: target.code })
          if (restrictionNote?.kind === 'override') log('update', 'booking', b.code, `Sold ${target.code} on ${b.code} past stay restrictions: ${restrictionNote.reason}`, null, { rules: restrictionNote.rules.join(', ') })
          return copy(b)
        }),
      adjustStay: (id, checkIn, checkOut, channelRate, override) =>
        later(() => {
          const b = findById(s.bookings, id, 'booking')
          if (b.status === 'checked_out' || b.status === 'cancelled' || b.status === 'no_show') throw new RuleError('BOOKING_INVALID_STATE', 'This stay is over; the dates are final.')
          if (b.status === 'checked_in' && checkIn !== b.checkIn) throw new RuleError('BOOKING_INVALID_STATE', 'The guest has checked in; only the check-out can move.')
          if (daysBetween(checkIn, checkOut) < postedNights(b)) throw new RuleError('NIGHT_POSTED', `The night audit has posted ${postedNights(b)} nights of ${b.code}; the stay keeps at least those. Correct a posted night with a rebate.`)
          const problem = validateStay(checkIn, checkOut)
          if (problem) throw new RuleError('VALIDATION_ERROR', problem)
          assertStayFree(b, checkIn, checkOut, b.id)
          // New dates meet the stay restrictions; a guest in house who leaves early is never held to them.
          const restrictionNote = b.status !== 'checked_in' || checkOut > b.checkOut ? stayRules.checkStay({ groupId: catalog().unit(b.unitId).groupId, unitId: b.unitAssigned ? b.unitId : null, checkIn, checkOut }, b.source, override, `${b.code}, ${checkIn} to ${checkOut},`) : null
          if (restrictionNote) b.restrictionNote = restrictionNote
          // Nights already sold keep their price; new nights take the price list, or what the channel charged.
          const gains = repriceNights(b, checkIn, checkOut, () => 0).some((r) => r === 0)
          if (isChannel(b) && gains && (!Number.isInteger(channelRate) || (channelRate ?? 0) <= 0)) throw new RuleError('VALIDATION_ERROR', 'Enter the nightly price the channel charged for the new nights.')
          const before = { checkIn: b.checkIn, checkOut: b.checkOut, total: bookingTotal(b) }
          setNights(b, repriceNights({ checkIn: b.checkIn, listRates: soldNights(b) }, checkIn, checkOut, isChannel(b) ? channelPrice(channelRate ?? 0) : directPrice(b.unitId)))
          b.checkIn = checkIn
          b.checkOut = checkOut
          syncBooking(b.id)
          ledger.recordRepost(b)
          log('update', 'booking', b.code, `Changed the dates of ${b.code}${restrictionNote?.kind === 'override' ? `, past stay restrictions: ${restrictionNote.reason}` : ''}`, before, { checkIn, checkOut, total: bookingTotal(b) })
          return copy(b)
        }),
      updateNotes: (id, notes) =>
        later(() => {
          const b = findById(s.bookings, id, 'booking')
          b.notes = notes.trim()
          return copy(b)
        }),
      setPayment: (id, payment) =>
        later(() => {
          const b = findById(s.bookings, id, 'booking')
          refuse(validatePayment(payment, stayTotal(b), b.source))
          const before = { paymentStatus: b.paymentStatus, paidAmount: b.paidAmount, airbnbFee: b.airbnbFee }
          Object.assign(b, payment)
          log('update', 'booking', b.code, `Updated payment on ${b.code}: ${payment.paymentStatus}`, before, { ...payment })
          return copy(b)
        }),
      addBlock: (input) =>
        later(() => {
          const unit = catalog().unit(input.unitId)
          const clash = s.bookings.find((b) => b.unitId === input.unitId && occupies(b) && b.checkIn < input.to && input.from < b.checkOut)
          if (clash) throw new RuleError('BLOCK_OVERLAP', `${unit.code} has ${clash.code} on those nights. Move it before blocking.`)
          const block: UnitBlock = { ...input, id: `blk-${seq('block')}`, note: input.note.trim() }
          s.blocks.push(block)
          log('create', 'block', block.id, `Blocked ${unit.code} ${input.from} to ${input.to}: ${input.reason}`)
          return copy(block)
        }),
      removeBlock: (id) =>
        later(() => {
          const block = findById(s.blocks, id, 'block')
          s.blocks = s.blocks.filter((k) => k.id !== id)
          log('delete', 'block', id, `Removed the block on ${catalog().unit(block.unitId).code}`)
        }),
    },
    stayRules: stayRules.port,
    groups: createGroupPort({ s, later, atomically, copy, seq, user, today, clockNow, log, refuse, createGuest, createStay, newPayment, bookBatch, openLink, linkPayments, owedOn: (b) => expectedOf(b) - paidOf(b), syncBooking }),
    folio: {
      postings: (bookingId) =>
        later(() => {
          findById(s.bookings, bookingId, 'booking')
          return copy(s.folioPostings.filter((p) => p.bookingId === bookingId))
        }),
      postCharge: (bookingId, input) =>
        later(() => {
          refuse(validateCharge(input, s.transactionCodes))
          const b = folioStay(bookingId)
          // The amount reads in the stay's price mode: net gets service and PB1 on top, inclusive splits.
          const split = taxSplit(input.amount, input.code, ratesOn(s.tax, today()), stayMode(b))
          return addPosting(b, { kind: 'charge', code: input.code, description: input.description, amount: split.net, service: split.service, pb1: split.pb1, approvedBy: null, part: 'charges', lineId: null, orderId: null }, user())
        }),
      postRebate: (bookingId, input) =>
        later(() => {
          const me = user()
          const b = folioStay(bookingId)
          // The whole folio: a master-billed stay's room nights sit on the group's folio but are still this stay's lines.
          const lines = folioOf(b, true).lines
          const target = rebateTarget(lines, input.lineId)
          refuse(validateRebate(input, target))
          if (!target) throw new NotFoundError('folio line', input.lineId)
          const beyond = rebateBeyondLimit(target, input.amount, s.paymentPolicy.discountLimitPct)
          if (beyond && !can(s.permissions, me.role, 'booking', 'approve'))
            throw new RuleError('ALLOWANCE_LIMIT', `Rebates past ${s.paymentPolicy.discountLimitPct}% of a line on ${b.code} need a villa manager.`)
          const { line } = target
          const back = rebateTax(lines, target, input.amount)
          return addPosting(b, { kind: 'rebate', code: line.code, description: input.reason, amount: input.amount, service: back.service, pb1: back.pb1, approvedBy: beyond ? me.name : null, part: line.part, lineId: line.id, orderId: line.orderId }, me)
        }),
    },
    guest: guests.port,
    lostFound: guests.lostFound,
    finance: {
      accounts: () => later(() => copy(s.cashAccounts)),
      createAccount: (input) =>
        later(() => {
          refuse(validateAccount(input, s.cashAccounts))
          if (input.openingBalance > 0) ledger.assertOpen(input.openedOn)
          const account: CashAccount = { id: newId('acc', input.name), ...input, name: input.name.trim() }
          s.cashAccounts.push(account)
          ledger.recordOpening(account)
          log('create', 'cash-account', account.id, `Opened ${account.name}`)
          return copy(account)
        }),
      updateAccount: (id, input) =>
        later(() => {
          refuse(validateAccount(input, s.cashAccounts, id))
          const account = findById(s.cashAccounts, id, 'account')
          const before = { ...account }
          Object.assign(account, { ...input, name: input.name.trim() })
          log('update', 'cash-account', id, `Edited ${account.name}`, before, { ...account })
          return copy(account)
        }),
      categories: () => later(() => copy(s.categories)),
      transactions: () => later(() => copy(s.transactions)),
      createTransaction: (input, submit, origin = 'manual') =>
        later(() => {
          refuse(validateTransaction(input, s.categories))
          return copy(newTransaction({ ...input, description: input.description.trim(), reference: input.reference.trim(), attachments: [...input.attachments], transferId: null, origin }, submit))
        }),
      transition: (id, to, note = '') =>
        later(() => {
          const t = findById(s.transactions, id, 'transaction')
          const me = user()
          if (!canTransitionTransaction(t, to)) {
            if (t.status === 'posted' || t.status === 'reversed') throw new RuleError('TRANSACTION_ALREADY_POSTED', `${t.number} is ${t.status}; reverse it instead of editing it.`)
            throw new RuleError('TRANSACTION_INVALID_STATE', `A ${t.status} entry cannot become ${to}.`)
          }
          const before = t.status
          if (to === 'submitted') {
            const cancelled = s.stockReceipts.find((r) => r.transactionId === t.id && r.cancelledOn)
            if (cancelled) throw new RuleError('TRANSACTION_INVALID_STATE', `${cancelled.number} was cancelled, so ${t.number} stays rejected. Receive the stock again instead.`)
            assertProof(t)
            t.history = [...t.history, event(before === 'rejected' ? 'resubmitted' : 'submitted', note)]
            t.approvals = []
            t.rejectionReason = null
            t.status = 'submitted'
          } else if (to === 'approved') {
            const progress = approvalProgress(requiredLevels(s.approvalRules, t), t.approvals)
            if (!progress.next) throw new RuleError('TRANSACTION_INVALID_STATE', `${t.number} already has every signature.`)
            if (t.createdById === me.id) throw new RuleError('APPROVAL_SELF', 'The person who recorded an entry cannot approve it.')
            if (!canSignLevel(me.role, progress.next)) throw new RuleError('APPROVAL_ROLE', `Level ${progress.done + 1} of ${progress.levels.length} needs ${ROLE_LABEL[progress.next]}; you are ${ROLE_LABEL[me.role]}.`)
            if (t.approvals.some((a) => a.by === me.name)) throw new RuleError('APPROVAL_SELF', 'You have already signed this entry.')
            t.approvals = [...t.approvals, { level: progress.done + 1, role: progress.next, by: me.name, on: today(), note: note.trim() }]
            const after = approvalProgress(progress.levels, t.approvals)
            t.history = [...t.history, event('approved', after.complete ? 'All levels signed' : `Level ${after.done} of ${after.levels.length}`)]
            if (after.complete) t.status = 'approved'
          } else if (to === 'rejected') {
            if (note.trim().length < 3) throw new RuleError('VALIDATION_ERROR', 'Say why the entry is rejected.')
            if (t.createdById === me.id) throw new RuleError('APPROVAL_SELF', 'The person who recorded an entry cannot reject it; withdraw it instead.')
            t.status = 'rejected'
            t.rejectionReason = note.trim()
            t.history = [...t.history, event('rejected', note.trim())]
          } else if (to === 'posted') {
            ledger.assertOpen(t.date)
            t.status = 'posted'
            t.history = [...t.history, event('posted', note)]
          }
          syncTwin(t)
          if (to === 'posted') ledger.recordPosting(t)
          log(to === 'approved' ? 'approve' : to === 'rejected' ? 'reject' : 'status', 'transaction', t.number, `${to === 'approved' && t.status !== 'approved' ? 'Signed' : to.charAt(0).toUpperCase() + to.slice(1)} ${t.number}, ${t.description}`, { status: before }, { status: t.status })
          return copy(t)
        }),
      reverse: (id, reason) =>
        later(() => {
          const t = findById(s.transactions, id, 'transaction')
          if (t.status !== 'posted') throw new RuleError('TRANSACTION_INVALID_STATE', `Only posted entries can be reversed; ${t.number} is ${t.status}.`)
          ledger.assertOpen(today())
          const n = seq('transaction')
          const me = user()
          const reversal: Transaction = {
            ...t,
            id: `tx-${n}`,
            number: `TX-${2400 + n}`,
            kind: t.kind === 'cash_in' ? 'cash_out' : 'cash_in',
            date: today(),
            description: `Reversal of ${t.number}: ${reason}`,
            attachments: [],
            origin: 'reversal',
            status: 'posted',
            approvals: [],
            history: [event('created', reason), event('posted')],
            rejectionReason: null,
            transferId: null,
            reversalOf: t.id,
            reversedBy: null,
            createdBy: me.name,
            createdById: me.id,
            createdOn: today(),
          }
          t.status = 'reversed'
          t.reversedBy = reversal.id
          t.history = [...t.history, event('reversed', reason)]
          s.transactions.push(reversal)
          ledger.recordPosting(reversal)
          log('status', 'transaction', t.number, `Reversed ${t.number} with ${reversal.number}: ${reason}`, { status: 'posted' }, { status: 'reversed' })
          return copy(reversal)
        }),
      transfer: (input) => later(() => copy(transferCash(input))),
      adjust: (input) =>
        later(() => {
          refuse(validateAdjustment(input, s.cashAccounts))
          const account = findById(s.cashAccounts, input.accountId, 'account')
          const kind = input.direction === 'increase' ? 'cash_in' : 'cash_out'
          return copy(newTransaction({ accountId: account.id, kind, categoryId: kind === 'cash_in' ? 'cat-adjust-in' : 'cat-adjust-out', amount: input.amount, date: input.date, locationId: account.locationId ?? s.locations[0]?.id ?? '', villaId: null, unitId: null, bookingId: null, description: input.reason.trim(), reference: '', attachments: [], origin: 'adjustment', transferId: null }, true))
        }),
      reconciliations: () => later(() => copy(s.reconciliations)),
      reconcile: (input) =>
        later(() => {
          refuse(validateReconciliation(input, s.cashAccounts))
          const account = findById(s.cashAccounts, input.accountId, 'account')
          return copy(recordCount(account, { date: input.date, expected: balance(account, s.transactions, input.date), counted: input.counted, note: input.note, adjust: input.adjust, by: user().name }))
        }),
      createCategory: (input) =>
        later(() => {
          const c = { id: `cat-${seq('category')}`, name: input.name, kind: input.kind, slot: 0, active: true, villaIds: [...input.villaIds] }
          s.categories.push(c)
          log('create', 'category', c.id, `Added category ${c.name}`)
          return copy(c)
        }),
      updateCategory: (id, input) =>
        later(() => {
          const c = findById(s.categories, id, 'category')
          if (isSystemCategory(id) && (input.name !== c.name || input.kind !== c.kind)) throw new RuleError('CATEGORY_SYSTEM', `${c.name} is a system category; only its villas can change.`)
          Object.assign(c, { name: input.name, kind: input.kind, villaIds: [...input.villaIds] })
          return copy(c)
        }),
      setCategoryActive: (id, active) =>
        later(() => {
          const c = findById(s.categories, id, 'category')
          if (!active && isSystemCategory(id)) throw new RuleError('CATEGORY_SYSTEM', `${c.name} is a system category and stays active.`)
          c.active = active
          return copy(c)
        }),
      approvalRules: () => later(() => copy(s.approvalRules)),
      createRule: (input) =>
        later(() => {
          refuse(validateApprovalRule(input))
          const rule = { id: `rule-${seq('rule')}`, ...input, name: input.name.trim(), levels: [...input.levels] }
          s.approvalRules.push(rule)
          log('create', 'approval-rule', rule.id, `Added approval rule ${rule.name}`)
          return copy(rule)
        }),
      updateRule: (id, input) =>
        later(() => {
          refuse(validateApprovalRule(input))
          const rule = findById(s.approvalRules, id, 'approval rule')
          const before = { ...rule }
          Object.assign(rule, { ...input, name: input.name.trim(), levels: [...input.levels] })
          log('update', 'approval-rule', id, `Edited approval rule ${rule.name}`, before, { ...rule })
          return copy(rule)
        }),
      deleteRule: (id) =>
        later(() => {
          const rule = findById(s.approvalRules, id, 'approval rule')
          s.approvalRules = s.approvalRules.filter((r) => r.id !== id)
          log('delete', 'approval-rule', id, `Removed approval rule ${rule.name}`)
        }),
      attach: (id, files) =>
        later(() => {
          const t = findById(s.transactions, id, 'transaction')
          if (t.status === 'posted' || t.status === 'reversed') throw new RuleError('ATTACHMENT_LOCKED', `${t.number} is ${t.status}; its receipts are final.`)
          assertFiles([...t.attachments, ...files])
          t.attachments = [...t.attachments, ...files]
          syncReceipts(t)
          log('update', 'transaction', t.number, `Attached ${files.map((f) => f.name).join(', ')} to ${t.number}`)
          return copy(t)
        }),
      detach: (id, attachmentId) =>
        later(() => {
          const t = findById(s.transactions, id, 'transaction')
          if (t.status === 'posted' || t.status === 'reversed') throw new RuleError('ATTACHMENT_LOCKED', `${t.number} is ${t.status}; its receipts are final.`)
          const file = findById(t.attachments, attachmentId, 'attachment')
          t.attachments = t.attachments.filter((f) => f.id !== attachmentId)
          syncReceipts(t)
          log('update', 'transaction', t.number, `Removed ${file.name} from ${t.number}`)
          return copy(t)
        }),
      proofPolicy: () => later(() => copy(s.proofPolicy)),
      saveProofPolicy: (policy) =>
        later(() => {
          refuse(validateProofPolicy(policy))
          const before = { ...s.proofPolicy }
          s.proofPolicy = { ...policy }
          log('update', 'settings', 'proof-policy', 'Changed the receipt rule for cash-outs', before, { ...policy })
          return copy(s.proofPolicy)
        }),
    },
    ledger: ledger.port,
    service: {
      requests: () => later(() => copy(s.requests)),
      create: (input) =>
        later(() => {
          refuse(validateServiceRequest(input))
          catalog().unit(input.unitId)
          if (input.bookingId) findById(s.bookings, input.bookingId, 'booking')
          const now = new Date()
          const n = seq('request')
          const request: ServiceRequest = {
            ...input,
            note: input.note.trim(),
            id: `rq-${n}`,
            number: `RQ-${100 + n}`,
            status: 'open',
            assignee: '',
            requestedOn: today(),
            requestedAt: now.getHours() * 60 + now.getMinutes(),
            doneOn: null,
            transactionId: null,
          }
          s.requests.push(request)
          return copy(request)
        }),
      update: (id, input) =>
        later(() => {
          const r = findById(s.requests, id, 'request')
          if (!canEditRequest(r)) throw new RuleError('REQUEST_INVALID_STATE', `${r.number} is ${r.status}; it can no longer change.`)
          refuse(validateServiceRequest(input))
          Object.assign(r, { ...input, note: input.note.trim() })
          return copy(r)
        }),
      transition: (id, to) =>
        later(() => {
          const r = findById(s.requests, id, 'request')
          if (!canTransitionService(r, to)) throw new RuleError('REQUEST_INVALID_STATE', `A ${r.status.replace('_', ' ')} request cannot become ${to.replace('_', ' ')}.`)
          r.status = to
          if (to === 'done') r.doneOn = today()
          return copy(r)
        }),
      assign: (id, assignee) =>
        later(() => {
          const r = findById(s.requests, id, 'request')
          r.assignee = assignee.trim()
          return copy(r)
        }),
      linkTransaction: (id, transactionId) =>
        later(() => {
          const r = findById(s.requests, id, 'request')
          r.transactionId = transactionId
          return copy(r)
        }),
    },
    orders: {
      menu: () => later(() => copy(s.menu)),
      createItem: (input) =>
        later(() => {
          assertMenuEditor()
          refuse(validateMenuItem(input))
          const villa = findById(s.villas, input.villaId, 'villa')
          if (input.partnerId) findById(s.partners, input.partnerId, 'partner')
          const item = { ...input, name: input.name.trim(), description: input.description.trim(), id: newId('mi', input.name) }
          s.menu.push(item)
          log('create', 'menu-item', item.id, `Added ${item.name} to the ${villa.name} menu`, null, { price: item.price })
          return copy(item)
        }),
      updateItem: (id, input) =>
        later(() => {
          assertMenuEditor()
          refuse(validateMenuItem(input))
          const item = findById(s.menu, id, 'menu item')
          if (input.partnerId) findById(s.partners, input.partnerId, 'partner')
          const before = { price: item.price, active: item.active, costPrice: item.costPrice }
          Object.assign(item, { ...input, name: input.name.trim(), description: input.description.trim() })
          log('update', 'menu-item', id, `Edited ${item.name} on the menu`, before, { price: item.price, active: item.active, costPrice: item.costPrice })
          return copy(item)
        }),
      partners: () => later(() => copy(s.partners)),
      createPartner: (input) =>
        later(() => {
          assertMenuEditor()
          refuse(validatePartner(input))
          const partner = { ...input, name: input.name.trim(), id: newId('ptn', input.name) }
          s.partners.push(partner)
          log('create', 'service-partner', partner.id, `Added partner ${partner.name}`)
          return copy(partner)
        }),
      updatePartner: (id, input) =>
        later(() => {
          assertMenuEditor()
          refuse(validatePartner(input))
          const partner = findById(s.partners, id, 'partner')
          Object.assign(partner, { ...input, name: input.name.trim() })
          log('update', 'service-partner', id, `Edited partner ${partner.name}`)
          return copy(partner)
        }),
      orders: () => later(() => copy(s.orders)),
      place: (input) => later(() => copy(placeOrder(input, user(), 'staff'))),
      transition: (id, to, note) =>
        later(() => {
          const me = user()
          const o = findById(s.orders, id, 'order')
          if (!canTransitionOrder(o, to)) throw new RuleError('ORDER_INVALID_STATE', `A ${ORDER_STATUS_LABEL[o.status].toLowerCase()} order cannot become ${ORDER_STATUS_LABEL[to].toLowerCase()}.`)
          if (to === 'cancelled' && note.trim().length < 3) throw new RuleError('VALIDATION_ERROR', 'Say why the order is cancelled.')
          if (to === 'delivered') stock.sell(o, me)
          if (to === 'voided') voidDelivery(o, note, me)
          const before = o.status
          o.status = to
          if (to === 'delivered') {
            o.deliveredOn = today()
            o.deliveredAt = minuteNow()
            // Each partner bills its share once the service happened: a cash-out from the bank for approval.
            const place = catalog().place(o.unitId)
            const bank = s.cashAccounts.find((a) => a.kind === 'bank')
            if (bank)
              o.costTransactionIds = partnerCosts(o).map((c) => newTransaction({ accountId: bank.id, kind: 'cash_out', categoryId: PARTNER_COST_CATEGORY, amount: c.amount, date: today(), locationId: place.location.id, villaId: place.villa.id, unitId: o.unitId, bookingId: o.bookingId, description: `${o.number} ${s.partners.find((x) => x.id === c.partnerId)?.name ?? 'Partner'}: ${c.lines.map((l) => l.name).join(', ')}`, reference: o.number, attachments: [], origin: 'room_service', transferId: null }, true, me).id)
            ledger.recordOrder(o)
          }
          o.history = [...o.history, { kind: to, by: me.name, at: clockNow(), note: note.trim() }]
          log('status', 'service-order', o.number, `${ORDER_STATUS_LABEL[to]} ${o.number}`, { status: before }, { status: to })
          return copy(o)
        }),
      assign: (id, assignee) =>
        later(() => {
          const o = findById(s.orders, id, 'order')
          o.assignee = assignee.trim()
          o.history = [...o.history, { kind: 'assigned', by: user().name, at: clockNow(), note: o.assignee }]
          return copy(o)
        }),
      guestMenu: (token) => later(() => publicMenu(token)),
      guestPlace: (token, input) =>
        later(() => {
          const unit = roomByToken(token)
          const stay = stayInRoom(unit.id)
          if (!stay) throw new RuleError('ORDER_NO_STAY', `${unit.code} has no guest staying right now.`)
          placeOrder({ ...input, lines: input.lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity })), bookingId: stay.id, priority: 'normal', discountPct: 0, discountReason: '', compReason: '' }, GUEST, 'guest')
          return publicMenu(token)
        }),
      guestPay: (token) =>
        later(() => {
          const unit = roomByToken(token)
          const stay = stayInRoom(unit.id)
          if (!stay) throw new RuleError('ORDER_NO_STAY', `${unit.code} has no guest staying right now.`)
          expireLinks()
          const open = s.paymentLinks.find((l) => l.bookingId === stay.id && l.status === 'pending' && forOrders(findById(s.payments, l.paymentId, 'payment')))
          if (open) return copy(open)
          const unpaid = s.orders.filter((o) => o.bookingId === stay.id && payState(o, s.payments) === 'unpaid' && orderDue(o) > 0)
          if (unpaid.length === 0) throw new RuleError('ORDER_NOT_BILLABLE', 'Nothing delivered is waiting to be paid.')
          const amount = unpaid.reduce((sum, o) => sum + orderDue(o), 0)
          return copy(openLink(stay, { kind: 'extra', method: 'qris', amount, payer: s.guests.find((g) => g.id === stay.guestId)?.name ?? '', orderIds: unpaid.map((o) => o.id) }, GUEST))
        }),
    },
    payment: {
      payments: () =>
        later(() => {
          expireLinks()
          return copy(s.payments)
        }),
      links: () =>
        later(() => {
          expireLinks()
          return copy(s.paymentLinks)
        }),
      policy: () => later(() => copy(s.paymentPolicy)),
      savePolicy: (policy) =>
        later(() => {
          refuse(validatePolicy(policy))
          const before = { ...s.paymentPolicy }
          s.paymentPolicy = { ...policy }
          log('update', 'payment-policy', 'policy', 'Changed the payment policy', before, { ...policy })
          return copy(s.paymentPolicy)
        }),
      record: (input) =>
        later(() => {
          const me = user()
          const b = findById(s.bookings, input.bookingId, 'booking')
          const orders = input.orderIds?.length ? ordersToSettle(b, input.orderIds, input.amount) : null
          const paid = paidOf(b)
          if (orders) refuse(validateGuestPayment({ ...input, kind: 'extra' }, input.amount, paid))
          else refuse(validateGuestPayment(input, expectedOf(b) - paid, paid))
          if (input.kind === 'refund') throw new RuleError('VALIDATION_ERROR', 'Use refund on the payment that brought the money in.')
          if (isGateway(input.method)) throw new RuleError('VALIDATION_ERROR', `${PAYMENT_METHOD_LABEL[input.method]} goes through a payment link.`)
          const p = newPayment(b, { kind: orders ? 'extra' : input.kind, method: input.method, amount: input.amount, status: 'paid', reference: input.reference.trim(), payer: input.payer.trim(), note: input.note.trim(), paidOn: today(), ...(orders ? { orderIds: orders.map((o) => o.id) } : {}) }, me)
          p.history = [...p.history, { kind: 'paid', by: me.name, at: clockNow(), note: PAYMENT_METHOD_LABEL[input.method] }]
          bookMoney(p, me, input.attachments ?? [])
          if (orders) markOrdersPaid(p, me)
          syncBooking(b.id)
          guestMessages.onPaid(b.id, p.amount)
          log('create', 'payment', p.number, `Recorded ${PAYMENT_KIND_LABEL[p.kind].toLowerCase()} ${p.number} on ${b.code}: ${p.amount}`)
          return copy(p)
        }),
      createLink: (input) =>
        later(() => {
          const me = user()
          const b = findById(s.bookings, input.bookingId, 'booking')
          if (!isGateway(input.method)) throw new RuleError('VALIDATION_ERROR', 'Links are for QRIS, virtual account or card.')
          if (input.orderIds?.length) ordersToSettle(b, input.orderIds, input.amount)
          else {
            const paid = paidOf(b)
            refuse(validateGuestPayment({ ...input, reference: '', note: '' }, expectedOf(b) - paid, paid))
          }
          const link = openLink(b, input, me)
          guestMessages.onLink(link)
          return copy(link)
        }),
      cancelLink: (token) =>
        later(() => {
          const link = s.paymentLinks.find((x) => x.token === token)
          if (!link) throw new NotFoundError('payment link', token)
          if (link.status !== 'pending') throw new RuleError('PAYMENT_INVALID_STATE', `The link is ${link.status}.`)
          link.status = 'cancelled'
          for (const p of linkPayments(link)) {
            p.status = 'cancelled'
            p.history = [...p.history, { kind: 'cancelled', by: user().name, at: clockNow(), note: '' }]
          }
          return copy(link)
        }),
      refund: (paymentId, amount, reason, attachments) =>
        later(() => {
          const me = user()
          const original = findById(s.payments, paymentId, 'payment')
          if (original.status !== 'paid' && original.status !== 'refunded') throw new RuleError('PAYMENT_INVALID_STATE', `${original.number} is ${original.status}; only paid money goes back.`)
          if (original.kind === 'refund') throw new RuleError('PAYMENT_INVALID_STATE', 'A refund cannot be refunded.')
          const already = s.payments.filter((x) => x.refundOf === original.id && x.status === 'paid').reduce((sum, x) => sum + x.amount, 0)
          const b = findById(s.bookings, original.bookingId, 'booking')
          refuse(validateGuestPayment({ bookingId: b.id, kind: 'refund', method: original.method, amount, reference: original.number, payer: '', note: reason }, 0, original.amount - already))
          const method: PaymentMethod = original.method === 'cash' ? 'cash' : 'bank_transfer'
          // Order money goes back against the order of the payment that carries the most credit after its rebates.
          const lines = forOrders(original) ? folioOf(b, true).lines : []
          const credit = (orderId: string) => lines.filter((l) => l.orderId === orderId).reduce((sum, l) => sum + l.debit - l.credit, 0)
          const orderId = [...(original.orderIds ?? [])].sort((x, y) => credit(x) - credit(y))[0]
          const p = newPayment(b, { kind: 'refund', method, amount, status: 'paid', reference: original.number, payer: s.guests.find((g) => g.id === b.guestId)?.name ?? '', note: reason.trim(), paidOn: today(), refundOf: original.id, ...(orderId ? { orderIds: [orderId] } : {}) }, me)
          bookMoney(p, me, attachments)
          if (already + amount >= original.amount) original.status = 'refunded'
          original.history = [...original.history, { kind: 'refunded', by: me.name, at: clockNow(), note: `${p.number}: ${reason.trim()}` }]
          syncBooking(b.id)
          log('create', 'payment', p.number, `Refunded ${amount} of ${original.number} on ${b.code}: ${reason.trim()}`)
          return copy(p)
        }),
      checkout: (token) =>
        later(() => {
          expireLinks()
          const link = s.paymentLinks.find((x) => x.token === token)
          if (!link) throw new NotFoundError('payment link', token)
          return checkoutOf(link)
        }),
      settle: (token, outcome) =>
        later(() =>
          atomically(() => {
            expireLinks()
            const link = s.paymentLinks.find((x) => x.token === token)
            if (!link) throw new NotFoundError('payment link', token)
            if (link.status !== 'pending') throw new RuleError('PAYMENT_INVALID_STATE', `This link is ${link.status}.`)
            const payments = linkPayments(link)
            if (outcome === 'failed') {
              link.status = 'failed'
              for (const p of payments) {
                p.status = 'failed'
                p.history = [...p.history, { kind: 'failed', by: GATEWAY.name, at: clockNow(), note: 'Declined at the gateway' }]
                log('status', 'payment', p.number, `Gateway declined ${p.number}`, { status: 'pending' }, { status: 'failed' }, GATEWAY)
              }
              return checkoutOf(link)
            }
            const b = findById(s.bookings, link.bookingId, 'booking')
            // A group link pays a share on each stay; each share must still fit what its stay owes.
            const stays = [...new Set(payments.map((p) => p.bookingId))].map((id) => findById(s.bookings, id, 'booking'))
            for (const x of stays) {
              const room = payments.filter((p) => p.bookingId === x.id && !forOrders(p)).reduce((sum, p) => sum + p.amount, 0)
              if (room > expectedOf(x) - paidOf(x)) throw new RuleError('PAYMENT_OVERPAID', `${x.code} is already paid.`)
            }
            link.status = 'paid'
            for (const p of payments) {
              p.status = 'paid'
              p.paidOn = today()
              if (!p.reference) p.reference = `GW-${token.slice(-6).toUpperCase()}`
              p.history = [...p.history, { kind: 'paid', by: GATEWAY.name, at: clockNow(), note: PAYMENT_METHOD_LABEL[p.method] }]
              if (forOrders(p)) markOrdersPaid(p, GATEWAY)
              log('status', 'payment', p.number, `Gateway confirmed ${p.number} on ${findById(s.bookings, p.bookingId, 'booking').code}: ${p.amount}`, { status: 'pending' }, { status: 'paid' }, GATEWAY)
            }
            if (payments[0]?.batch) bookBatch(payments, GATEWAY, link.proofs)
            else payments.forEach((p, i) => bookMoney(p, GATEWAY, i === 0 ? link.proofs : []))
            for (const x of stays) syncBooking(x.id)
            guestMessages.onPaid(b.id, link.amount)
            // A settle link closes the stay as the person at the desk asked, the money landing in the bank.
            if (link.checkOut && b.status === 'checked_in') closeStay(b, link.checkOut.details, s.users.find((u) => u.id === link.checkOut?.by) ?? GATEWAY, link.method)
            return checkoutOf(link)
          }),
        ),
      submitProof: (token, file) =>
        later(() => {
          expireLinks()
          const link = s.paymentLinks.find((x) => x.token === token)
          if (!link) throw new NotFoundError('payment link', token)
          if (link.status !== 'pending') throw new RuleError('PAYMENT_INVALID_STATE', `This link is ${link.status}.`)
          assertFiles([...link.proofs, file])
          // The checkout is the guest's page, whoever happens to be signed in on the device.
          link.proofs = [...link.proofs, { ...file, uploadedBy: GUEST.name }]
          const p = findById(s.payments, link.paymentId, 'payment')
          p.history = [...p.history, { kind: 'proof', by: 'Guest', at: clockNow(), note: `Uploaded ${file.name}` }]
          log('update', 'payment', p.number, `Guest uploaded ${file.name} for ${p.number}`, null, null, GUEST)
          return checkoutOf(link)
        }),
    },
    files: {
      upload: async (file) => {
        await wait(latency)
        const problem = uploadProblem(file)
        if (problem) throw new RuleError(problem.code, problem.message)
        const by = s.sessionUserId ? (s.users.find((u) => u.id === s.sessionUserId)?.name ?? 'Guest') : 'Guest'
        const n = seq('file')
        return { id: `file-${n}`, name: file.name, type: file.type, size: file.size, url: await dataUrl(file.data, file.type), uploadedBy: by, uploadedAt: clockNow() }
      },
    },
    maintenance: {
      workOrders: () => later(() => copy(s.workOrders)),
      createWorkOrder: (input) =>
        later(() => {
          refuse(validateWorkOrder(input))
          findById(s.villas, input.villaId, 'villa')
          if (input.unitId && catalog().unit(input.unitId).villaId !== input.villaId) throw new RuleError('VALIDATION_ERROR', 'The unit belongs to another villa.')
          const { source = 'manual', planId = null, blockFrom, blockTo, ...fields } = input
          const w = newWorkOrder({ ...fields, title: fields.title.trim(), description: fields.description.trim(), parts: fields.parts.map((p) => ({ ...p })), beforePhotos: [...fields.beforePhotos], afterPhotos: [...fields.afterPhotos], source, planId })
          if (blockFrom && blockTo) {
            w.blockId = blockFor(w, blockFrom, blockTo).id
            w.history = [...w.history, workEvent('blocked', `${blockFrom} to ${blockTo}`)]
          }
          return copy(w)
        }),
      updateWorkOrder: (id, input) =>
        later(() => {
          const w = findById(s.workOrders, id, 'work order')
          if (w.status === 'verified' || w.status === 'cancelled') throw new RuleError('WORK_ORDER_INVALID_STATE', `${w.number} is ${w.status}; it can no longer change.`)
          refuse(validateWorkOrder(input))
          const before = { priority: w.priority, labourCost: w.labourCost, vendorCost: w.vendorCost }
          Object.assign(w, { ...input, title: input.title.trim(), description: input.description.trim(), parts: input.parts.map((p) => ({ ...p })), beforePhotos: [...input.beforePhotos], afterPhotos: [...input.afterPhotos] })
          log('update', 'work-order', w.number, `Edited ${w.number}`, before, { priority: w.priority, labourCost: w.labourCost, vendorCost: w.vendorCost })
          return copy(w)
        }),
      transitionWorkOrder: (id, to, note) =>
        later(() => {
          const w = findById(s.workOrders, id, 'work order')
          if (!canTransitionWorkOrder(w, to)) throw new RuleError('WORK_ORDER_INVALID_STATE', `A ${WORK_ORDER_STATUS_LABEL[w.status].toLowerCase()} job cannot become ${WORK_ORDER_STATUS_LABEL[to].toLowerCase()}.`)
          if ((to === 'on_hold' || to === 'cancelled') && note.trim().length < 3) throw new RuleError('VALIDATION_ERROR', 'Say why.')
          const before = w.status
          w.status = to
          if (to === 'scheduled' && !w.scheduledOn) w.scheduledOn = today()
          if (to === 'in_progress' && !w.startedOn) w.startedOn = today()
          if (to === 'done') {
            w.finishedOn = today()
            const plan = w.planId ? s.plans.find((p) => p.id === w.planId) : undefined
            if (plan) {
              plan.lastDoneOn = today()
              plan.nextDue = advanceDue(plan, today())
            }
            const asset = w.assetId ? s.assets.find((a) => a.id === w.assetId) : undefined
            if (asset?.status === 'under_repair') asset.status = 'in_service'
          }
          if (to === 'in_progress' && before === 'done') w.finishedOn = null
          if (to === 'verified') w.verifiedOn = today()
          if (to === 'done' || to === 'cancelled') releaseBlock(w)
          w.history = [...w.history, workEvent(to, note.trim())]
          log('status', 'work-order', w.number, `${w.number} ${WORK_ORDER_STATUS_LABEL[before].toLowerCase()} to ${WORK_ORDER_STATUS_LABEL[to].toLowerCase()}`, { status: before }, { status: to })
          return copy(w)
        }),
      addNote: (id, note) =>
        later(() => {
          const w = findById(s.workOrders, id, 'work order')
          if (note.trim().length < 2) throw new RuleError('VALIDATION_ERROR', 'Write the note.')
          w.history = [...w.history, workEvent('note', note.trim())]
          return copy(w)
        }),
      setBlock: (id, from, to) =>
        later(() => {
          const w = findById(s.workOrders, id, 'work order')
          if (from && to) {
            if (!isOpenWorkOrder(w)) throw new RuleError('WORK_ORDER_INVALID_STATE', `${w.number} is closed; it cannot block the unit.`)
            if (w.blockId) releaseBlock(w)
            w.blockId = blockFor(w, from, to).id
            w.history = [...w.history, workEvent('blocked', `${from} to ${to}`)]
            log('create', 'block', w.blockId, `Blocked ${catalog().unit(w.unitId ?? '').code} for ${w.number}`)
          } else {
            releaseBlock(w)
            w.history = [...w.history, workEvent('unblocked')]
            log('delete', 'block', w.number, `Released the block for ${w.number}`)
          }
          return copy(w)
        }),
      addExpense: (id, input) =>
        later(() => {
          const w = findById(s.workOrders, id, 'work order')
          if (!canAddExpense(w)) throw new RuleError('WORK_ORDER_INVALID_STATE', `${w.number} is ${WORK_ORDER_STATUS_LABEL[w.status].toLowerCase()}; expenses start once the work starts.`)
          refuse(validateExpense(input))
          if (input.vendorId) findById(s.vendors, input.vendorId, 'vendor')
          const me = user()
          const line = w.expenses.reduce((m, e) => Math.max(m, e.line), 0) + 1
          const t = newTransaction({ ...expenseFields(w, input), reference: expenseReference(w, line), transferId: null, bookingId: null, kind: 'cash_out', categoryId: 'cat-maint', origin: 'maintenance' }, true, me)
          const expense: WorkOrderExpense = { id: `exp-${w.id}-${line}`, line, kind: input.kind, description: input.description.trim(), payee: input.payee.trim(), vendorId: input.vendorId, amount: input.amount, method: input.method, reference: input.reference.trim(), receipts: [...input.receipts], paidOn: input.paidOn, transactionId: t.id, createdBy: me.name, createdOn: today() }
          w.expenses = [...w.expenses, expense]
          w.history = [...w.history, workEvent('cost', `${t.number}: ${EXPENSE_KIND_LABEL[input.kind]} ${input.amount}`)]
          return copy(w)
        }),
      correctExpense: (id, expenseId, input) =>
        later(() => {
          const w = findById(s.workOrders, id, 'work order')
          const e = findById(w.expenses, expenseId, 'expense')
          const t = findById(s.transactions, e.transactionId, 'transaction')
          if (t.status !== 'rejected') throw new RuleError('TRANSACTION_INVALID_STATE', `${t.number} is ${t.status}; only a rejected expense can be corrected.`)
          refuse(validateExpense(input))
          const before = { amount: t.amount, accountId: t.accountId, description: t.description }
          resubmit(t, { ...expenseFields(w, input), reference: expenseReference(w, e.line) }, 'Corrected from the work order')
          w.expenses = w.expenses.map((x) => (x.id === expenseId ? { ...x, kind: input.kind, description: input.description.trim(), payee: input.payee.trim(), vendorId: input.vendorId, amount: input.amount, method: input.method, reference: input.reference.trim(), receipts: [...input.receipts], paidOn: input.paidOn } : x))
          w.history = [...w.history, workEvent('cost', `${t.number} corrected and resubmitted`)]
          log('update', 'transaction', t.number, `Corrected ${t.number} on ${w.number} and resubmitted it`, before, { amount: t.amount, accountId: t.accountId, description: t.description })
          return copy(w)
        }),
      assets: () => later(() => copy(s.assets)),
      createAsset: (input) =>
        later(() => {
          refuse(validateAsset(input, s.assets))
          const a = { ...input, id: `ast-${seq('asset')}`, name: input.name.trim() }
          s.assets.push(a)
          log('create', 'asset', a.code, `Registered ${a.code}, ${a.name}`)
          return copy(a)
        }),
      updateAsset: (id, input) =>
        later(() => {
          refuse(validateAsset(input, s.assets, id))
          const a = findById(s.assets, id, 'asset')
          const before = { status: a.status }
          Object.assign(a, { ...input, name: input.name.trim() })
          log('update', 'asset', a.code, `Edited ${a.code}`, before, { status: a.status })
          return copy(a)
        }),
      vendors: () => later(() => copy(s.vendors)),
      createVendor: (input) =>
        later(() => {
          refuse(validateVendor(input, s.vendors))
          const v = { ...input, id: `ven-${seq('vendor')}`, name: input.name.trim() }
          s.vendors.push(v)
          log('create', 'vendor', v.id, `Added vendor ${v.name}`)
          return copy(v)
        }),
      updateVendor: (id, input) =>
        later(() => {
          refuse(validateVendor(input, s.vendors, id))
          const v = findById(s.vendors, id, 'vendor')
          Object.assign(v, { ...input, name: input.name.trim() })
          log('update', 'vendor', v.id, `Edited vendor ${v.name}`)
          return copy(v)
        }),
      plans: () => later(() => copy(s.plans)),
      createPlan: (input) =>
        later(() => {
          refuse(validatePlan(input))
          const p = { ...input, id: `plan-${seq('plan')}`, title: input.title.trim(), checklist: input.checklist.map((c) => c.trim()), lastDoneOn: null }
          s.plans.push(p)
          log('create', 'plan', p.id, `Added preventive plan ${p.title}`)
          return copy(p)
        }),
      updatePlan: (id, input) =>
        later(() => {
          refuse(validatePlan(input))
          const p = findById(s.plans, id, 'plan')
          Object.assign(p, { ...input, title: input.title.trim(), checklist: input.checklist.map((c) => c.trim()) })
          log('update', 'plan', p.id, `Edited preventive plan ${p.title}`)
          return copy(p)
        }),
      generateDue: (horizonDays) =>
        later(() => {
          const until = addDays(today(), horizonDays)
          const created = s.plans
            .filter((p) => p.active && p.nextDue <= until && !s.workOrders.some((w) => w.planId === p.id && isOpenWorkOrder(w)))
            .map((p) => newWorkOrder({ villaId: p.villaId, unitId: p.unitId, assetId: p.assetId, planId: p.id, source: 'preventive', category: p.category, priority: p.nextDue < today() ? 'high' : 'normal', title: p.title, description: p.checklist.join(' · '), assigneeId: p.assigneeId, vendorId: p.vendorId, scheduledOn: p.nextDue, parts: [], labourCost: 0, vendorCost: p.vendorId ? p.estimatedCost : 0, beforePhotos: [], afterPhotos: [] }, 'Preventive plan'))
          return copy(created)
        }),
      housekeeping: () => later(() => copy(s.housekeeping)),
      setHousekeeping: (unitId, state, note) =>
        later(() => {
          const unit = catalog().unit(unitId)
          const record = housekeepingRecord(unitId)
          if (record.state !== state && !canMoveHousekeeping(record.state, state)) throw new RuleError('HOUSEKEEPING_INVALID_STATE', `${unit.code} is ${record.state}; it cannot become ${state} directly.`)
          const before = record.state
          // A turnover finishing takes the room type's amenity kit from the store; a short store warns and never blocks.
          const short = state === 'ready' && before !== 'ready' ? stock.issueKit(unitId, user()) : ''
          Object.assign(record, { state, updatedOn: today(), updatedBy: user().name, note: [note.trim(), short].filter(Boolean).join(' · ') })
          log('status', 'housekeeping', unit.code, `${unit.code} ${before} to ${state}`, { state: before }, { state })
          return copy(record)
        }),
      inspect: (unitId, results, raiseWorkOrder) =>
        later(() => {
          const unit = catalog().unit(unitId)
          const record = housekeepingRecord(unitId)
          if (record.state !== 'cleaning' && record.state !== 'inspected') throw new RuleError('HOUSEKEEPING_INVALID_STATE', `${unit.code} is ${record.state}; inspect it after cleaning.`)
          const failed = results.filter((r) => !r.ok)
          Object.assign(record, { state: failed.length ? 'dirty' : 'inspected', updatedOn: today(), updatedBy: user().name, note: failed.length ? `Failed: ${failed.map((f) => INSPECTION_LABEL[f.item]).join(', ')}` : 'Passed inspection', lastInspection: { on: today(), by: user().name, results: results.map((r) => ({ ...r })) } })
          let workOrder: WorkOrder | null = null
          const first = failed[0]
          if (raiseWorkOrder && first) {
            workOrder = newWorkOrder({ villaId: unit.villaId, unitId, assetId: null, planId: null, source: 'inspection', category: INSPECTION_CATEGORY[first.item], priority: 'normal', title: `Inspection ${unit.code}: ${INSPECTION_LABEL[first.item].toLowerCase()}`, description: failed.map((f) => INSPECTION_LABEL[f.item]).join(' · '), assigneeId: null, vendorId: null, scheduledOn: null, parts: [], labourCost: 0, vendorCost: 0, beforePhotos: [], afterPhotos: [] })
          }
          log('status', 'housekeeping', unit.code, failed.length ? `${unit.code} failed inspection` : `${unit.code} passed inspection`)
          return copy({ record, workOrder })
        }),
    },
    hr: {
      employees: () => later(() => copy(s.employees)),
      createEmployee: (input) =>
        later(() => {
          refuse(validateEmployee(input, s.employees))
          const e: Employee = { ...input, id: `emp-${String(seq('employee')).padStart(3, '0')}`, name: input.name.trim(), position: input.position.trim(), allocations: input.allocations.map((a) => ({ ...a })), allowances: input.allowances.map((a) => ({ ...a })) }
          s.employees.push(e)
          log('create', 'employee', e.code, `Added employee ${e.name}, ${e.position}`)
          return copy(e)
        }),
      updateEmployee: (id, input) =>
        later(() => {
          refuse(validateEmployee(input, s.employees, id))
          const e = employee(id)
          const before = { status: e.status, basicSalary: e.basicSalary, position: e.position }
          Object.assign(e, { ...input, name: input.name.trim(), position: input.position.trim(), allocations: input.allocations.map((a) => ({ ...a })), allowances: input.allowances.map((a) => ({ ...a })) })
          log('update', 'employee', e.code, `Edited employee ${e.name}`, before, { status: e.status, basicSalary: e.basicSalary, position: e.position })
          return copy(e)
        }),
      shifts: () => later(() => copy(s.shifts)),
      assignments: () => later(() => copy(s.assignments)),
      assignShift: (input) =>
        later(() => {
          employee(input.employeeId)
          if (input.shiftId) findById(s.shifts, input.shiftId, 'shift')
          catalog().villa(input.villaId)
          const existing = s.assignments.find((a) => a.employeeId === input.employeeId && a.date === input.date)
          if (existing) {
            Object.assign(existing, { shiftId: input.shiftId, villaId: input.villaId })
            return copy(existing)
          }
          const a: ShiftAssignment = { id: `asg-${seq('assignment')}`, ...input }
          s.assignments.push(a)
          return copy(a)
        }),
      attendance: () => later(() => copy(s.attendance)),
      recordAttendance: (input) =>
        later(() => {
          refuse(validateAttendance(input))
          const e = employee(input.employeeId)
          if (input.date > today()) throw new RuleError('VALIDATION_ERROR', 'Attendance is recorded on or after the day.')
          const shift = shiftFor(e.id, input.date)
          const late = input.status === 'late' ? Math.max(1, lateMinutes(input.clockIn, shift)) : 0
          const existing = s.attendance.find((a) => a.employeeId === e.id && a.date === input.date)
          const record: Attendance = { id: existing?.id ?? `att-${seq('attendance')}`, employeeId: e.id, date: input.date, status: input.status, clockIn: input.clockIn, clockOut: input.clockOut, lateMinutes: late, note: input.note.trim() }
          if (existing) Object.assign(existing, record)
          else s.attendance.push(record)
          log(existing ? 'update' : 'create', 'attendance', record.id, `${e.name} ${input.status} on ${input.date}`)
          return copy(record)
        }),
      leaves: () => later(() => copy(s.leaves)),
      requestLeave: (input) =>
        later(() => {
          const e = s.employees.find((x) => x.id === input.employeeId)
          refuse(validateLeave(input, e, e ? leaveBalance(e, s.leaves, input.from.slice(0, 4)) : 0))
          const n = seq('leave')
          const leave: LeaveRequest = { id: `lv-${n}`, number: `LV-${200 + n}`, employeeId: input.employeeId, kind: input.kind, from: input.from, to: input.to, days: leaveDays(input.from, input.to), reason: input.reason.trim(), status: 'pending', requestedOn: today(), decidedOn: null, decidedBy: '', decisionNote: '' }
          s.leaves.push(leave)
          log('create', 'leave', leave.number, `${e?.name} requested ${leave.days} days of ${input.kind} leave`)
          return copy(leave)
        }),
      decideLeave: (id, to, note) =>
        later(() => {
          const l = findById(s.leaves, id, 'leave request')
          decide(l, to, note, 'leave')
          if (to === 'approved') {
            for (const date of eachDay(l.from, addDays(l.to, 1))) {
              if (date > today()) break
              const existing = s.attendance.find((a) => a.employeeId === l.employeeId && a.date === date)
              const record: Attendance = { id: existing?.id ?? `att-${seq('attendance')}`, employeeId: l.employeeId, date, status: 'leave', clockIn: null, clockOut: null, lateMinutes: 0, note: l.number }
              if (existing) Object.assign(existing, record)
              else s.attendance.push(record)
            }
          }
          return copy(l)
        }),
      overtime: () => later(() => copy(s.overtime)),
      requestOvertime: (input) =>
        later(() => {
          refuse(validateOvertime(input))
          const e = employee(input.employeeId)
          catalog().villa(input.villaId)
          const n = seq('overtime')
          const o: OvertimeRequest = { id: `ot-${n}`, number: `OT-${300 + n}`, employeeId: e.id, date: input.date, hours: input.hours, villaId: input.villaId, reason: input.reason.trim(), status: 'pending', requestedOn: today(), decidedOn: null, decidedBy: '', decisionNote: '' }
          s.overtime.push(o)
          log('create', 'overtime', o.number, `${e.name} requested ${input.hours} h overtime on ${input.date}`)
          return copy(o)
        }),
      decideOvertime: (id, to, note) =>
        later(() => {
          const o = findById(s.overtime, id, 'overtime request')
          decide(o, to, note, 'overtime')
          return copy(o)
        }),
      loans: () => later(() => copy(s.loans)),
      requestLoan: (input) =>
        later(() => {
          const e = s.employees.find((x) => x.id === input.employeeId)
          refuse(validateLoan(input, e, s.loans))
          const n = seq('loan')
          const loan: Loan = { id: `ln-${n}`, number: `LN-${400 + n}`, employeeId: input.employeeId, kind: input.kind, amount: input.amount, installments: input.installments, monthly: loanInstalment(input.amount, input.installments), repaid: 0, reason: input.reason.trim(), status: 'pending', requestedOn: today(), startMonth: input.startMonth, decidedOn: null, decidedBy: '', decisionNote: '' }
          s.loans.push(loan)
          log('create', 'loan', loan.number, `${e?.name} requested a ${input.kind} of ${input.amount}`)
          return copy(loan)
        }),
      decideLoan: (id, to, note) =>
        later(() => {
          const l = findById(s.loans, id, 'loan')
          decide(l, to, note, 'loan')
          if (to === 'approved') l.status = 'active'
          return copy(l)
        }),
    },
    payroll: {
      settings: () => later(() => copy(s.payrollSettings)),
      saveSettings: (settings) =>
        later(() => {
          refuse(validatePayrollSettings(settings))
          const before = { ...s.payrollSettings }
          s.payrollSettings = { ...settings }
          log('update', 'payroll-settings', 'settings', 'Changed the payroll settings', before, { ...settings })
          return copy(s.payrollSettings)
        }),
      periods: () => later(() => copy(s.periods)),
      createPeriod: (month) =>
        later(() => {
          if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new RuleError('VALIDATION_ERROR', 'Pick a month as YYYY-MM.')
          if (s.periods.some((p) => p.month === month)) throw new RuleError('PAYROLL_EXISTS', `Payroll for ${month} already exists.`)
          const p: PayrollPeriod = { id: `pay-${month}`, month, status: 'draft', lines: [], revenueBase: 0, history: [{ kind: 'created', by: user().name, on: today(), note: '' }], transactionId: null, paidFromAccountId: null, published: false }
          p.lines = computePeriodLines(p, [])
          s.periods.push(p)
          s.periods.sort((a, b) => a.month.localeCompare(b.month))
          log('create', 'payroll', p.id, `Opened payroll ${month}`)
          return copy(p)
        }),
      calculate: (id) =>
        later(() => {
          const p = findById(s.periods, id, 'payroll period')
          if (p.status !== 'draft' && p.status !== 'calculated') throw new RuleError('PAYROLL_LOCKED', `Payroll ${p.month} is ${p.status}; reopen it to recalculate.`)
          p.lines = computePeriodLines(p)
          p.status = 'calculated'
          p.history = [...p.history, { kind: 'calculated', by: user().name, on: today(), note: `${p.lines.length} payslips` }]
          log('status', 'payroll', p.id, `Calculated payroll ${p.month}: ${periodTotals(p.lines).net} net`)
          return copy(p)
        }),
      addAdjustment: (id, employeeId, input) =>
        later(() => {
          const p = findById(s.periods, id, 'payroll period')
          if (p.status !== 'draft' && p.status !== 'calculated') throw new RuleError('PAYROLL_LOCKED', `Payroll ${p.month} is ${p.status}; reopen it to adjust a payslip.`)
          refuse(validatePayrollAdjustment(input))
          const line = p.lines.find((l) => l.employeeId === employeeId)
          if (!line) throw new RuleError('VALIDATION_ERROR', 'That employee is not on this payroll.')
          const adjustment: PayrollAdjustment = { id: `adj-${seq('adjustment')}`, kind: input.kind, amount: input.kind === 'deduction' ? -input.amount : input.amount, reason: input.reason.trim(), by: user().name, on: today() }
          const kept = p.lines.map((l) => (l.employeeId === employeeId ? { ...l, adjustments: [...l.adjustments, adjustment] } : l))
          p.lines = computePeriodLines(p, kept)
          log('update', 'payroll', p.id, `${input.kind} of ${input.amount} for ${line.employeeName}: ${input.reason}`)
          return copy(p)
        }),
      removeAdjustment: (id, employeeId, adjustmentId) =>
        later(() => {
          const p = findById(s.periods, id, 'payroll period')
          if (p.status !== 'draft' && p.status !== 'calculated') throw new RuleError('PAYROLL_LOCKED', `Payroll ${p.month} is ${p.status}.`)
          const kept = p.lines.map((l) => (l.employeeId === employeeId ? { ...l, adjustments: l.adjustments.filter((a) => a.id !== adjustmentId) } : l))
          p.lines = computePeriodLines(p, kept)
          return copy(p)
        }),
      transition: (id, to, note, accountId) =>
        later(() => {
          const p = findById(s.periods, id, 'payroll period')
          if (!canTransitionPayroll(p, to)) throw new RuleError('PAYROLL_INVALID_STATE', `Payroll ${p.month} is ${p.status}; it cannot become ${to}.`)
          const me = user()
          const before = p.status
          if (to === 'draft') {
            if (note.trim().length < 3) throw new RuleError('VALIDATION_ERROR', 'Say why the payroll reopens.')
            p.history = [...p.history, { kind: 'reopened', by: me.name, on: today(), note: note.trim() }]
          }
          if (to === 'approved') {
            if (p.history.some((h) => h.kind === 'calculated' && h.by === me.name) && me.role !== 'owner') throw new RuleError('APPROVAL_SELF', 'The person who calculated the payroll cannot approve it.')
            p.history = [...p.history, { kind: 'approved', by: me.name, on: today(), note: note.trim() }]
          }
          if (to === 'closed') {
            const account = s.cashAccounts.find((a) => a.id === accountId)
            if (!account) throw new RuleError('VALIDATION_ERROR', 'Pick the account the salaries are paid from.')
            ledger.assertOpen(today())
            const totals = periodTotals(p.lines)
            const t = newTransaction({ accountId: account.id, kind: 'cash_out', categoryId: 'cat-payroll', amount: totals.net, date: today(), locationId: account.locationId ?? s.locations[0]?.id ?? '', villaId: null, unitId: null, bookingId: null, description: `Salaries ${p.month}, ${totals.employees} employees`, reference: `PAY-${p.month}`, attachments: [], origin: 'payroll', transferId: null }, true)
            t.status = 'posted'
            t.history = [...t.history, event('approved', 'Payroll approval'), event('posted')]
            p.transactionId = t.id
            p.paidFromAccountId = account.id
            ledger.recordPosting(t)
            for (const line of p.lines) {
              if (line.loanDeduction <= 0) continue
              let left = line.loanDeduction
              for (const loan of s.loans.filter((l) => l.employeeId === line.employeeId && l.status === 'active')) {
                const take = Math.min(left, loan.amount - loan.repaid)
                loan.repaid += take
                left -= take
                if (loan.repaid >= loan.amount) loan.status = 'settled'
              }
            }
            p.history = [...p.history, { kind: 'closed', by: me.name, on: today(), note: `${totals.employees} payslips, ${t.number}` }]
          }
          p.status = to
          log('status', 'payroll', p.id, `Payroll ${p.month} ${before} to ${to}`, { status: before }, { status: to })
          return copy(p)
        }),
      publish: (id) =>
        later(() => {
          const p = findById(s.periods, id, 'payroll period')
          if (p.status !== 'closed') throw new RuleError('PAYROLL_INVALID_STATE', 'Close the payroll before publishing payslips.')
          p.published = true
          p.history = [...p.history, { kind: 'published', by: user().name, on: today(), note: '' }]
          log('status', 'payroll', p.id, `Published payslips for ${p.month}`)
          return copy(p)
        }),
    },
    people: {
      announcements: () => later(() => copy(s.announcements)),
      createAnnouncement: (input) =>
        later(() => {
          refuse(validateAnnouncement(input))
          const a: Announcement = { id: `ann-${seq('announcement')}`, ...input, title: input.title.trim(), body: input.body.trim(), publishedOn: today(), by: user().name }
          s.announcements.unshift(a)
          log('create', 'announcement', a.id, `Published “${a.title}”`)
          return copy(a)
        }),
      updateAnnouncement: (id, input) =>
        later(() => {
          refuse(validateAnnouncement(input))
          const a = findById(s.announcements, id, 'announcement')
          Object.assign(a, { ...input, title: input.title.trim(), body: input.body.trim() })
          return copy(a)
        }),
      deleteAnnouncement: (id) =>
        later(() => {
          const a = findById(s.announcements, id, 'announcement')
          s.announcements = s.announcements.filter((x) => x.id !== id)
          log('delete', 'announcement', id, `Removed “${a.title}”`)
        }),
      kpis: () => later(() => copy(s.kpis)),
      saveKpi: (id, input) =>
        later(() => {
          refuse(validateKpi(input))
          employee(input.employeeId)
          const existing = id ? findById(s.kpis, id, 'KPI review') : s.kpis.find((k) => k.employeeId === input.employeeId && k.period === input.period)
          const review: KpiReview = { id: existing?.id ?? `kpi-${seq('kpi')}`, employeeId: input.employeeId, period: input.period, items: input.items.map((i) => ({ ...i })), status: input.status, reviewer: user().name, note: input.note.trim(), reviewedOn: today() }
          if (existing) Object.assign(existing, review)
          else s.kpis.push(review)
          log(existing ? 'update' : 'create', 'kpi', review.id, `${input.status === 'published' ? 'Published' : 'Saved'} the ${input.period} review for ${employee(input.employeeId).name}`)
          return copy(review)
        }),
    },
    access: {
      session: () => later(() => copy(s.sessionUserId ? (s.users.find((u) => u.id === s.sessionUserId) ?? null) : null)),
      login: (input) =>
        later(() => {
          const u = s.users.find((x) => x.email.toLowerCase() === input.email.trim().toLowerCase())
          if (!u || s.passwords[u.id] !== input.password) {
            if (u) log('denied', 'session', u.id, `Failed sign-in for ${u.email}`, null, null, u)
            throw new RuleError('INVALID_CREDENTIALS', 'That email and password do not match.')
          }
          if (u.status === 'inactive') throw new RuleError('USER_INACTIVE', 'This login is deactivated. Ask the administrator.')
          s.sessionUserId = u.id
          u.lastLoginOn = today()
          log('login', 'session', u.id, `${u.name} signed in`)
          return copy(u)
        }),
      logout: () =>
        later(() => {
          if (s.sessionUserId) log('logout', 'session', s.sessionUserId, `${user().name} signed out`)
          s.sessionUserId = null
        }),
      changePassword: (input) =>
        later(() => {
          const me = user()
          refuse(validatePasswordChange(input))
          if (s.passwords[me.id] !== input.current) throw new RuleError('INVALID_CREDENTIALS', 'The current password is wrong.')
          s.passwords[me.id] = input.next
          log('update', 'user', me.id, `${me.name} changed their password`)
        }),
      users: () => later(() => copy(s.users)),
      createUser: (input) =>
        later(() => {
          refuse(validateUser(input, s.users))
          const u: User = { ...input, id: `usr-${seq('user')}`, name: input.name.trim(), locationIds: [...input.locationIds], villaIds: [...input.villaIds], lastLoginOn: null, createdOn: today() }
          s.users.push(u)
          s.passwords[u.id] = 'welcome123'
          log('create', 'user', u.id, `Added login for ${u.name} as ${ROLE_LABEL[u.role]}`)
          return copy(u)
        }),
      updateUser: (id, input) =>
        later(() => {
          refuse(validateUser(input, s.users, id))
          const u = findById(s.users, id, 'user')
          if (u.id === user().id && input.role !== u.role) throw new RuleError('ACCESS_SELF', 'You cannot change your own role.')
          const before = { role: u.role, status: u.status, locationIds: [...u.locationIds], villaIds: [...u.villaIds] }
          Object.assign(u, { ...input, name: input.name.trim(), locationIds: [...input.locationIds], villaIds: [...input.villaIds] })
          log('update', 'user', id, `Edited login ${u.name}`, before, { role: u.role, status: u.status, locationIds: [...u.locationIds], villaIds: [...u.villaIds] })
          return copy(u)
        }),
      setUserActive: (id, active) =>
        later(() => {
          const u = findById(s.users, id, 'user')
          if (u.id === user().id && !active) throw new RuleError('ACCESS_SELF', 'You cannot deactivate yourself.')
          const before = u.status
          u.status = active ? 'active' : 'inactive'
          log('update', 'user', id, `${active ? 'Activated' : 'Deactivated'} ${u.name}`, { status: before }, { status: u.status })
          return copy(u)
        }),
      permissions: () => later(() => copy(s.permissions)),
      savePermissions: (role, perms) =>
        later(() => {
          if (role === 'owner' && user().role !== 'owner') throw new RuleError('ACCESS_OWNER', 'Only the owner changes the owner’s permissions.')
          s.permissions = { ...s.permissions, [role]: structuredClone(perms) }
          log('update', 'permissions', role, `Changed the permissions of ${ROLE_LABEL[role]}`)
          return copy(s.permissions)
        }),
      audit: () => later(() => copy(s.audit)),
    },
    account: {
      profile: () =>
        later(() => {
          const u = user()
          return { userId: u.id, name: u.name, email: u.email, role: u.role, locationIds: [...u.locationIds], villaIds: [...u.villaIds], employeeId: u.employeeId, ...s.preferences }
        }),
      saveProfile: (profile) =>
        later(() => {
          const u = user()
          u.name = profile.name.trim()
          u.email = profile.email.trim()
          s.preferences = { notifyArrivals: profile.notifyArrivals, notifyApprovals: profile.notifyApprovals }
          return { userId: u.id, name: u.name, email: u.email, role: u.role, locationIds: [...u.locationIds], villaIds: [...u.villaIds], employeeId: u.employeeId, ...s.preferences }
        }),
    },
    audit: {
      businessDate: () => later(() => s.businessDate),
      audits: () => later(() => copy(s.nightAudits)),
      run: (input) =>
        later(() =>
          atomically(() => {
            const me = user()
            const problem = auditProblem(input.date, s.businessDate, today(), s.nightAudits)
            if (problem) throw new RuleError(problem.code, problem.message)
            ledger.assertOpen(input.date)
            // Every stay in house gets the night's room on its folio and receivable; a late check-in catches up the nights it missed.
            const stays = s.bookings.flatMap((b) => {
              const nights = nightsToPost(b, input.date)
              const first = nights[0]
              if (first === undefined) return []
              b.nightsPosted = [...(b.nightsPosted ?? []), ...nights.map(() => input.date)]
              ledger.recordNights(b, { from: first, to: first + nights.length }, input.date)
              return [{ bookingId: b.id, code: b.code, nights: nights.length, amount: nightsAmount(b, nights) }]
            })
            const audit: NightAudit = { id: `na-${seq('nightAudit')}`, date: input.date, ranAt: clockNow(), ranBy: me.name, checks: { ...input.checks }, noShows: [...input.noShows], stays, nights: stays.reduce((sum, x) => sum + x.nights, 0), roomRevenue: stays.reduce((sum, x) => sum + x.amount, 0) }
            s.nightAudits.push(audit)
            s.businessDate = addDays(input.date, 1)
            log('create', 'night-audit', input.date, `Closed business date ${input.date}: ${audit.nights} nights posted, ${audit.noShows.length} no-shows`, { businessDate: input.date }, { businessDate: s.businessDate, roomRevenue: audit.roomRevenue }, me)
            return copy(audit)
          }),
        ),
    },
  }
  return ports
}
