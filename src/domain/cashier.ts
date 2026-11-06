import type { IsoDate } from '@/lib/dates'
import type { Role } from './access'
import type { Transaction, TransactionKind } from './finance'
import type { Payment, PaymentMethod } from './payment'

/**
 * Front desk cashier shifts, as a hotel PMS runs them: a cashier opens a shift on one cashbox with a
 * counted float, everything the desk records on that cashbox while it is open carries the shift, and
 * the shift closes on a counted drawer. The difference against what the drawer should hold goes to the
 * books through the cash count reconciliation; past the tolerance it needs a manager's sign-off first.
 */

/** Rupiah notes in the drawer, largest first; coins are counted as one rupiah amount. */
export const NOTES = [100_000, 50_000, 20_000, 10_000, 5_000, 2_000, 1_000] as const
export type Note = (typeof NOTES)[number]
export const noteLabel = (n: Note) => `${n / 1000}k`

/** A drawer counted by denomination: pieces per note plus the coins in rupiah. */
export interface DrawerCount {
  notes: Partial<Record<Note, number>>
  coins: number
}

export const emptyCount = (): DrawerCount => ({ notes: {}, coins: 0 })
export const countTotal = (c: DrawerCount) => NOTES.reduce((s, n) => s + n * (c.notes[n] ?? 0), 0) + c.coins

export function validateCount(c: DrawerCount): string | null {
  if (NOTES.some((n) => !Number.isInteger(c.notes[n] ?? 0) || (c.notes[n] ?? 0) < 0)) return 'Count each note in whole pieces, zero or more.'
  if (!Number.isInteger(c.coins) || c.coins < 0) return 'Enter the coins in whole rupiah, zero or more.'
  return null
}

/** Splits an amount into notes, largest first, with what is left as coins; for the seed and hand-overs. */
export function countFor(amount: number): DrawerCount {
  const notes: DrawerCount['notes'] = {}
  let left = amount
  for (const n of NOTES) {
    const pieces = Math.floor(left / n)
    if (pieces > 0) notes[n] = pieces
    left -= pieces * n
  }
  return { notes, coins: left }
}

export type ShiftStatus = 'open' | 'awaiting_signoff' | 'closed'
export const SHIFT_STATUSES: readonly ShiftStatus[] = ['open', 'awaiting_signoff', 'closed']
export const SHIFT_STATUS_LABEL: Record<ShiftStatus, string> = { open: 'Open', awaiting_signoff: 'Awaiting sign-off', closed: 'Closed' }
export const SHIFT_TRANSITIONS: Record<ShiftStatus, readonly ShiftStatus[]> = { open: ['closed', 'awaiting_signoff'], awaiting_signoff: ['closed'], closed: [] }

export interface ShiftSignOff {
  by: string
  /** ISO date-time. */
  at: string
  note: string
}

export interface CashierShift {
  id: string
  number: string
  /** The cashbox the drawer belongs to. */
  accountId: string
  locationId: string
  /** The user who opened the shift and answers for the drawer. */
  cashierId: string
  cashierName: string
  /** The business date the shift opened on. */
  businessDate: IsoDate
  /** ISO date-time. */
  openedAt: string
  openingCount: DrawerCount
  float: number
  /** The hand-over the float came from, when the cashier accepted the last closing count. */
  handOverId: string | null
  status: ShiftStatus
  /** ISO date-time of the count at close. */
  closedAt: string | null
  closingCount: DrawerCount | null
  counted: number | null
  /** Float plus cash in less cash out, fixed at close. */
  expected: number | null
  /** Counted less expected: over above zero, short below. */
  difference: number | null
  /** Why the drawer is over or short; required past the tolerance. */
  reason: string
  signOff: ShiftSignOff | null
  /** The cash count that took the difference to the books. */
  reconciliationId: string | null
  /** Cash taken to the safe or the bank after the count. */
  dropped: number
  dropTransactionId: string | null
  /** The hand-over that passed the rest of the drawer to the next shift. */
  handedOverId: string | null
}

/** The closing count of one shift accepted as the float of the next. */
export interface HandOver {
  id: string
  accountId: string
  fromShiftId: string
  toShiftId: string
  amount: number
  /** ISO date-time. */
  at: string
  from: string
  to: string
}

export interface ShiftPolicy {
  /** A difference above this, either way, needs a reason and a manager's sign-off. */
  tolerance: number
}
export const DEFAULT_SHIFT_POLICY: ShiftPolicy = { tolerance: 10_000 }

export function validateShiftPolicy(p: ShiftPolicy): Partial<Record<keyof ShiftPolicy, string>> {
  return Number.isInteger(p.tolerance) && p.tolerance >= 0 ? {} : { tolerance: 'Enter the tolerance in whole rupiah, zero or more.' }
}

export interface OpenShiftInput {
  accountId: string
  count: DrawerCount
  /** A closed shift on the same cashbox whose drawer this shift takes over; the count is then its rest. */
  handOverFrom: string | null
}

export interface CloseShiftInput {
  count: DrawerCount
  reason: string
}

export interface DropInput {
  toAccountId: string
  amount: number
  note: string
}

/** Roles that run the desk and may open a shift off the roster or sign off a difference. */
export const SHIFT_MANAGER_ROLES: readonly Role[] = ['owner', 'management', 'manager']
export const isShiftManager = (role: Role) => SHIFT_MANAGER_ROLES.includes(role)
/** A difference past the tolerance is signed by a manager or someone who approves finance. */
export const canSignOffShift = (role: Role, approvesFinance: boolean) => approvesFinance || isShiftManager(role)

