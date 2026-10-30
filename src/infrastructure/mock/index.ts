import type { Clock, Ports } from '@/application/ports'
import { ROLE_LABEL, validatePasswordChange, validateUser, type AuditAction, type User } from '@/domain/access'
import { validateAirbnbAccount, validateListing } from '@/domain/airbnb'
import { approvalProgress, canSignLevel, requiredLevels, validateApprovalRule } from '@/domain/approval'
import { canTransition, findConflicts, occupies, validateCheckIn, validateCheckOut, validatePayment, validateStay, type Booking, type UnitBlock } from '@/domain/booking'
import { canEditRequest, canTransitionService, validateServiceRequest, type ServiceRequest } from '@/domain/roomService'
import { findById, NotFoundError, RuleError } from '@/domain/errors'
import { balance, canTransitionTransaction, isSystemCategory, validateAccount, validateAdjustment, validateReconciliation, validateTransaction, validateTransfer, type CashAccount, type Reconciliation, type Transaction, type TransactionEvent } from '@/domain/finance'
import type { Guest } from '@/domain/guest'
import { lateMinutes, leaveBalance, leaveDays, loanInstalment, REQUEST_TRANSITIONS, validateAttendance, validateEmployee, validateLeave, validateLoan, validateOvertime, type Attendance, type Employee, type LeaveRequest, type Loan, type OvertimeRequest, type ShiftAssignment } from '@/domain/hr'
import { canTransitionPayroll, computeLine, periodTotals, serviceChargeShare, validateAdjustment as validatePayrollAdjustment, validatePayrollSettings, type PayrollAdjustment, type PayrollLine, type PayrollPeriod } from '@/domain/payroll'
import { advanceDue, canAddExpense, canMoveHousekeeping, EXPENSE_KIND_LABEL, expenseReference, validateExpense, type ExpenseInput, type WorkOrderExpense, canTransitionWorkOrder, INSPECTION_CATEGORY, INSPECTION_LABEL, isOpenWorkOrder, validateAsset, validatePlan, validateVendor, validateWorkOrder, WORK_ORDER_STATUS_LABEL, type HousekeepingRecord, type WorkOrder, type WorkOrderEvent } from '@/domain/maintenance'
import { validateAnnouncement, validateKpi, type Announcement, type KpiReview } from '@/domain/people'
import { bookingTotal, revenueBetween } from '@/domain/booking'
import { balanceDueOn, gatewayFee, isGateway, netPaid, PAYMENT_KIND_LABEL, PAYMENT_METHOD_LABEL, qrPayloadFor, settledStatus, validatePayment as validateGuestPayment, validatePolicy, vaNumberFor, type Payment, type PaymentLink, type PaymentMethod, type PublicCheckout } from '@/domain/payment'
import { interchangeableWith, validateGroup, validateLocation, validateProperty, validateUnit, validateVilla } from '@/domain/property'
import { addDays, addMonths, daysBetween, eachDay } from '@/lib/dates'
import { wait } from './helpers'
import { airbnbCode, buildState, restore, snapshot, type Snapshot } from './state'

/**
 * In-memory stand-in for the Go API. It enforces the same rules the backend owns
 * (overlap, lifecycle, posted money, approval levels, sessions) and answers with the API's error codes.
 */
