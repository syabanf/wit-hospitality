import { DEFAULT_PERMISSIONS, type AuditEntry, type Permissions, type Role, type User } from '@/domain/access'
import { DEFAULT_PROOF_POLICY, namedFile, type ProofPolicy } from '@/domain/attachment'
import type { AirbnbAccount, Listing } from '@/domain/airbnb'
import { requiredLevels, type ApprovalRule } from '@/domain/approval'
import { bookingTotal, revenueBetween, type Booking, type BookingSource, type BookingStatus, type UnitBlock } from '@/domain/booking'
import type { ApprovalGrant, CashAccount, Category, Reconciliation, Transaction, TransactionEvent } from '@/domain/finance'
import type { Guest } from '@/domain/guest'
import { lateMinutes, leaveDays, loanInstalment, type Attendance, type Employee, type LeaveRequest, type Loan, type OvertimeRequest, type Shift, type ShiftAssignment } from '@/domain/hr'
import type { Asset, HousekeepingRecord, HousekeepingState, PreventivePlan, Vendor, WorkOrder, WorkOrderEvent } from '@/domain/maintenance'
import { computeLine, DEFAULT_PAYROLL_SETTINGS, periodTotals, serviceChargeShare, type PayrollEvent, type PayrollPeriod, type PayrollSettings } from '@/domain/payroll'
import { DEFAULT_PAYMENT_POLICY, type Payment, type PaymentLink, type PaymentPolicy } from '@/domain/payment'
import { quarterOf, type Announcement, type KpiReview } from '@/domain/people'
import type { ServiceRequest } from '@/domain/roomService'
import { buildCatalog, type Catalog, type Location, type Unit, type UnitGroup, type Villa } from '@/domain/property'
import { addDays, addMonths, minIso, startOfMonth, weekdayIndex, type IsoDate } from '@/lib/dates'
import { APPROVAL_RULES, DEMO_PASSWORD, USERS } from './data/access'
import { PREFERENCES } from './data/account'
import { ACCOUNTS as AIRBNB_ACCOUNTS, LISTINGS } from './data/airbnb'
import { BLOCKS, EXTRA_BOOKINGS, expandPlans, UNIT_PLANS, type PlannedStay } from './data/bookings'
import { ACCOUNTS as CASH_ACCOUNTS, CATEGORIES, RECONCILIATIONS, TRANSACTIONS } from './data/finance'
import { GUESTS } from './data/guests'
import { EMPLOYEES, LEAVES, LOANS, OVERTIME, SHIFTS } from './data/hr'
import { ASSETS, HOUSEKEEPING_NOTES, PLANS, VENDORS, WORK_ORDERS } from './data/maintenance'
import { seedDeposit, seedPayments } from './data/payments'
import { ANNOUNCEMENTS, KPIS } from './data/people'
import { GROUPS, LOCATIONS, UNITS, VILLAS } from './data/property'
import { SERVICE_REQUESTS } from './data/services'
import { round } from './helpers'

/** Every table the mock API serves, built once from the seed files for one `today`. */
export interface MockState {
  today: IsoDate
  locations: Location[]
  villas: Villa[]
  units: Unit[]
  groups: UnitGroup[]
  /** Rebuilt from the four tables above, so edits show up in every lookup. */
  catalog(): Catalog
  accounts: AirbnbAccount[]
  listings: Listing[]
  guests: Guest[]
  bookings: Booking[]
  blocks: UnitBlock[]
  cashAccounts: CashAccount[]
  categories: Category[]
  transactions: Transaction[]
  reconciliations: Reconciliation[]
  approvalRules: ApprovalRule[]
  requests: ServiceRequest[]
  workOrders: WorkOrder[]
  assets: Asset[]
  vendors: Vendor[]
  plans: PreventivePlan[]
  housekeeping: HousekeepingRecord[]
  payments: Payment[]
  paymentLinks: PaymentLink[]
  paymentPolicy: PaymentPolicy
  proofPolicy: ProofPolicy
  employees: Employee[]
  shifts: Shift[]
  assignments: ShiftAssignment[]
  attendance: Attendance[]
  leaves: LeaveRequest[]
  overtime: OvertimeRequest[]
  loans: Loan[]
  payrollSettings: PayrollSettings
  periods: PayrollPeriod[]
  announcements: Announcement[]
  kpis: KpiReview[]
  users: User[]
  passwords: Record<string, string>
  permissions: Permissions
  audit: AuditEntry[]
  /** The signed-in user, or null between sign-out and sign-in. */
  sessionUserId: string | null
  preferences: { notifyArrivals: boolean; notifyApprovals: boolean }
  next: Record<string, number>
}