export const openShiftOn = <S extends Pick<CashierShift, 'accountId' | 'status'>>(shifts: readonly S[], accountId: string) => shifts.find((s) => s.accountId === accountId && s.status === 'open') ?? null
/** Money that went through the drawer: everything but drafts and rejected entries. */
export const inDrawer = (t: Pick<Transaction, 'status'>) => t.status !== 'draft' && t.status !== 'rejected'
/** What the drawer can still hand over after the count and any drop. */
export const handOverAmount = (s: Pick<CashierShift, 'counted' | 'dropped'>) => (s.counted ?? 0) - s.dropped
export const needsSignOff = (difference: number, policy: ShiftPolicy) => Math.abs(difference) > policy.tolerance

export interface MethodTotal {
  method: PaymentMethod
  count: number
  amount: number
}

export interface CategoryTotal {
  categoryId: string
  kind: TransactionKind
  count: number
  amount: number
}

export interface ShiftTotals {
  cashIn: number
  cashOut: number
  expected: number
  /** Guest payments and refunds stamped with the shift, per method; refunds count against. */
  byMethod: MethodTotal[]
  byCategory: CategoryTotal[]
}

/** The shift's drawer from its stamped entries, and the guest money it took per method. */
export function shiftTotals(shift: Pick<CashierShift, 'id' | 'accountId' | 'float'>, transactions: readonly Transaction[], payments: readonly Payment[]): ShiftTotals {
  const mine = transactions.filter((t) => t.shiftId === shift.id && t.accountId === shift.accountId && inDrawer(t))
  const cashIn = mine.filter((t) => t.kind === 'cash_in').reduce((s, t) => s + t.amount, 0)
  const cashOut = mine.filter((t) => t.kind === 'cash_out').reduce((s, t) => s + t.amount, 0)
  const methods = new Map<PaymentMethod, MethodTotal>()
  for (const p of payments) {
    if (p.shiftId !== shift.id || (p.status !== 'paid' && p.status !== 'refunded')) continue
    const row = methods.get(p.method) ?? { method: p.method, count: 0, amount: 0 }
    row.count += 1
    row.amount += p.kind === 'refund' ? -p.amount : p.amount
    methods.set(p.method, row)
  }
  const categories = new Map<string, CategoryTotal>()
  for (const t of mine) {
    const key = `${t.kind}|${t.categoryId}`
    const row = categories.get(key) ?? { categoryId: t.categoryId, kind: t.kind, count: 0, amount: 0 }
    row.count += 1
    row.amount += t.amount
    categories.set(key, row)
  }
  return { cashIn, cashOut, expected: shift.float + cashIn - cashOut, byMethod: [...methods.values()], byCategory: [...categories.values()] }
}

type Problem = { code: string; message: string } | null

/**
 * One open shift per cashbox; the cashier is on the roster that day or a manager. A hand-over comes
 * from a counted shift on the same cashbox that has not handed over yet.
 */
export function openProblem(input: { accountId: string; shifts: readonly CashierShift[]; rostered: boolean; manager: boolean; handOver: CashierShift | null }): Problem {
  const open = openShiftOn(input.shifts, input.accountId)
  if (open) return { code: 'SHIFT_ALREADY_OPEN', message: `${open.number} is still open on this cashbox with ${open.cashierName}; close it first.` }
  if (!input.rostered && !input.manager) return { code: 'SHIFT_NOT_ROSTERED', message: 'You are not on today’s roster; ask a manager to open the shift.' }
  const h = input.handOver
  if (h) {
    if (h.accountId !== input.accountId || h.status === 'open' || h.counted === null) return { code: 'SHIFT_HANDOVER_INVALID', message: `${h.number} is not a counted shift on this cashbox.` }
    if (h.handedOverId) return { code: 'SHIFT_HANDED_OVER', message: `${h.number} has already handed its drawer over.` }
  }
  return null
}

/** Only an open shift closes, and a difference past the tolerance needs a reason. */
export function closeProblem(shift: CashierShift, difference: number, reason: string, policy: ShiftPolicy): Problem {
  if (shift.status !== 'open') return { code: 'SHIFT_NOT_OPEN', message: `${shift.number} is ${SHIFT_STATUS_LABEL[shift.status].toLowerCase()}.` }
  if (needsSignOff(difference, policy) && reason.trim().length < 5) return { code: 'SHIFT_REASON_REQUIRED', message: `The drawer is ${difference > 0 ? 'over' : 'short'} by more than the tolerance; say why.` }
  return null
}

/** Someone other than the cashier signs, on a shift that waits for it. */
export function signOffProblem(shift: CashierShift, userId: string): Problem {
  if (shift.status !== 'awaiting_signoff') return { code: 'SHIFT_NOT_AWAITING', message: `${shift.number} does not wait for a sign-off.` }
  if (shift.cashierId === userId) return { code: 'SHIFT_SELF_SIGNOFF', message: 'Another manager signs off your own drawer.' }
  return null
}

/** Cash leaves a counted drawer once, before it is handed over, and never more than was counted. */
export function dropProblem(shift: CashierShift, amount: number): Problem {
  if (shift.status === 'open' || shift.counted === null) return { code: 'SHIFT_NOT_CLOSED', message: `Count and close ${shift.number} before the cash leaves the drawer.` }
  if (shift.handedOverId) return { code: 'SHIFT_HANDED_OVER', message: `${shift.number} has already handed its drawer over.` }
  if (shift.dropTransactionId) return { code: 'SHIFT_ALREADY_DROPPED', message: `The cash of ${shift.number} has already been dropped.` }
  if (!Number.isInteger(amount) || amount <= 0 || amount > shift.counted) return { code: 'VALIDATION_ERROR', message: `Drop a whole rupiah amount up to the ${shift.counted.toLocaleString('id-ID')} counted.` }
  return null
}
