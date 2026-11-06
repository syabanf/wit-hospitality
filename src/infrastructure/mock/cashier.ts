import type { CashierPort } from '@/application/ports'
import { can, type AuditAction, type User } from '@/domain/access'
import {
  canSignOffShift,
  closeProblem,
  countFor,
  countTotal,
  dropProblem,
  handOverAmount,
  isShiftManager,
  needsSignOff,
  openProblem,
  shiftTotals,
  signOffProblem,
  validateCount,
  validateShiftPolicy,
  type CashierShift,
  type DrawerCount,
} from '@/domain/cashier'
import { findById, RuleError } from '@/domain/errors'
import type { CashAccount, CashTransferInput, Reconciliation, Transaction } from '@/domain/finance'
import { money } from '@/lib/format'
import type { MockState } from './state'

/** The mock API's helpers the cashier shifts reuse, so a close goes through the same count and transfer paths as finance. */
export interface CashierContext {
  s: MockState
  later: <T>(value: () => T) => Promise<T>
  today: () => string
  clockNow: () => string
  user: () => User
  seq: (key: string) => number
  refuse: (errors: Record<string, string | undefined>) => void
  log: (action: AuditAction, entity: string, entityId: string, summary: string, before?: Record<string, unknown> | null, after?: Record<string, unknown> | null) => void
  /** The cash count reconciliation: the record, and the difference as an adjustment entry when asked. */
  recordCount: (account: CashAccount, input: { date: string; expected: number; counted: number; note: string; adjust: boolean; by: string; shiftId?: string }) => Reconciliation
  /** The cash transfer path; `shiftId: null` keeps both halves off any open shift. */
  transferCash: (input: CashTransferInput, shiftId?: string | null) => Transaction
}

