import { describe, expect, it } from 'vitest'
import { DEFAULT_PROOF_POLICY, needsProof, uploadProblem } from './attachment'
import { bookingFlow, paymentFlow, payrollFlow, requestFlow, transactionFlow, workOrderFlow } from './flow'
import { cancellationTerms, DEFAULT_PAYMENT_POLICY } from './payment'

const states = (steps: ReadonlyArray<{ state: string }>) => steps.map((s) => s.state).join(' ')

describe('flows', () => {
  it('walks a booking from confirmed to settled, and stops on a cancellation', () => {
    const money = { paid: 0, expected: 6_000_000, firstEntryId: null, allPosted: false }
    expect(states(bookingFlow({ status: 'confirmed', code: 'BK-1', unitId: 'u', unitAssigned: true }, money))).toBe('current upcoming upcoming upcoming upcoming upcoming')
    expect(states(bookingFlow({ status: 'confirmed', code: 'BK-1', unitId: 'u', unitAssigned: true }, { ...money, paid: 1_800_000, firstEntryId: 'tx-1' }))).toBe('done current upcoming upcoming upcoming upcoming')
    expect(bookingFlow({ status: 'confirmed', code: 'BK-1', unitId: 'u', unitAssigned: true }, { ...money, paid: 1_800_000, firstEntryId: 'tx-1' })[1]?.ref).toEqual({ kind: 'transaction', id: 'tx-1', label: 'Cash-in' })
    expect(states(bookingFlow({ status: 'checked_out', code: 'BK-1', unitId: 'u', unitAssigned: true }, { ...money, paid: 6_000_000, firstEntryId: 'tx-1', allPosted: false }))).toBe('done done done done done current')
    expect(states(bookingFlow({ status: 'checked_out', code: 'BK-1', unitId: 'u', unitAssigned: true }, { ...money, paid: 6_000_000, firstEntryId: 'tx-1', allPosted: true }))).toBe('done done done done done done')
    // In house with money owed, the bill is the step to clear; with nothing owed, check-out is next.
    expect(states(bookingFlow({ status: 'checked_in', code: 'BK-1', unitId: 'u', unitAssigned: true }, { ...money, paid: 1_800_000, firstEntryId: 'tx-1', owed: 4_440_000 }))).toBe('done done done current upcoming upcoming')
    expect(states(bookingFlow({ status: 'checked_in', code: 'BK-1', unitId: 'u', unitAssigned: true }, { ...money, paid: 6_000_000, firstEntryId: 'tx-1', owed: 0 }))).toBe('done done done done current upcoming')
    expect(bookingFlow({ status: 'cancelled', code: 'BK-1', unitId: 'u', unitAssigned: true }, money).at(-1)).toMatchObject({ label: 'Cancelled', state: 'blocked' })
  })

  it('holds a room-type stay at the room until one is assigned', () => {
    const money = { paid: 1_800_000, expected: 6_000_000, firstEntryId: 'tx-1', allPosted: false }
    const steps = bookingFlow({ status: 'confirmed', code: 'BK-1', unitId: 'u', unitAssigned: false }, money)
    expect(steps.map((s) => s.label)).toEqual(['Confirmed', 'Deposit paid', 'Room to assign', 'Checked in', 'Bill paid', 'Checked out', 'Settled'])
    expect(states(steps)).toBe('done done current upcoming upcoming upcoming upcoming')
  })

  it('follows a payment into the ledger and stops a failed link', () => {
    const p = { status: 'paid' as const, kind: 'deposit' as const, bookingId: 'bk-1', bookingCode: 'BK-1', transactionId: 'tx-9' }
    expect(states(paymentFlow({ ...p, status: 'pending', transactionId: null }, null))).toBe('current upcoming upcoming upcoming upcoming')
    expect(states(paymentFlow(p, 'submitted'))).toBe('done done current upcoming upcoming')
    expect(states(paymentFlow(p, 'rejected'))).toBe('done done blocked upcoming upcoming')
    expect(states(paymentFlow(p, 'posted'))).toBe('done done done done done')
    expect(paymentFlow({ ...p, status: 'failed' }, null).map((s) => s.label)).toEqual(['Requested', 'Failed'])
    expect(paymentFlow(p, 'posted')[0]?.ref?.kind).toBe('booking')
    expect(states(paymentFlow({ ...p, transactionId: null }, null))).toBe('done done')
  })

  it('gives each approval level its own step and blocks a rejection at the level that refused', () => {
    const levels = ['manager', 'finance'] as const
    const signed = [{ level: 1, role: 'manager' as const, by: 'Kadek', on: '2026-10-05', note: '' }]
    expect(transactionFlow({ status: 'draft', approvals: [], history: [] }, levels).map((s) => s.label)).toEqual(['Draft', 'Submitted', 'Villa manager signs', 'Finance signs', 'Posted'])
    expect(states(transactionFlow({ status: 'submitted', approvals: signed, history: [] }, levels))).toBe('done done current upcoming upcoming')
    expect(states(transactionFlow({ status: 'rejected', approvals: signed, history: [] }, levels))).toBe('done done done blocked upcoming')
    expect(transactionFlow({ status: 'submitted', approvals: [], history: [{ kind: 'resubmitted', by: 'Ida', role: 'finance', on: '2026-10-05', note: '' }] }, levels)[1]?.label).toBe('Resubmitted')
    const withSource = transactionFlow({ status: 'posted', approvals: signed, history: [] }, ['manager'], { kind: 'workOrder', id: 'wo-1', label: 'WO-501' })
    expect(withSource[0]).toMatchObject({ label: 'WO-501', state: 'done' })
    expect(withSource.every((s) => s.state === 'done')).toBe(true)
  })

  it('holds a finished job until its expenses clear and the unit is released', () => {
    const entry = (status: 'submitted' | 'posted') => [{ id: 'tx-1', status }]
    expect(states(workOrderFlow({ status: 'in_progress', unitId: 'u', blockId: 'b' }, []))).toBe('done current upcoming upcoming upcoming')
    expect(workOrderFlow({ status: 'done', unitId: 'u', blockId: 'b' }, entry('submitted'))[2]).toMatchObject({ label: 'Expenses in approval', state: 'current' })
    expect(states(workOrderFlow({ status: 'done', unitId: 'u', blockId: 'b' }, entry('posted')))).toBe('done done done current upcoming')
    expect(states(workOrderFlow({ status: 'verified', unitId: 'u', blockId: null }, entry('posted')))).toBe('done done done done done')
  })

  it('closes payroll and counts approved requests once the month is calculated', () => {
    expect(states(payrollFlow({ status: 'closed', transactionId: 'tx-5', published: false }))).toBe('done done done current upcoming')
    expect(payrollFlow({ status: 'closed', transactionId: 'tx-5', published: true }).every((s) => s.state === 'done')).toBe(true)
    expect(states(requestFlow({ status: 'approved' }, { id: 'pp-1', month: '2026-10', status: 'draft' }))).toBe('done current upcoming')
    expect(states(requestFlow({ status: 'approved' }, { id: 'pp-1', month: '2026-10', status: 'calculated' }))).toBe('done done done')
    expect(requestFlow({ status: 'rejected' }, null).at(-1)?.state).toBe('blocked')
  })
})