/** Where the demo keeps its changes for the day; the seed is rebuilt on a new day or a new seed version. */
export const DEMO_STORAGE_KEY = 'wit-demo-state'
const SEED_VERSION = 7

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
      try {
        localStorage.setItem(DEMO_STORAGE_KEY, JSON.stringify({ version: SEED_VERSION, today, state }))
      } catch {
        // Storage full or blocked: the demo keeps running in memory.
      }
    },
  }
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
  /** Demo-only whole-state copies the simulation page restores. */
  const snapshots = new Map<string, string>()
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
  /** The payment gateway acts without a session; the audit trail names it. */
  const GATEWAY: User = { id: 'usr-gateway', name: 'Payment gateway', email: 'gateway@balivillas.id', role: 'admin', status: 'active', locationIds: [], villaIds: [], employeeId: null, lastLoginOn: null, createdOn: '2026-01-01' }

  function createGuest(input: Omit<Guest, 'id' | 'createdOn'>): Guest {
    const guest: Guest = { ...input, id: `g-${String(seq('guest')).padStart(2, '0')}`, createdOn: today() }
    s.guests.push(guest)
    return guest
  }

  function assertFree(unitId: string, checkIn: string, checkOut: string, excludeId?: string) {
    const unit = catalog().unit(unitId)
    if (unit.status === 'inactive') throw new RuleError('UNIT_UNAVAILABLE', `${unit.code} is inactive.`)
    const conflicts = findConflicts(unitId, checkIn, checkOut, s.bookings, s.blocks, excludeId)
    const first = conflicts[0]
    if (first) throw new RuleError('BOOKING_OVERLAP', `${unit.code} is held by ${first.label} from ${first.from} to ${first.to}.`)
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

  function newTransaction(fields: Omit<Transaction, 'id' | 'number' | 'status' | 'approvals' | 'history' | 'rejectionReason' | 'reversalOf' | 'reversedBy' | 'createdBy' | 'createdById' | 'createdOn'>, submit: boolean, me: User = user()): Transaction {
    const n = seq('transaction')
    const t: Transaction = {
      ...fields,
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
    const to = addMonths(from, 1)
    const staff = s.employees.filter((e) => e.status !== 'inactive' || (e.leftOn && e.leftOn > from))
    const eligible = staff.filter((e) => e.serviceChargeEligible).length
    const revenue = revenueBetween(s.bookings, from, to)
    const share = serviceChargeShare(revenue, s.payrollSettings, eligible)
    p.revenueBase = revenue
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
  const stayTotal = (b: Booking) => bookingTotal(b)
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
  function bookMoney(p: Payment, actor: User) {
    const b = findById(s.bookings, p.bookingId, 'booking')
    const place = catalog().place(b.unitId)
    const guest = s.guests.find((g) => g.id === b.guestId)?.name ?? ''
    const account = accountFor(b, p.method)
    const base = { accountId: account.id, date: today(), locationId: place.location.id, villaId: place.villa.id, unitId: b.unitId, bookingId: b.id, reference: p.number, attachments: [], transferId: null }
    const refund = p.kind === 'refund'
    const t = newTransaction({ ...base, kind: refund ? 'cash_out' : 'cash_in', categoryId: refund ? 'cat-other' : p.method === 'airbnb_payout' ? 'cat-airbnb' : 'cat-room', amount: p.amount, description: `${PAYMENT_KIND_LABEL[p.kind]} ${p.number}, ${b.code} ${guest}`, origin: p.method === 'cash' ? 'front_desk' : 'payment' }, true, actor)
    p.transactionId = t.id
    if (p.gatewayFee > 0) {
      const fee = newTransaction({ ...base, kind: 'cash_out', categoryId: 'cat-fees', amount: p.gatewayFee, description: `${PAYMENT_METHOD_LABEL[p.method]} fee on ${p.number}`, origin: 'payment' }, true, actor)
      p.feeTransactionId = fee.id
    }
  }
  /** Pending links past their expiry turn expired when read. */
  function expireLinks() {
    const now = clockNow()
    for (const l of s.paymentLinks) {
      if (l.status !== 'pending' || l.expiresAt > now) continue
      l.status = 'expired'
      const p = s.payments.find((x) => x.id === l.paymentId)
      if (p && p.status === 'pending') {
        p.status = 'expired'
        p.history = [...p.history, { kind: 'expired', by: GATEWAY.name, at: now, note: 'Link expired unpaid' }]
      }
    }
  }
  function newPayment(b: Booking, fields: Pick<Payment, 'kind' | 'method' | 'amount' | 'status' | 'reference' | 'payer' | 'note'> & Partial<Payment>, actor: User): Payment {
    const n = seq('payment')
    const p: Payment = {
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
    s.payments.push(p)
    return p
  }
  function checkoutOf(l: PaymentLink): PublicCheckout {
    const b = findById(s.bookings, l.bookingId, 'booking')
    const p = findById(s.payments, l.paymentId, 'payment')
    const place = catalog().place(b.unitId)
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
      bookingCode: b.code,
      total: stayTotal(b),
      paidBefore: b.paidAmount - (p.status === 'paid' ? p.amount : 0),
      paidOn: p.paidOn,
      reference: p.reference,
    }
  }

  return {
    clock,
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
          const groups = input.groups.map((g) => ({ id: newId('grp', g.name), villaId: villa.id, name: g.name.trim(), interchangeable: g.interchangeable }))
          const units = input.rooms.map((r) => ({
            id: `unit-${r.code.toLowerCase()}`,
            villaId: villa.id,
            groupId: r.groupIndex === null ? null : (groups[r.groupIndex]?.id ?? null),
            code: r.code,
            name: r.name.trim(),
            bedrooms: r.bedrooms,
            nightlyRate: r.nightlyRate,
            status: 'active' as const,
            amenities: r.amenities,
          }))
          s.villas.push(villa)
          s.groups.push(...groups)
          s.units.push(...units)
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
          Object.assign(group, { ...input, name: input.name.trim() })
          return copy(group)
        }),
      createUnit: (input) =>
        later(() => {
          refuse(validateUnit(input, s.units, s.groups))
          findById(s.villas, input.villaId, 'villa')
          const unit = { id: `unit-${input.code.toLowerCase()}`, ...input, name: input.name.trim() }
          s.units.push(unit)
          log('create', 'unit', unit.id, `Added unit ${unit.code}`)
          return copy(unit)
        }),
      updateUnit: (id, input) =>
        later(() => {
          refuse(validateUnit(input, s.units, s.groups, id))
          const unit = findById(s.units, id, 'unit')
          if (input.status === 'inactive' && unit.status !== 'inactive' && s.bookings.some((b) => b.unitId === id && occupies(b) && b.checkOut > today()))
            throw new RuleError('UNIT_IN_USE', `${unit.code} still has confirmed stays. Move or cancel them first.`)
          const before = { status: unit.status, nightlyRate: unit.nightlyRate, name: unit.name }
          Object.assign(unit, { ...input, name: input.name.trim() })
          log('update', 'unit', id, `Edited unit ${unit.code}`, before, { status: unit.status, nightlyRate: unit.nightlyRate, name: unit.name })
          return copy(unit)
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
          const listing = { id: `lst-${unit.code.toLowerCase()}`, ...input, title: input.title.trim() }
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
    },
    booking: {
      bookings: () => later(() => copy(s.bookings)),
      blocks: () => later(() => copy(s.blocks)),
      create: (input) =>
        later(() => {
          const problem = validateStay(input.checkIn, input.checkOut)
          if (problem) throw new RuleError('VALIDATION_ERROR', problem)
          // A draft may sit on held nights; confirming it runs the exclusion check.
          if (input.confirm) assertFree(input.unitId, input.checkIn, input.checkOut)
          const guestId = input.guestId ?? (input.newGuest ? createGuest(input.newGuest).id : null)
          if (!guestId) throw new RuleError('VALIDATION_ERROR', 'A booking needs a guest.')
          const n = seq('booking')
          const booking: Booking = {
            id: `bk-${n}`,
            code: `BK-${n}`,
            guestId,
            unitId: input.unitId,
            requestedUnitId: input.unitId,
            source: input.source,
            airbnbAccountId: input.source === 'airbnb' ? input.airbnbAccountId : null,
            airbnbCode: input.source === 'airbnb' ? (input.airbnbCode?.trim() || airbnbCode(n)) : null,
            checkIn: input.checkIn,
            checkOut: input.checkOut,
            nightlyRate: input.nightlyRate,
            status: input.confirm ? 'confirmed' : 'draft',
            notes: input.notes.trim(),
            paymentStatus: 'unpaid',
            paidAmount: 0,
            airbnbFee: 0,
            movements: [],
            createdOn: today(),
            checkedInOn: null,
            checkedOutOn: null,
            arrival: null,
            departure: null,
          }
          s.bookings.push(booking)
          log('create', 'booking', booking.code, `${input.confirm ? 'Confirmed' : 'Drafted'} ${booking.code} in ${catalog().unit(input.unitId).code}`)
          return copy(booking)
        }),
      transition: (id, to) =>
        later(() => {
          const b = findById(s.bookings, id, 'booking')
          if (!canTransition(b, to)) throw new RuleError('BOOKING_INVALID_STATE', `A ${b.status.replace('_', ' ')} booking cannot become ${to.replace('_', ' ')}.`)
          if (to === 'confirmed') assertFree(b.unitId, b.checkIn, b.checkOut, b.id)
          const before = b.status
          b.status = to
          if (to === 'checked_in') b.checkedInOn = today()
          if (to === 'checked_out') b.checkedOutOn = today()
          log('status', 'booking', b.code, `${b.code} ${before.replace('_', ' ')} to ${to.replace('_', ' ')}`, { status: before }, { status: to })
          return copy(b)
        }),
      checkIn: (id, details) =>
        later(() => {
          const b = findById(s.bookings, id, 'booking')
          if (!canTransition(b, 'checked_in')) throw new RuleError('BOOKING_INVALID_STATE', `A ${b.status.replace('_', ' ')} booking cannot be checked in.`)
          refuse(validateCheckIn(details))
          b.status = 'checked_in'
          b.checkedInOn = today()
          b.arrival = { ...details, notes: details.notes.trim() }
          log('status', 'booking', b.code, `Checked in ${b.code}`, { status: 'confirmed' }, { status: 'checked_in', deposit: details.deposit })
          return copy(b)
        }),
      checkOut: (id, details) =>
        later(() => {
          const b = findById(s.bookings, id, 'booking')
          if (!canTransition(b, 'checked_out')) throw new RuleError('BOOKING_INVALID_STATE', `A ${b.status.replace('_', ' ')} booking cannot be checked out.`)
          refuse(validateCheckOut(details, b.arrival?.deposit ?? 0))
          b.status = 'checked_out'
          b.checkedOutOn = today()
          b.departure = { ...details, notes: details.notes.trim() }
          log('status', 'booking', b.code, `Checked out ${b.code}`, { status: 'checked_in' }, { status: 'checked_out', extraCharges: details.extraCharges })
          return copy(b)
        }),
      moveUnit: (id, unitId, reason) =>
        later(() => {
          const b = findById(s.bookings, id, 'booking')
          if (b.status === 'checked_out' || b.status === 'cancelled' || b.status === 'no_show') throw new RuleError('BOOKING_INVALID_STATE', 'This stay is over; nothing to move.')
          const target = catalog().unit(unitId)
          if (!interchangeableWith(catalog(), b.unitId).some((u) => u.id === unitId))
            throw new RuleError('UNIT_NOT_INTERCHANGEABLE', `${target.code} is not interchangeable with ${catalog().unit(b.unitId).code}.`)
          assertFree(unitId, b.checkIn, b.checkOut, b.id)
          const from = catalog().unit(b.unitId).code
          b.movements = [...b.movements, { fromUnitId: b.unitId, toUnitId: unitId, on: today(), reason, by: user().name }]
          b.unitId = unitId
          log('update', 'booking', b.code, `Moved ${b.code} from ${from} to ${target.code}: ${reason}`, { unit: from }, { unit: target.code })
          return copy(b)
        }),
      adjustStay: (id, checkIn, checkOut) =>
        later(() => {
          const b = findById(s.bookings, id, 'booking')
          if (b.status === 'checked_out' || b.status === 'cancelled' || b.status === 'no_show') throw new RuleError('BOOKING_INVALID_STATE', 'This stay is over; the dates are final.')
          if (b.status === 'checked_in' && checkIn !== b.checkIn) throw new RuleError('BOOKING_INVALID_STATE', 'The guest has checked in; only the check-out can move.')
          const problem = validateStay(checkIn, checkOut)
          if (problem) throw new RuleError('VALIDATION_ERROR', problem)
          assertFree(b.unitId, checkIn, checkOut, b.id)
          const before = { checkIn: b.checkIn, checkOut: b.checkOut }
          b.checkIn = checkIn
          b.checkOut = checkOut
          log('update', 'booking', b.code, `Changed the dates of ${b.code}`, before, { checkIn, checkOut })
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
          refuse(validatePayment(payment, (b.nightlyRate * (new Date(b.checkOut).getTime() - new Date(b.checkIn).getTime())) / 86_400_000, b.source))
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
    guest: {
      guests: () => later(() => copy(s.guests)),
      create: (input) => later(() => copy(createGuest(input))),
      update: (id, input) =>
        later(() => {
          const g = findById(s.guests, id, 'guest')
          Object.assign(g, input)
          return copy(g)
        }),
    },
    finance: {
      accounts: () => later(() => copy(s.cashAccounts)),
      createAccount: (input) =>
        later(() => {
          refuse(validateAccount(input, s.cashAccounts))
          const account: CashAccount = { id: newId('acc', input.name), ...input, name: input.name.trim() }
          s.cashAccounts.push(account)
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
            t.status = 'posted'
            t.history = [...t.history, event('posted', note)]
          }
          syncTwin(t)
          log(to === 'approved' ? 'approve' : to === 'rejected' ? 'reject' : 'status', 'transaction', t.number, `${to === 'approved' && t.status !== 'approved' ? 'Signed' : to.charAt(0).toUpperCase() + to.slice(1)} ${t.number}, ${t.description}`, { status: before }, { status: t.status })
          return copy(t)
        }),
      reverse: (id, reason) =>
        later(() => {
          const t = findById(s.transactions, id, 'transaction')
          if (t.status !== 'posted') throw new RuleError('TRANSACTION_INVALID_STATE', `Only posted entries can be reversed; ${t.number} is ${t.status}.`)
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
          log('status', 'transaction', t.number, `Reversed ${t.number} with ${reversal.number}: ${reason}`, { status: 'posted' }, { status: 'reversed' })
          return copy(reversal)
        }),
      transfer: (input) =>
        later(() => {
          refuse(validateTransfer(input, s.cashAccounts))
          const from = findById(s.cashAccounts, input.fromAccountId, 'account')
          const to = findById(s.cashAccounts, input.toAccountId, 'account')
          const transferId = `trf-${seq('transfer')}`
          const locationId = from.locationId ?? to.locationId ?? s.locations[0]?.id ?? ''
          const base = { amount: input.amount, date: input.date, locationId, villaId: null, unitId: null, bookingId: null, description: input.description.trim(), reference: input.reference.trim(), attachments: [], origin: 'transfer' as const, transferId }
          const out = newTransaction({ ...base, accountId: from.id, kind: 'cash_out', categoryId: 'cat-transfer-out' }, true)
          const back = newTransaction({ ...base, accountId: to.id, kind: 'cash_in', categoryId: 'cat-transfer-in' }, true)
          back.approvals = out.approvals
          return copy(out)
        }),
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
          const expected = balance(account, s.transactions, input.date)
          const difference = input.counted - expected
          let adjustmentId: string | null = null
          if (input.adjust && difference !== 0) {
            const kind = difference > 0 ? 'cash_in' : 'cash_out'
            adjustmentId = newTransaction({ accountId: account.id, kind, categoryId: kind === 'cash_in' ? 'cat-adjust-in' : 'cat-adjust-out', amount: Math.abs(difference), date: input.date, locationId: account.locationId ?? s.locations[0]?.id ?? '', villaId: null, unitId: null, bookingId: null, description: `Cash count ${difference > 0 ? 'over' : 'short'} on ${input.date}${input.note.trim() ? `: ${input.note.trim()}` : ''}`, reference: '', attachments: [], origin: 'reconciliation', transferId: null }, true).id
          }
          const r: Reconciliation = { id: `rec-${seq('reconciliation')}`, accountId: account.id, date: input.date, expected, counted: input.counted, difference, note: input.note.trim(), by: user().name, adjustmentId }
          s.reconciliations.push(r)
          log('create', 'reconciliation', r.id, `Counted ${account.name}: ${difference === 0 ? 'matched' : difference > 0 ? `over by ${difference}` : `short by ${-difference}`}`)
          return copy(r)
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
    },
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
    demo: {
      available: true,
      snapshot: () =>
        later(() => {
          const id = `snap-${snapshots.size + 1}`
          snapshots.set(id, JSON.stringify(snapshot(s)))
          return id
        }),
      restore: (id) =>
        later(() => {
          const saved = snapshots.get(id)
          if (!saved) throw new NotFoundError('snapshot', id)
          restore(s, JSON.parse(saved) as Snapshot)
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
          const paid = paidOf(b)
          refuse(validateGuestPayment(input, expectedOf(b) - paid, paid))
          if (input.kind === 'refund') throw new RuleError('VALIDATION_ERROR', 'Use refund on the payment that brought the money in.')
          if (isGateway(input.method)) throw new RuleError('VALIDATION_ERROR', `${PAYMENT_METHOD_LABEL[input.method]} goes through a payment link.`)
          const p = newPayment(b, { kind: input.kind, method: input.method, amount: input.amount, status: 'paid', reference: input.reference.trim(), payer: input.payer.trim(), note: input.note.trim(), paidOn: today() }, me)
          p.history = [...p.history, { kind: 'paid', by: me.name, at: clockNow(), note: PAYMENT_METHOD_LABEL[input.method] }]
          bookMoney(p, me)
          syncBooking(b.id)
          log('create', 'payment', p.number, `Recorded ${PAYMENT_KIND_LABEL[p.kind].toLowerCase()} ${p.number} on ${b.code}: ${p.amount}`)
          return copy(p)
        }),
      createLink: (input) =>
        later(() => {
          const me = user()
          const b = findById(s.bookings, input.bookingId, 'booking')
          const paid = paidOf(b)
          refuse(validateGuestPayment({ ...input, reference: '', note: '' }, expectedOf(b) - paid, paid))
          if (!isGateway(input.method)) throw new RuleError('VALIDATION_ERROR', 'Links are for QRIS, virtual account or card.')
          const n = seq('link')
          const token = `pl${n}${b.id.replace(/[^a-z0-9]/gi, '')}${(n * 2654435761 % 1_000_000).toString(36)}`
          const fee = gatewayFee(input.method, input.amount, s.paymentPolicy)
          const p = newPayment(b, { kind: input.kind, method: input.method, amount: input.amount, status: 'pending', reference: input.method === 'virtual_account' ? vaNumberFor(token) : '', payer: input.payer.trim(), note: '', dueOn: input.kind === 'balance' ? balanceDueOn(b.checkIn, s.paymentPolicy) : today(), gatewayFee: fee }, me)
          p.history = [...p.history, { kind: 'link_sent', by: me.name, at: clockNow(), note: `/pay/${token}` }]
          const link: PaymentLink = {
            token,
            bookingId: b.id,
            paymentId: p.id,
            method: input.method,
            amount: input.amount,
            createdAt: clockNow(),
            expiresAt: new Date(Date.parse(`${clockNow()}Z`) + s.paymentPolicy.linkExpiryHours * 3_600_000).toISOString().slice(0, 19),
            status: 'pending',
            vaBank: input.method === 'virtual_account' ? 'BCA' : '',
            vaNumber: input.method === 'virtual_account' ? vaNumberFor(token) : '',
            qrPayload: input.method === 'qris' ? qrPayloadFor(token, input.amount) : '',
            gatewayFee: fee,
          }
          s.paymentLinks.push(link)
          log('create', 'payment', p.number, `Sent a ${PAYMENT_METHOD_LABEL[input.method]} link for ${p.number} on ${b.code}`)
          return copy(link)
        }),
      cancelLink: (token) =>
        later(() => {
          const link = s.paymentLinks.find((x) => x.token === token)
          if (!link) throw new NotFoundError('payment link', token)
          if (link.status !== 'pending') throw new RuleError('PAYMENT_INVALID_STATE', `The link is ${link.status}.`)
          link.status = 'cancelled'
          const p = findById(s.payments, link.paymentId, 'payment')
          p.status = 'cancelled'
          p.history = [...p.history, { kind: 'cancelled', by: user().name, at: clockNow(), note: '' }]
          return copy(link)
        }),
      refund: (paymentId, amount, reason) =>
        later(() => {
          const me = user()
          const original = findById(s.payments, paymentId, 'payment')
          if (original.status !== 'paid' && original.status !== 'refunded') throw new RuleError('PAYMENT_INVALID_STATE', `${original.number} is ${original.status}; only paid money goes back.`)
          if (original.kind === 'refund') throw new RuleError('PAYMENT_INVALID_STATE', 'A refund cannot be refunded.')
          const already = s.payments.filter((x) => x.refundOf === original.id && x.status === 'paid').reduce((sum, x) => sum + x.amount, 0)
          const b = findById(s.bookings, original.bookingId, 'booking')
          refuse(validateGuestPayment({ bookingId: b.id, kind: 'refund', method: original.method, amount, reference: original.number, payer: '', note: reason }, 0, original.amount - already))
          const method: PaymentMethod = original.method === 'cash' ? 'cash' : 'bank_transfer'
          const p = newPayment(b, { kind: 'refund', method, amount, status: 'paid', reference: original.number, payer: s.guests.find((g) => g.id === b.guestId)?.name ?? '', note: reason.trim(), paidOn: today(), refundOf: original.id }, me)
          bookMoney(p, me)
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
        later(() => {
          expireLinks()
          const link = s.paymentLinks.find((x) => x.token === token)
          if (!link) throw new NotFoundError('payment link', token)
          if (link.status !== 'pending') throw new RuleError('PAYMENT_INVALID_STATE', `This link is ${link.status}.`)
          const p = findById(s.payments, link.paymentId, 'payment')
          if (outcome === 'failed') {
            link.status = 'failed'
            p.status = 'failed'
            p.history = [...p.history, { kind: 'failed', by: GATEWAY.name, at: clockNow(), note: 'Declined at the gateway' }]
            log('status', 'payment', p.number, `Gateway declined ${p.number}`, { status: 'pending' }, { status: 'failed' }, GATEWAY)
            return checkoutOf(link)
          }
          const b = findById(s.bookings, p.bookingId, 'booking')
          if (p.amount > expectedOf(b) - paidOf(b)) throw new RuleError('PAYMENT_OVERPAID', 'The booking is already paid.')
          link.status = 'paid'
          p.status = 'paid'
          p.paidOn = today()
          if (!p.reference) p.reference = `GW-${token.slice(-6).toUpperCase()}`
          p.history = [...p.history, { kind: 'paid', by: GATEWAY.name, at: clockNow(), note: PAYMENT_METHOD_LABEL[p.method] }]
          bookMoney(p, GATEWAY)
          syncBooking(b.id)
          log('status', 'payment', p.number, `Gateway confirmed ${p.number} on ${b.code}: ${p.amount}`, { status: 'pending' }, { status: 'paid' }, GATEWAY)
          return checkoutOf(link)
        }),
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
          Object.assign(t, expenseFields(w, input), { reference: expenseReference(w, e.line) })
          t.status = 'submitted'
          t.approvals = []
          t.rejectionReason = null
          t.history = [...t.history, event('resubmitted', 'Corrected from the work order')]
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
          Object.assign(record, { state, updatedOn: today(), updatedBy: user().name, note: note.trim() })
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
            const totals = periodTotals(p.lines)
            const t = newTransaction({ accountId: account.id, kind: 'cash_out', categoryId: 'cat-payroll', amount: totals.net, date: today(), locationId: account.locationId ?? s.locations[0]?.id ?? '', villaId: null, unitId: null, bookingId: null, description: `Salaries ${p.month}, ${totals.employees} employees`, reference: `PAY-${p.month}`, attachments: [], origin: 'payroll', transferId: null }, true)
            t.status = 'posted'
            t.history = [...t.history, event('approved', 'Payroll approval'), event('posted')]
            p.transactionId = t.id
            p.paidFromAccountId = account.id
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
  }
}
