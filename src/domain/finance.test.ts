import { describe, expect, it } from 'vitest'
import { balance, byCategory, canTransitionTransaction, cashSummary, validateTransaction, type CashAccount, type Category, type Transaction } from './finance'

const account: CashAccount = { id: 'a1', name: 'Box', kind: 'cashbox', locationId: 'l1', openingBalance: 1_000_000, openedOn: '2026-09-01' }
const categories: Category[] = [
  { id: 'c-in', name: 'Room revenue', kind: 'cash_in', slot: 1, active: true },
  { id: 'c-out', name: 'Utilities', kind: 'cash_out', slot: 1, active: true },
  { id: 'c-misc', name: 'Misc', kind: 'cash_out', slot: 0, active: true },
  { id: 'c-old', name: 'Old', kind: 'cash_out', slot: 0, active: false },
]
const tx = (id: string, kind: Transaction['kind'], amount: number, status: Transaction['status'], categoryId = kind === 'cash_in' ? 'c-in' : 'c-out', extra: Partial<Transaction> = {}): Transaction => ({
  id,
  number: id.toUpperCase(),
  accountId: 'a1',
  kind,
  categoryId,
  amount,
  date: '2026-10-02',
  locationId: 'l1',
  villaId: null,
  unitId: null,
  bookingId: null,
  description: 'x',
  status,
  reversalOf: null,
  reversedBy: null,
  createdBy: 'me',
  createdOn: '2026-10-02',
  ...extra,
})

describe('finance rules', () => {
  it('moves the balance only with posted money, and a reversal cancels its original', () => {
    const list = [
      tx('t1', 'cash_in', 500_000, 'posted'),
      tx('t2', 'cash_out', 200_000, 'submitted'),
      tx('t3', 'cash_out', 300_000, 'reversed', 'c-out', { reversedBy: 't4' }),
      tx('t4', 'cash_in', 300_000, 'posted', 'c-out', { reversalOf: 't3' }),
    ]
    expect(balance(account, list)).toBe(1_500_000)
    expect(cashSummary(list, '2026-10-01', '2026-10-05')).toEqual({ cashIn: 800_000, cashOut: 300_000, net: 500_000 })
    expect(byCategory(list, categories, 'cash_out', '2026-10-01', '2026-10-05')).toEqual([])
  })

  it('folds slot-0 categories into Other and drops empty ones', () => {
    const list = [tx('t1', 'cash_out', 100, 'posted'), tx('t2', 'cash_out', 50, 'posted', 'c-misc'), tx('t3', 'cash_out', 25, 'posted', 'c-old')]
    expect(byCategory(list, categories, 'cash_out', '2026-10-01', '2026-10-05')).toEqual([
      { id: 'c-out', label: 'Utilities', value: 100, slot: 1 },
      { id: 'other', label: 'Other', value: 75, slot: 0 },
    ])
  })

  it('refuses a category of the other kind, an archived one and a non-integer amount', () => {
    const base = { accountId: 'a1', kind: 'cash_out' as const, categoryId: 'c-in', amount: 10.5, date: '2026-10-02', locationId: 'l1', villaId: null, unitId: null, bookingId: null, description: 'Fuel' }
    const errors = validateTransaction(base, categories)
    expect(errors.categoryId).toMatch(/cash in/)
    expect(errors.amount).toBeDefined()
    expect(validateTransaction({ ...base, categoryId: 'c-old', amount: 10 }, categories).categoryId).toMatch(/archived/)
    expect(validateTransaction({ ...base, categoryId: 'c-out', amount: 10 }, categories)).toEqual({})
  })

  it('never edits posted money directly', () => {
    expect(canTransitionTransaction({ status: 'posted' }, 'approved')).toBe(false)
    expect(canTransitionTransaction({ status: 'draft' }, 'posted')).toBe(false)
    expect(canTransitionTransaction({ status: 'approved' }, 'posted')).toBe(true)
  })
})