describe('proof and cancellation rules', () => {
  it('needs a receipt on large hand-written cash-outs only', () => {
    const t = { kind: 'cash_out' as const, amount: 1_000_000, origin: 'manual' as const, attachments: [] }
    expect(needsProof(t, DEFAULT_PROOF_POLICY)).toBe(true)
    expect(needsProof({ ...t, attachments: [{}] }, DEFAULT_PROOF_POLICY)).toBe(false)
    expect(needsProof({ ...t, amount: 999_999 }, DEFAULT_PROOF_POLICY)).toBe(false)
    expect(needsProof({ ...t, origin: 'payroll' }, DEFAULT_PROOF_POLICY)).toBe(false)
    expect(needsProof({ ...t, kind: 'cash_in' }, DEFAULT_PROOF_POLICY)).toBe(false)
    expect(needsProof(t, { threshold: 0 })).toBe(false)
  })

  it('accepts photos and PDFs up to 5 MB', () => {
    expect(uploadProblem({ name: 'a.jpg', type: 'image/jpeg', size: 10 })).toBeNull()
    expect(uploadProblem({ name: 'a.doc', type: 'application/msword', size: 10 })?.code).toBe('ATTACHMENT_TYPE')
    expect(uploadProblem({ name: 'a.pdf', type: 'application/pdf', size: 5 * 1024 * 1024 + 1 })?.code).toBe('ATTACHMENT_SIZE')
    expect(uploadProblem({ name: 'a.png', type: 'image/png', size: 0 })?.code).toBe('ATTACHMENT_EMPTY')
  })

  it('refunds in time, keeps the deposit late and everything on a no-show', () => {
    const p = { ...DEFAULT_PAYMENT_POLICY, depositPct: 30, freeCancelDays: 14 }
    expect(cancellationTerms(6_000_000, 6_000_000, '2026-11-01', '2026-10-10', p, 'cancelled')).toEqual({ refund: 6_000_000, retained: 0 })
    expect(cancellationTerms(6_000_000, 6_000_000, '2026-10-15', '2026-10-10', p, 'cancelled')).toEqual({ refund: 4_200_000, retained: 1_800_000 })
    expect(cancellationTerms(1_000_000, 6_000_000, '2026-10-15', '2026-10-10', p, 'cancelled')).toEqual({ refund: 0, retained: 1_000_000 })
    expect(cancellationTerms(6_000_000, 6_000_000, '2026-10-15', '2026-10-10', p, 'no_show')).toEqual({ refund: 0, retained: 6_000_000 })
    expect(cancellationTerms(0, 6_000_000, '2026-10-15', '2026-10-10', p, 'cancelled')).toEqual({ refund: 0, retained: 0 })
  })
})
