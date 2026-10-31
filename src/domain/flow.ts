import { ROLE_LABEL, type Role } from './access'
import { approvalProgress } from './approval'
import type { Booking } from './booking'
import type { Transaction, TransactionStatus } from './finance'
import type { LeaveRequest, OvertimeRequest } from './hr'
import type { WorkOrder } from './maintenance'
import type { PayrollPeriod } from './payroll'
import type { Payment } from './payment'
import type { OrderPayState, ServiceOrder } from './serviceOrder'

/**
 * Where a record sits in its business flow, step by step, with the neighbouring record each
 * step leads to. Pages draw these as one compact stepper; the routes live in the presentation.
 */
export type FlowRef = { kind: 'booking' | 'transaction' | 'workOrder' | 'payroll' | 'unit'; id: string; label: string }

export interface FlowStep {
  id: string
  label: string
  state: 'done' | 'current' | 'upcoming' | 'blocked'
  ref?: FlowRef
}

/** `at` is the step the record has reached: earlier ones are done, later ones upcoming; past the end, all are done. */
function mark(steps: ReadonlyArray<Omit<FlowStep, 'state'>>, at: number, blocked = false): FlowStep[] {
  return steps.map((s, i) => ({ ...s, state: i < at ? 'done' : i === at ? (blocked ? 'blocked' : 'current') : 'upcoming' }))
}
const tx = (id: string | null | undefined, label: string): FlowRef | undefined => (id ? { kind: 'transaction', id, label } : undefined)

/** Booked, deposit in, in house, out, then settled once nothing is owed and every entry is posted. */
export function bookingFlow(b: Pick<Booking, 'status' | 'code' | 'unitId' | 'unitAssigned'>, money: { paid: number; expected: number; firstEntryId: string | null; allPosted: boolean }): FlowStep[] {
  const deposit = { id: 'deposit', label: money.paid >= money.expected ? 'Paid in full' : 'Deposit paid', ref: tx(money.firstEntryId, 'Cash-in') }
  if (b.status === 'cancelled' || b.status === 'no_show') {
    const ended = { id: b.status, label: b.status === 'cancelled' ? 'Cancelled' : 'No-show' }
    return [{ id: 'booked', label: 'Booked', state: 'done' }, { ...deposit, state: money.firstEntryId ? 'done' : 'upcoming' }, { ...ended, state: 'blocked' }]
  }
  // A stay booked against the room type waits for its room between the deposit and check-in.
  if (!b.unitAssigned) {
    const waiting = [{ id: 'booked', label: b.status === 'draft' ? 'Enquiry' : 'Confirmed' }, deposit, { id: 'room', label: 'Room to assign' }, { id: 'in', label: 'Checked in' }, { id: 'out', label: 'Checked out' }, { id: 'settled', label: 'Settled' }]
    return mark(waiting, b.status === 'draft' ? 0 : money.paid > 0 ? 2 : 0)
  }
  const steps = [{ id: 'booked', label: b.status === 'draft' ? 'Enquiry' : 'Confirmed' }, deposit, { id: 'in', label: 'Checked in', ref: { kind: 'unit' as const, id: b.unitId, label: 'Unit' } }, { id: 'out', label: 'Checked out' }, { id: 'settled', label: 'Settled' }]
  const settled = money.expected > 0 && money.paid >= money.expected && money.allPosted
  const at = b.status === 'draft' ? 0 : b.status === 'confirmed' ? (money.paid > 0 ? 1 : 0) : b.status === 'checked_in' ? 2 : settled ? steps.length : 3
  return mark(steps, at)
}

/** Link or desk, paid, then the cash-in through approval to posted; a failed or expired link stops it. */
export function paymentFlow(p: Pick<Payment, 'status' | 'kind' | 'bookingId' | 'transactionId'> & { bookingCode: string }, entry: TransactionStatus | null): FlowStep[] {
  const booking: FlowRef = { kind: 'booking', id: p.bookingId, label: p.bookingCode }
  const refund = p.kind === 'refund'
  const steps = [
    { id: 'created', label: refund ? 'Refund agreed' : 'Requested', ref: booking },
    { id: 'paid', label: refund ? 'Paid back' : 'Paid' },
    { id: 'submitted', label: refund ? 'Cash-out submitted' : 'Cash-in submitted', ref: tx(p.transactionId, 'Entry') },
    { id: 'approved', label: 'Approved', ref: tx(p.transactionId, 'Entry') },
    { id: 'posted', label: 'Posted', ref: tx(p.transactionId, 'Entry') },
  ]
  if (p.status === 'failed' || p.status === 'expired' || p.status === 'cancelled') return [...mark(steps.slice(0, 1), 1), { id: p.status, label: p.status === 'failed' ? 'Failed' : p.status === 'expired' ? 'Expired' : 'Cancelled', state: 'blocked' }]
  if (p.status === 'pending') return mark(steps, 0)
  // Money taken before the console has no ledger entry to follow.
  if (!p.transactionId) return mark(steps.slice(0, 2), 2)
  const at = entry === 'posted' || entry === 'reversed' ? steps.length : entry === 'approved' ? 3 : entry === 'submitted' || entry === 'rejected' ? 2 : 1
  const out = mark(steps, at, entry === 'rejected')
  return p.status === 'refunded' ? [...out, { id: 'refunded', label: 'Refunded', state: 'done' }] : out
}