export function createCashierPort({ s, later, today, clockNow, user, seq, refuse, log, recordCount, transferCash }: CashierContext): CashierPort {
  const copy = <T>(v: T): T => structuredClone(v)
  const shift = (id: string) => findById(s.cashierShifts, id, 'cashier shift')
  const signer = (me: User) => canSignOffShift(me.role, can(s.permissions, me.role, 'finance', 'approve'))
  const assertCount = (c: DrawerCount) => {
    const problem = validateCount(c)
    if (problem) throw new RuleError('VALIDATION_ERROR', problem)
  }
  /** The cashier works their own drawer; a manager or finance approver may step in. */
  const assertMine = (sh: CashierShift, me: User) => {
    if (sh.cashierId !== me.id && !signer(me)) throw new RuleError('SHIFT_NOT_YOURS', `${sh.number} belongs to ${sh.cashierName}.`)
  }

  /** The difference reaches the books through the cash count, as an adjustment entry for approval. */
  function post(sh: CashierShift) {
    const account = findById(s.cashAccounts, sh.accountId, 'account')
    const note = `Shift ${sh.number}, ${sh.cashierName}${sh.reason ? `: ${sh.reason}` : ''}`
    sh.reconciliationId = recordCount(account, { date: today(), expected: sh.expected ?? 0, counted: sh.counted ?? 0, note, adjust: true, by: sh.cashierName, shiftId: sh.id }).id
  }

  return {
    shifts: () => later(() => copy(s.cashierShifts)),
    handOvers: () => later(() => copy(s.handOvers)),
    policy: () => later(() => copy(s.shiftPolicy)),
    savePolicy: (policy) =>
      later(() => {
        refuse(validateShiftPolicy(policy))
        const before = { ...s.shiftPolicy }
        s.shiftPolicy = { ...policy }
        log('update', 'shift-policy', 'tolerance', `Shift tolerance set to ${money(policy.tolerance)}`, before, { ...policy })
        return copy(s.shiftPolicy)
      }),

    open: (input) =>
      later(() => {
        const me = user()
        const account = findById(s.cashAccounts, input.accountId, 'account')
        if (account.kind !== 'cashbox' || !account.locationId) throw new RuleError('VALIDATION_ERROR', 'A shift opens on a location cashbox.')
        const from = input.handOverFrom ? shift(input.handOverFrom) : null
        if (!from) assertCount(input.count)
        const rostered = Boolean(me.employeeId && s.assignments.some((a) => a.employeeId === me.employeeId && a.date === today() && a.shiftId))
        const problem = openProblem({ accountId: account.id, shifts: s.cashierShifts, rostered, manager: isShiftManager(me.role), handOver: from })
        if (problem) throw new RuleError(problem.code, problem.message)
        const float = from ? handOverAmount(from) : countTotal(input.count)
        const n = seq('cashierShift')
        const sh: CashierShift = {
          id: `cs-${n}`,
          number: `SH-${String(n).padStart(4, '0')}`,
          accountId: account.id,
          locationId: account.locationId,
          cashierId: me.id,
          cashierName: me.name,
          businessDate: s.businessDate,
          openedAt: clockNow(),
          // A drop leaves no note-by-note record of what stayed, so the rest is split into notes.
          openingCount: from ? (from.dropped === 0 && from.closingCount ? copy(from.closingCount) : countFor(float)) : copy(input.count),
          float,
          handOverId: null,
          status: 'open',
          closedAt: null,
          closingCount: null,
          counted: null,
          expected: null,
          difference: null,
          reason: '',
          signOff: null,
          reconciliationId: null,
          dropped: 0,
          dropTransactionId: null,
          handedOverId: null,
        }
        if (from) {
          const h = { id: `ho-${seq('handOver')}`, accountId: account.id, fromShiftId: from.id, toShiftId: sh.id, amount: float, at: sh.openedAt, from: from.cashierName, to: me.name }
          s.handOvers.push(h)
          from.handedOverId = h.id
          sh.handOverId = h.id
        }
        s.cashierShifts.push(sh)
        log('create', 'cashier-shift', sh.number, `Opened ${sh.number} on ${account.name} with ${money(float)}${from ? ` handed over from ${from.number}` : ''}`, null, { float, rostered })
        return copy(sh)
      }),

    close: (id, input) =>
      later(() => {
        const me = user()
        const sh = shift(id)
        assertMine(sh, me)
        assertCount(input.count)
        const counted = countTotal(input.count)
        const expected = shiftTotals(sh, s.transactions, s.payments).expected
        const difference = counted - expected
        const problem = closeProblem(sh, difference, input.reason, s.shiftPolicy)
        if (problem) throw new RuleError(problem.code, problem.message)
        Object.assign(sh, { closedAt: clockNow(), closingCount: copy(input.count), counted, expected, difference, reason: input.reason.trim(), status: needsSignOff(difference, s.shiftPolicy) ? 'awaiting_signoff' : 'closed' })
        if (sh.status === 'closed') post(sh)
        log('status', 'cashier-shift', sh.number, `Closed ${sh.number}: ${difference === 0 ? 'matched' : `${difference > 0 ? 'over' : 'short'} by ${money(Math.abs(difference))}`}${sh.status === 'awaiting_signoff' ? ', waits for sign-off' : ''}`, { status: 'open' }, { status: sh.status, counted, expected })
        return copy(sh)
      }),

    signOff: (id, note) =>
      later(() => {
        const me = user()
        const sh = shift(id)
        if (!signer(me)) throw new RuleError('SHIFT_SIGNOFF_DENIED', 'A manager or someone who approves finance signs off a drawer difference.')
        const problem = signOffProblem(sh, me.id)
        if (problem) throw new RuleError(problem.code, problem.message)
        sh.signOff = { by: me.name, at: clockNow(), note: note.trim() }
        sh.status = 'closed'
        post(sh)
        log('approve', 'cashier-shift', sh.number, `Signed off ${sh.number}, ${money(sh.difference ?? 0)}`, { status: 'awaiting_signoff' }, { status: 'closed' })
        return copy(sh)
      }),

    drop: (id, input) =>
      later(() => {
        const me = user()
        const sh = shift(id)
        assertMine(sh, me)
        const problem = dropProblem(sh, input.amount)
        if (problem) throw new RuleError(problem.code, problem.message)
        const to = findById(s.cashAccounts, input.toAccountId, 'account')
        const out = transferCash({ fromAccountId: sh.accountId, toAccountId: to.id, amount: input.amount, date: today(), description: `Cash drop from ${sh.number}${input.note.trim() ? `: ${input.note.trim()}` : ''}`, reference: sh.number }, null)
        sh.dropped = input.amount
        sh.dropTransactionId = out.id
        log('update', 'cashier-shift', sh.number, `Dropped ${money(input.amount)} from ${sh.number} to ${to.name}`, null, { dropped: input.amount })
        return copy(sh)
      }),
  }
}