/** Deterministic Airbnb confirmation code from a sequence number. */
export const airbnbCode = (seq: number) => `HM${((seq * 2654435761) % 2176782336).toString(36).toUpperCase().padStart(6, '0').slice(-6)}`

function statusFor(checkIn: IsoDate, checkOut: IsoDate, today: IsoDate): BookingStatus {
  if (checkOut < today) return 'checked_out'
  if (checkIn < today) return 'checked_in'
  return 'confirmed'
}

/** The tables worth keeping between reloads; the catalog is rebuilt from them. */
export type Snapshot = Omit<MockState, 'catalog'>

export function snapshot(s: MockState): Snapshot {
  const { catalog: _catalog, ...tables } = s
  return tables
}

export function restore(s: MockState, saved: Snapshot): void {
  Object.assign(s, saved)
}

/** Small integer hash for deterministic "random" seed choices. */
const hash = (a: number, b: number) => Math.abs(((a + 1) * 2654435761 + (b + 7) * 40503) % 1000)

const SIGNER: Record<Role, string> = {
  manager: 'Kadek Ariani',
  finance: 'Ida Bagus Rai',
  owner: 'Rama Wijaya',
  management: 'Arya Santoso',
  hr: 'Nia Kusuma',
  reservation: 'Dian Permata',
  staff: 'Wayan Sudiarta',
  admin: 'System administrator',
}

/** Payment fields the seed implies: Airbnb pays after arrival and keeps 3%; direct guests pay half up front. */
function paymentFor(b: Pick<Booking, 'source' | 'status' | 'checkIn' | 'checkOut' | 'nightlyRate'>, today: IsoDate) {
  const total = bookingTotal(b)
  if (b.source === 'airbnb') {
    // Airbnb pays out the day after arrival.
    const paid = (b.status === 'checked_in' || b.status === 'checked_out') && b.checkIn < today
    return { airbnbFee: round(total * 0.03, 1000), paymentStatus: paid ? ('paid' as const) : ('unpaid' as const), paidAmount: paid ? total : 0 }
  }
  if (b.status === 'checked_in' || b.status === 'checked_out') return { airbnbFee: 0, paymentStatus: 'paid' as const, paidAmount: total }
  if (b.status === 'confirmed') return { airbnbFee: 0, paymentStatus: 'partial' as const, paidAmount: seedDeposit(total, DEFAULT_PAYMENT_POLICY) }
  return { airbnbFee: 0, paymentStatus: 'unpaid' as const, paidAmount: 0 }
}