/** Draft, submitted, one step per approval level, posted; a rejection blocks at the level that refused it. */
export function transactionFlow(t: Pick<Transaction, 'status' | 'approvals' | 'history'>, levels: readonly Role[], source?: FlowRef): FlowStep[] {
  const progress = approvalProgress(levels, t.approvals)
  const resubmitted = t.history.some((e) => e.kind === 'resubmitted')
  const head = source ? [{ id: 'source', label: source.label, ref: source }] : []
  const steps = [...head, { id: 'draft', label: 'Draft' }, { id: 'submitted', label: resubmitted ? 'Resubmitted' : 'Submitted' }, ...levels.map((role, i) => ({ id: `level-${i + 1}`, label: `${ROLE_LABEL[role]} signs` })), { id: 'posted', label: 'Posted' }]
  const base = head.length
  const at: Record<TransactionStatus, number> = { draft: base, submitted: base + 1 + progress.done, rejected: base + 2 + progress.done, approved: base + 1 + levels.length, posted: steps.length, reversed: steps.length }
  const out = mark(steps, at[t.status], t.status === 'rejected')
  return t.status === 'reversed' ? [...out, { id: 'reversed', label: 'Reversed', state: 'blocked' }] : out
}

/** Reported, worked on, its money approved, done, and the unit back in service. */
export function workOrderFlow(w: Pick<WorkOrder, 'status' | 'unitId' | 'blockId'>, entries: ReadonlyArray<Pick<Transaction, 'id' | 'status'>>): FlowStep[] {
  if (w.status === 'cancelled') return [{ id: 'open', label: 'Reported', state: 'done' }, { id: 'cancelled', label: 'Cancelled', state: 'blocked' }]
  const cleared = entries.every((e) => e.status === 'approved' || e.status === 'posted')
  const waiting = entries.find((e) => e.status !== 'approved' && e.status !== 'posted')
  const steps = [
    { id: 'open', label: w.status === 'scheduled' ? 'Scheduled' : 'Reported' },
    { id: 'work', label: w.status === 'on_hold' ? 'On hold' : 'In progress' },
    { id: 'money', label: entries.length === 0 ? 'No expenses' : waiting ? 'Expenses in approval' : 'Expenses approved', ref: tx((waiting ?? entries[0])?.id, 'Expense') },
    { id: 'done', label: w.status === 'verified' ? 'Verified' : 'Done' },
    { id: 'released', label: w.unitId ? 'Unit released' : 'Closed', ref: w.unitId ? { kind: 'unit' as const, id: w.unitId, label: 'Unit' } : undefined },
  ]
  const finished = w.status === 'done' || w.status === 'verified'
  const at = w.status === 'open' || w.status === 'scheduled' ? 0 : !finished ? (entries.length > 0 && cleared ? 2 : 1) : !cleared ? 2 : w.blockId ? 3 : steps.length
  return mark(steps, at, w.status === 'on_hold')
}

/** Draft, calculated, approved, closed with the bank entry, payslips out. */
export function payrollFlow(p: Pick<PayrollPeriod, 'status' | 'transactionId' | 'published'>): FlowStep[] {
  const steps = [{ id: 'draft', label: 'Draft' }, { id: 'calculated', label: 'Calculated' }, { id: 'approved', label: 'Approved' }, { id: 'closed', label: 'Closed and paid', ref: tx(p.transactionId, 'Bank entry') }, { id: 'published', label: 'Payslips published' }]
  const at = { draft: 0, calculated: 1, approved: 2, closed: p.published ? steps.length : 3 }[p.status]
  return mark(steps, at)
}

/** Asked, decided, then counted in the payroll of its month. */
export function requestFlow(r: Pick<LeaveRequest | OvertimeRequest, 'status'>, period: Pick<PayrollPeriod, 'id' | 'month' | 'status'> | null): FlowStep[] {
  if (r.status === 'rejected' || r.status === 'cancelled') return [{ id: 'asked', label: 'Submitted', state: 'done' }, { id: r.status, label: r.status === 'rejected' ? 'Rejected' : 'Cancelled', state: 'blocked' }]
  const steps = [{ id: 'asked', label: 'Submitted' }, { id: 'approved', label: 'Approved' }, { id: 'payroll', label: 'In payroll', ref: period ? { kind: 'payroll' as const, id: period.id, label: period.month } : undefined }]
  const counted = period !== null && period.status !== 'draft'
  return mark(steps, r.status === 'pending' ? 0 : counted ? steps.length : 1)
}

/** Ordered, accepted, prepared, delivered, paid, then the income posted; a cancelled order stops, a free one ends at delivery. */
export function orderFlow(o: Pick<ServiceOrder, 'status' | 'bookingId'> & { bookingCode: string; payState: OrderPayState }, entry: Pick<Transaction, 'id' | 'status'> | null): FlowStep[] {
  const steps = [
    { id: 'placed', label: 'Ordered', ref: { kind: 'booking' as const, id: o.bookingId, label: o.bookingCode } },
    { id: 'confirmed', label: 'Accepted' },
    { id: 'preparing', label: 'Preparing' },
    { id: 'delivered', label: 'Delivered' },
    { id: 'paid', label: 'Paid', ref: tx(entry?.id, 'Cash-in') },
    { id: 'posted', label: 'Income posted', ref: tx(entry?.id, 'Cash-in') },
  ]
  if (o.status === 'cancelled') return [...mark(steps.slice(0, 1), 1), { id: 'cancelled', label: 'Cancelled', state: 'blocked' }]
  if (o.payState === 'free') return mark(steps.slice(0, 4), 4)
  const at = o.status === 'new' ? 0 : o.status === 'confirmed' ? 1 : o.status === 'preparing' ? 2 : o.payState !== 'paid' ? 4 : entry?.status === 'posted' ? steps.length : 5
  return mark(steps, at)
}