export function buildState(today: IsoDate): MockState {
  const catalog = buildCatalog(LOCATIONS, VILLAS, UNITS, GROUPS)
  const listingOf = (unitId: string) => LISTINGS.find((l) => l.unitId === unitId)
  const day = (offset: number) => addDays(today, offset)
  const month = (offset: number) => addMonths(startOfMonth(today), offset).slice(0, 7)

  const planned = expandPlans(UNIT_PLANS)
    .map((s) => ({ ...s, checkIn: day(s.startOffset) }))
    .sort((a, b) => a.checkIn.localeCompare(b.checkIn) || a.unitCode.localeCompare(b.unitCode))

  const fromPlan = (s: PlannedStay & { checkIn: IsoDate }, i: number): Booking => {
    const unit = catalog.unitByCode(s.unitCode)
    const listing = listingOf(unit.id)
    const source: BookingSource = s.source === 'airbnb' && listing ? 'airbnb' : 'direct'
    const checkOut = addDays(s.checkIn, s.nights)
    const status = statusFor(s.checkIn, checkOut, today)
    const guest = GUESTS[(s.unitIndex * 7 + s.stayIndex) % GUESTS.length]
    if (!guest) throw new Error('Guest rotation is empty')
    const base: Pick<Booking, 'source' | 'status' | 'checkIn' | 'checkOut' | 'nightlyRate'> = { source, status, checkIn: s.checkIn, checkOut, nightlyRate: source === 'airbnb' ? unit.nightlyRate : round(unit.nightlyRate * 0.9, 10_000) }
    return {
      id: `bk-${1000 + i}`,
      code: `BK-${1000 + i}`,
      guestId: guest.id,
      unitId: unit.id,
      requestedUnitId: unit.id,
      ...base,
      airbnbAccountId: source === 'airbnb' && listing ? listing.accountId : null,
      airbnbCode: source === 'airbnb' ? airbnbCode(1000 + i) : null,
      notes: '',
      ...paymentFor(base, today),
      movements: [],
      createdOn: addDays(s.checkIn, source === 'airbnb' ? -21 : -9),
      checkedInOn: status === 'checked_in' || status === 'checked_out' ? s.checkIn : null,
      checkedOutOn: status === 'checked_out' ? checkOut : null,
      arrival: status === 'checked_in' || status === 'checked_out' ? { idVerified: true, deposit: 0, keysHanded: true, rulesExplained: true, arrivalTime: '14:00', adults: 2, children: 0, notes: '' } : null,
      departure: status === 'checked_out' ? { depositReturned: 0, extraCharges: 0, roomInspected: true, keysReturned: true, notes: '' } : null,
    }
  }

  const extras: Booking[] = EXTRA_BOOKINGS.map((e) => {
    const unit = catalog.unitByCode(e.unitCode)
    const checkIn = day(e.startOffset)
    const base: Pick<Booking, 'source' | 'status' | 'checkIn' | 'checkOut' | 'nightlyRate'> = { source: e.source, status: e.status, checkIn, checkOut: addDays(checkIn, e.nights), nightlyRate: e.source === 'airbnb' ? unit.nightlyRate : round(unit.nightlyRate * 0.9, 10_000) }
    return {
      id: e.id,
      code: e.code,
      guestId: e.guestId,
      unitId: unit.id,
      requestedUnitId: catalog.unitByCode(e.requestedUnitCode).id,
      ...base,
      airbnbAccountId: e.airbnbAccountId,
      airbnbCode: e.airbnbCode,
      notes: e.notes,
      ...paymentFor(base, today),
      movements: e.movements.map((m) => ({ fromUnitId: catalog.unitByCode(m.fromUnitCode).id, toUnitId: catalog.unitByCode(m.toUnitCode).id, on: day(m.onOffset), reason: m.reason, by: SIGNER.manager })),
      createdOn: addDays(checkIn, -12),
      checkedInOn: null,
      checkedOutOn: null,
      arrival: null,
      departure: null,
    }
  })
  const bookingsAll = [...planned.map(fromPlan), ...extras]

  const rules = APPROVAL_RULES.map((r) => ({ ...r, levels: [...r.levels] }))
  const users: User[] = USERS.map(({ lastLoginDaysAgo, createdDaysAgo, ...u }) => ({ ...u, locationIds: [...u.locationIds], villaIds: [...u.villaIds], lastLoginOn: lastLoginDaysAgo === null ? null : day(-lastLoginDaysAgo), createdOn: day(-createdDaysAgo) }))
  const userByName = (name: string) => users.find((u) => u.name === name)
  const signerFor = (role: Role, locationId: string) => (role === 'manager' && locationId === 'loc-ubud' ? SIGNER.manager.replace('Kadek Ariani', 'Putu Eka Wijaya') : SIGNER[role])

  const transactions: Transaction[] = TRANSACTIONS.map((t) => {
    const on = day(-t.daysAgo)
    const creator = t.origin === 'payroll' || t.origin === 'transfer' || t.accountId === 'bank-bca' ? SIGNER.finance : signerFor('manager', t.locationId)
    const creatorRole: Role = creator === SIGNER.finance ? 'finance' : 'manager'
    const levels = requiredLevels(rules, t)
    const history: TransactionEvent[] = [{ kind: 'created', by: creator, role: creatorRole, on, note: '' }]
    const approvals: ApprovalGrant[] = []
    const sign = (count: number) => {
      levels.slice(0, count).forEach((role, i) => {
        const by = signerFor(role, t.locationId)
        approvals.push({ level: i + 1, role, by, on, note: '' })
        history.push({ kind: 'approved', by, role, on, note: i + 1 === levels.length ? 'All levels signed' : `Level ${i + 1} of ${levels.length}` })
      })
    }
    if (t.status !== 'draft') history.push({ kind: 'submitted', by: creator, role: creatorRole, on, note: '' })
    if (t.status === 'submitted' && t.seq === 33) sign(1)
    if (t.status === 'approved') sign(levels.length)
    if (t.status === 'posted' || t.status === 'reversed') {
      sign(levels.length)
      history.push({ kind: 'posted', by: SIGNER.finance, role: 'finance', on, note: '' })
    }
    if (t.status === 'rejected') history.push({ kind: 'rejected', by: signerFor('manager', t.locationId), role: 'manager', on: addDays(on, 1), note: t.rejectionReason ?? '' })
    if (t.status === 'reversed') history.push({ kind: 'reversed', by: SIGNER.finance, role: 'finance', on: day(-(TRANSACTIONS.find((o) => o.reversalOfSeq === t.seq)?.daysAgo ?? t.daysAgo)), note: '' })
    return {
      id: `tx-${t.seq}`,
      number: `TX-${2400 + t.seq}`,
      accountId: t.accountId,
      kind: t.kind,
      categoryId: t.categoryId,
      amount: t.amount,
      date: on,
      locationId: t.locationId,
      villaId: t.villaId,
      unitId: t.unitId,
      bookingId: t.bookingId,
      description: t.description,
      reference: t.reference ?? '',
      attachments: (t.attachments ?? []).map((name) => namedFile(name, creator, `${on}T09:00:00`)),
      origin: t.origin ?? (t.reversalOfSeq ? 'reversal' : 'manual'),
      status: t.status,
      approvals,
      history,
      rejectionReason: t.rejectionReason ?? null,
      transferId: t.transferSeq ? `trf-${t.transferSeq}` : null,
      reversalOf: t.reversalOfSeq ? `tx-${t.reversalOfSeq}` : null,
      reversedBy: TRANSACTIONS.find((o) => o.reversalOfSeq === t.seq) ? `tx-${TRANSACTIONS.find((o) => o.reversalOfSeq === t.seq)?.seq}` : null,
      createdBy: creator,
      createdById: userByName(creator)?.id ?? 'usr-kadek',
      createdOn: on,
    }
  })

  const cashAccounts: CashAccount[] = CASH_ACCOUNTS.map(({ openedDaysAgo, ...a }) => ({ ...a, openedOn: day(-openedDaysAgo) }))
  const reconciliations: Reconciliation[] = RECONCILIATIONS.map((r) => {
    const account = cashAccounts.find((a) => a.id === r.accountId)
    const on = day(-r.daysAgo)
    const expected = transactions.filter((t) => t.accountId === r.accountId && (t.status === 'posted' || t.status === 'reversed') && t.date <= on && !(r.adjustmentSeq && t.id === `tx-${r.adjustmentSeq}`)).reduce((s, t) => s + (t.kind === 'cash_in' ? t.amount : -t.amount), account?.openingBalance ?? 0)
    return { id: r.id, accountId: r.accountId, date: on, expected, counted: expected + r.difference, difference: r.difference, note: r.note, by: r.by, adjustmentId: r.adjustmentSeq ? `tx-${r.adjustmentSeq}` : null }
  })

  const requests: ServiceRequest[] = SERVICE_REQUESTS.map((r) => {
    const unit = catalog.unitByCode(r.unitCode)
    const on = day(-r.daysAgo)
    const stay = r.withStay ? bookingsAll.find((b) => b.unitId === unit.id && (b.status === 'checked_in' || b.status === 'checked_out') && b.checkIn <= on && on < b.checkOut) : undefined
    return {
      id: `rq-${r.seq}`,
      number: `RQ-${100 + r.seq}`,
      unitId: unit.id,
      bookingId: stay?.id ?? null,
      kind: r.kind,
      priority: r.priority,
      note: r.note,
      charge: r.charge,
      status: r.status,
      assignee: r.assignee,
      requestedOn: on,
      requestedAt: r.at,
      doneOn: r.status === 'done' ? on : null,
      transactionId: null,
    }
  })

  const employees: Employee[] = EMPLOYEES.map(({ joinedDaysAgo, leftDaysAgo, dayOff: _dayOff, shiftId: _shiftId, ...e }) => ({ ...e, allocations: e.allocations.map((a) => ({ ...a })), allowances: e.allowances.map((a) => ({ ...a })), joinedOn: day(-joinedDaysAgo), leftOn: leftDaysAgo === null ? null : day(-leftDaysAgo) }))
  const shifts: Shift[] = SHIFTS.map((s) => ({ ...s }))
  const shiftOf = (id: string) => shifts.find((s) => s.id === id) ?? null

  const leaves: LeaveRequest[] = LEAVES.map((l) => ({
    id: `lv-${l.seq}`,
    number: `LV-${200 + l.seq}`,
    employeeId: l.employeeId,
    kind: l.kind,
    from: day(l.fromOffset),
    to: day(l.toOffset),
    days: leaveDays(day(l.fromOffset), day(l.toOffset)),
    reason: l.reason,
    status: l.status,
    requestedOn: day(-l.requestedDaysAgo),
    decidedOn: l.status === 'pending' ? null : day(-Math.max(0, l.requestedDaysAgo - 1)),
    decidedBy: l.decidedBy,
    decisionNote: l.decisionNote,
  }))
  const onLeave = (employeeId: string, date: IsoDate) => leaves.some((l) => l.employeeId === employeeId && l.status === 'approved' && l.from <= date && date <= l.to)

  const assignments: ShiftAssignment[] = []
  const attendance: Attendance[] = []
  let nextAssignment = 1
  let nextAttendance = 1
  EMPLOYEES.forEach((seed, index) => {
    const employee = employees[index]
    if (!employee) return
    const home = employee.allocations[0]?.villaId ?? 'vil-saka'
    for (let offset = -60; offset <= 14; offset++) {
      const date = day(offset)
      if (date < employee.joinedOn || (employee.leftOn && date >= employee.leftOn)) continue
      const off = weekdayIndex(date) === seed.dayOff
      if (offset >= -14) assignments.push({ id: `asg-${nextAssignment++}`, employeeId: employee.id, date, shiftId: off ? null : seed.shiftId, villaId: home })
      if (offset > 0) continue
      const shift = shiftOf(seed.shiftId)
      const h = hash(index, offset)
      let status: Attendance['status'] = 'present'
      let clockIn: string | null = shift?.start ?? null
      let clockOut: string | null = shift?.end ?? null
      let late = 0
      if (off) {
        status = 'off'
        clockIn = null
        clockOut = null
      } else if (onLeave(employee.id, date)) {
        status = 'leave'
        clockIn = null
        clockOut = null
      } else if (h % 29 === 0) {
        status = 'absent'
        clockIn = null
        clockOut = null
      } else if (h % 7 === 0 && shift) {
        late = 5 + (h % 36)
        const start = Number(shift.start.slice(0, 2)) * 60 + Number(shift.start.slice(3)) + late
        clockIn = `${String(Math.floor(start / 60) % 24).padStart(2, '0')}:${String(start % 60).padStart(2, '0')}`
        status = 'late'
      }
      if (status === 'off' && offset < -1) continue
      attendance.push({ id: `att-${nextAttendance++}`, employeeId: employee.id, date, status, clockIn, clockOut, lateMinutes: status === 'late' ? lateMinutes(clockIn, shift) : 0, note: status === 'absent' ? 'No notice given' : '' })
    }
  })

  const overtime: OvertimeRequest[] = OVERTIME.map((o) => ({
    id: `ot-${o.seq}`,
    number: `OT-${300 + o.seq}`,
    employeeId: o.employeeId,
    date: day(o.dayOffset),
    hours: o.hours,
    villaId: o.villaId,
    reason: o.reason,
    status: o.status,
    requestedOn: day(o.dayOffset),
    decidedOn: o.status === 'pending' ? null : day(Math.min(0, o.dayOffset + 1)),
    decidedBy: o.decidedBy,
    decisionNote: o.status === 'rejected' ? 'Festival rounds are part of the night shift.' : '',
  }))

  const loans: Loan[] = LOANS.map((l) => ({
    id: `ln-${l.seq}`,
    number: `LN-${400 + l.seq}`,
    employeeId: l.employeeId,
    kind: l.kind,
    amount: l.amount,
    installments: l.installments,
    monthly: loanInstalment(l.amount, l.installments),
    repaid: l.repaid,
    reason: l.reason,
    status: l.status,
    requestedOn: day(-l.requestedDaysAgo),
    startMonth: month(-l.startMonthsAgo),
    decidedOn: l.status === 'pending' ? null : day(-Math.max(0, l.requestedDaysAgo - 2)),
    decidedBy: l.decidedBy,
    decisionNote: '',
  }))

  const payrollSettings = { ...DEFAULT_PAYROLL_SETTINGS }
  const buildPeriod = (m: string, status: PayrollPeriod['status'], transactionId: string | null): PayrollPeriod => {
    const from = `${m}-01`
    const to = addMonths(from, 1)
    const revenueBase = revenueBetween(bookingsAll, from, to)
    const staff = employees.filter((e) => e.status !== 'inactive' || (e.leftOn && e.leftOn > from))
    const eligible = staff.filter((e) => e.serviceChargeEligible).length
    const share = serviceChargeShare(revenueBase, payrollSettings, eligible)
    const lines = staff.map((employee) => computeLine({ employee, settings: payrollSettings, month: m, attendance, overtime, loans, adjustments: employee.id === 'emp-004' && status === 'closed' ? [{ id: `adj-${m}-1`, kind: 'reimbursement', amount: 250_000, reason: 'Spare parts bought with own money', by: SIGNER.hr, on: `${m}-26` }] : [], serviceCharge: share }))
    const closedOn = minIso(addDays(to, 1), today)
    const history: PayrollEvent[] = [
      { kind: 'created', by: SIGNER.hr, on: addDays(to, -5), note: '' },
      { kind: 'calculated', by: SIGNER.hr, on: addDays(to, -3), note: '' },
    ]
    if (status === 'approved' || status === 'closed') history.push({ kind: 'approved', by: SIGNER.finance, on: addDays(to, -2), note: '' })
    if (status === 'closed') history.push({ kind: 'closed', by: SIGNER.finance, on: closedOn, note: `${periodTotals(lines).employees} payslips` }, { kind: 'published', by: SIGNER.hr, on: closedOn, note: '' })
    return { id: `pay-${m}`, month: m, status, lines, revenueBase, history, transactionId, paidFromAccountId: transactionId ? 'bank-bca' : null, published: status === 'closed' }
  }
  const periods: PayrollPeriod[] = [buildPeriod(month(-2), 'closed', 'tx-45'), buildPeriod(month(-1), 'closed', 'tx-19'), buildPeriod(month(0), 'calculated', null)]

  const announcements: Announcement[] = ANNOUNCEMENTS.map(({ daysAgo, ...a }) => ({ ...a, publishedOn: day(-daysAgo) }))
  const quarter = (ago: number) => {
    const q = quarterOf(today)
    const n = Number(q.slice(-1)) - ago
    return n >= 1 ? `${q.slice(0, 4)}-Q${n}` : `${Number(q.slice(0, 4)) - 1}-Q${n + 4}`
  }
  const kpis: KpiReview[] = KPIS.map((k, i) => ({ id: `kpi-${i + 1}`, employeeId: k.employeeId, period: quarter(k.quartersAgo), items: k.items.map((it) => ({ ...it })), status: k.status, reviewer: k.reviewer, note: k.note, reviewedOn: k.quartersAgo ? day(-70) : day(-4 - i) }))

  const audit: AuditEntry[] = []
  let nextAudit = 1
  const log = (at: IsoDate, name: string, action: AuditEntry['action'], entity: string, entityId: string, summary: string, time = '09:30') => {
    const u = userByName(name) ?? users[0]
    if (!u) return
    audit.push({ id: `aud-${nextAudit++}`, at: `${at}T${time}:00`, userId: u.id, userName: u.name, role: u.role, action, entity, entityId, summary, before: null, after: null })
  }
  for (const t of transactions) {
    for (const e of t.history) {
      const action = e.kind === 'created' ? 'create' : e.kind === 'approved' ? 'approve' : e.kind === 'rejected' ? 'reject' : 'status'
      log(e.on, e.by, action, 'transaction', t.number, `${e.kind === 'created' ? 'Recorded' : e.kind.charAt(0).toUpperCase() + e.kind.slice(1)} ${t.number}, ${t.description}`, e.kind === 'created' ? '08:40' : e.kind === 'posted' ? '16:10' : '11:20')
    }
  }
  for (const u of users) if (u.lastLoginOn) log(u.lastLoginOn, u.name, 'login', 'session', u.id, `${u.name} signed in`, '07:55')
  log(day(-1), SIGNER.manager, 'update', 'booking', 'BK-2001', 'Moved BK-2001 from SK-03 to SK-05: pool pump replacement', '10:05')
  log(day(-2), SIGNER.hr, 'approve', 'leave', 'LV-203', 'Approved annual leave for Dewa Agung Putra', '13:15')
  log(day(-3), SIGNER.finance, 'create', 'reconciliation', 'rec-2', 'Counted the Uluwatu cashbox: short by Rp 150.000', '17:30')
  log(day(-9), SIGNER.admin, 'update', 'user', 'usr-agus', 'Deactivated Agus Pratama after leaving', '09:00')
  log(day(0), SIGNER.staff, 'denied', 'transaction', 'TX-2433', 'Tried to approve TX-2433 without the approve permission', '08:12')
  audit.sort((a, b) => b.at.localeCompare(a.at))

  const unitIdOf = (code: string | null) => (code ? catalog.unitByCode(code).id : null)
  const workOrders: WorkOrder[] = WORK_ORDERS.map((w) => {
    const history: WorkOrderEvent[] = [{ kind: 'created', by: w.reportedBy, on: day(-w.createdDaysAgo), note: w.description }]
    const step = (kind: WorkOrderEvent['kind'], offset: number | null, by: string) => {
      if (offset !== null) history.push({ kind, by, on: day(offset), note: '' })
    }
    step('scheduled', w.scheduledOffset !== null && w.status !== 'open' ? -w.createdDaysAgo : null, SIGNER.manager)
    step('in_progress', w.startedOffset, SIGNER.manager)
    if (w.status === 'on_hold') history.push({ kind: 'on_hold', by: SIGNER.manager, on: day(-Math.max(0, w.createdDaysAgo - 5)), note: w.note })
    step('done', w.finishedOffset, SIGNER.manager)
    step('verified', w.verifiedOffset, SIGNER.manager)
    if (w.status === 'cancelled') history.push({ kind: 'cancelled', by: SIGNER.manager, on: day(-w.createdDaysAgo + 1), note: w.note })
    else if (w.note) history.push({ kind: 'note', by: SIGNER.manager, on: day(-Math.max(0, w.createdDaysAgo - 1)), note: w.note })
    if (w.transactionSeq) history.push({ kind: 'cost', by: SIGNER.manager, on: day(-(TRANSACTIONS.find((t) => t.seq === w.transactionSeq)?.daysAgo ?? w.createdDaysAgo)), note: `TX-${2400 + w.transactionSeq}` })
    history.sort((a, b) => a.on.localeCompare(b.on))
    return {
      id: `wo-${w.seq}`,
      number: `WO-${500 + w.seq}`,
      villaId: w.villaId,
      unitId: unitIdOf(w.unitCode),
      assetId: w.assetId,
      planId: w.planId,
      source: w.source,
      category: w.category,
      priority: w.priority,
      title: w.title,
      description: w.description,
      reportedBy: w.reportedBy,
      assigneeId: w.assigneeId,
      vendorId: w.vendorId,
      status: w.status,
      createdOn: day(-w.createdDaysAgo),
      scheduledOn: w.scheduledOffset === null ? null : day(w.scheduledOffset),
      startedOn: w.startedOffset === null ? null : day(w.startedOffset),
      finishedOn: w.finishedOffset === null ? null : day(w.finishedOffset),
      verifiedOn: w.verifiedOffset === null ? null : day(w.verifiedOffset),
      beforePhotos: [...w.beforePhotos],
      afterPhotos: [...w.afterPhotos],
      parts: w.parts.map((p) => ({ ...p })),
      labourCost: w.labourCost,
      vendorCost: w.vendorCost,
      blockId: w.blockId,
      expenses: (() => {
        const t = w.transactionSeq ? TRANSACTIONS.find((x) => x.seq === w.transactionSeq) : undefined
        if (!t) return []
        const vendor = VENDORS.find((v) => v.id === w.vendorId)
        return [{ id: `exp-wo-${w.seq}-1`, line: 1, kind: vendor ? ('vendor' as const) : ('parts' as const), description: w.title, payee: vendor?.name ?? 'Local shop', vendorId: vendor?.id ?? null, amount: t.amount, method: t.accountId.startsWith('cb-') ? ('cash' as const) : ('bank_transfer' as const), reference: t.reference ?? `WO-${500 + w.seq}`, receipts: (t.attachments ?? []).map((name) => namedFile(name, SIGNER.manager, `${day(-t.daysAgo)}T09:00:00`)), paidOn: day(-t.daysAgo), transactionId: `tx-${t.seq}`, createdBy: SIGNER.manager, createdOn: day(-t.daysAgo) }]
      })(),
      history,
    }
  })
  const assets: Asset[] = ASSETS.map(({ unitCode, boughtDaysAgo, warrantyDays, ...a }) => ({ ...a, unitId: unitIdOf(unitCode), purchasedOn: day(-boughtDaysAgo), warrantyUntil: warrantyDays === null ? null : day(warrantyDays - boughtDaysAgo) }))
  const plans: PreventivePlan[] = PLANS.map(({ unitCode, dueOffset, lastDoneDaysAgo, ...p }) => ({ ...p, checklist: [...p.checklist], unitId: unitIdOf(unitCode), nextDue: day(dueOffset), lastDoneOn: lastDoneDaysAgo === null ? null : day(-lastDoneDaysAgo), active: true }))

  /** Today's board: arrivals split across cleaning and inspected, units freed yesterday dirty, the rest ready. */
  const arrivalsToday = bookingsAll.filter((b) => b.status === 'confirmed' && b.checkIn === today).map((b) => b.unitId)
  const freedYesterday = bookingsAll.filter((b) => b.status === 'checked_out' && b.checkOut === day(-1)).map((b) => b.unitId)
  const occupied = new Set(bookingsAll.filter((b) => b.status === 'checked_in' && b.checkIn < today && b.checkOut > today).map((b) => b.unitId))
  const housekeeping: HousekeepingRecord[] = UNITS.filter((u) => u.status !== 'inactive').map((u) => {
    const arrivalIndex = arrivalsToday.indexOf(u.id)
    let state: HousekeepingState = 'ready'
    if (arrivalIndex === 0) state = 'cleaning'
    if (arrivalIndex === 1) state = 'inspected'
    if (arrivalIndex === 2 || (freedYesterday.includes(u.id) && !occupied.has(u.id))) state = 'dirty'
    return { unitId: u.id, state, updatedOn: today, updatedBy: SIGNER.staff, note: HOUSEKEEPING_NOTES[state] ?? '', lastInspection: null }
  })

  const paymentSeed = seedPayments(bookingsAll, today, DEFAULT_PAYMENT_POLICY)

  const state: MockState = {
    today,
    locations: LOCATIONS.map((l) => ({ ...l })),
    villas: VILLAS.map((v) => ({ ...v })),
    units: UNITS.map((u) => ({ ...u })),
    groups: GROUPS.map((g) => ({ ...g })),
    catalog: () => buildCatalog(state.locations, state.villas, state.units, state.groups),
    accounts: AIRBNB_ACCOUNTS.map((a) => ({ ...a })),
    listings: LISTINGS.map((l) => ({ ...l })),
    guests: GUESTS.map(({ createdDaysAgo, ...g }) => ({ ...g, createdOn: day(-createdDaysAgo) })),
    bookings: bookingsAll,
    blocks: BLOCKS.map((k) => ({ id: k.id, unitId: catalog.unitByCode(k.unitCode).id, from: day(k.fromOffset), to: day(k.toOffset), reason: k.reason, note: k.note })),
    cashAccounts,
    categories: CATEGORIES.map((c) => ({ ...c, villaIds: [...c.villaIds] })),
    transactions,
    reconciliations,
    approvalRules: rules,
    requests,
    workOrders,
    assets,
    vendors: VENDORS.map((v) => ({ ...v })),
    plans,
    housekeeping,
    payments: paymentSeed.payments,
    paymentLinks: paymentSeed.links,
    paymentPolicy: { ...DEFAULT_PAYMENT_POLICY },
    proofPolicy: { ...DEFAULT_PROOF_POLICY },
    employees,
    shifts,
    assignments,
    attendance,
    leaves,
    overtime,
    loans,
    payrollSettings,
    periods,
    announcements,
    kpis,
    users,
    passwords: Object.fromEntries(users.map((u) => [u.id, DEMO_PASSWORD])),
    permissions: structuredClone(DEFAULT_PERMISSIONS),
    audit,
    sessionUserId: 'usr-rama',
    preferences: { ...PREFERENCES },
    next: {
      booking: 3001,
      guest: GUESTS.length + 1,
      transaction: TRANSACTIONS.length + 1,
      block: BLOCKS.length + 1,
      category: CATEGORIES.length + 1,
      entity: 1,
      request: SERVICE_REQUESTS.length + 1,
      workOrder: WORK_ORDERS.length + 1,
      asset: ASSETS.length + 1,
      vendor: VENDORS.length + 1,
      plan: PLANS.length + 1,
      transfer: 100,
      reconciliation: RECONCILIATIONS.length + 1,
      rule: APPROVAL_RULES.length + 1,
      employee: EMPLOYEES.length + 1,
      assignment: nextAssignment,
      attendance: nextAttendance,
      leave: LEAVES.length + 1,
      overtime: OVERTIME.length + 1,
      loan: LOANS.length + 1,
      adjustment: 1,
      announcement: ANNOUNCEMENTS.length + 1,
      kpi: KPIS.length + 1,
      user: USERS.length + 1,
      audit: nextAudit,
      payment: paymentSeed.next,
      link: 1,
    },
  }
  return state
}
