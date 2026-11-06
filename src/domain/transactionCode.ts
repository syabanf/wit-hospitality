import { RuleError } from './errors'
import type { PaymentMethod } from './payment'
import type { MenuCategory } from './serviceOrder'

/**
 * Transaction codes, the way a hotel PMS posts a folio: every folio line carries one, and a
 * charge code names the revenue account its money books to. Finance maps each code on the
 * Transaction codes page; a change applies to postings from then on.
 */
export type CodeKind = 'charge' | 'payment' | 'rebate'
export const CODE_KINDS: readonly CodeKind[] = ['charge', 'payment', 'rebate']
export const CODE_KIND_LABEL: Record<CodeKind, string> = { charge: 'Charge', payment: 'Payment', rebate: 'Rebate' }

export type Department = 'room' | 'fnb' | 'minibar' | 'laundry' | 'transport' | 'spa' | 'tours' | 'extras' | 'other' | 'taxes' | 'payment'
export const DEPARTMENTS: readonly Department[] = ['room', 'fnb', 'minibar', 'laundry', 'transport', 'spa', 'tours', 'extras', 'other', 'taxes', 'payment']
export const DEPARTMENT_LABEL: Record<Department, string> = {
  room: 'Room',
  fnb: 'F&B',
  minibar: 'Minibar',
  laundry: 'Laundry',
  transport: 'Transport',
  spa: 'Spa',
  tours: 'Tours',
  extras: 'Extras',
  other: 'Other income',
  taxes: 'Taxes',
  payment: 'Payments',
}

export interface TransactionCode {
  id: string
  /** Short and upper case, unique: ROOM, FNB, CASH. */
  code: string
  name: string
  kind: CodeKind
  department: Department
  /** The revenue account a charge or rebate books to; null on a payment code, whose money books by the cash entry. */
  accountId: string | null
  active: boolean
}
export type TransactionCodeInput = Omit<TransactionCode, 'id'>

/** Literal ids of the revenue accounts in `BASE_CHART`, so this file needs nothing from the journal. */
const REVENUE = { room: 'gl-4100', fnb: 'gl-4210', minibar: 'gl-4220', laundry: 'gl-4230', transport: 'gl-4240', spa: 'gl-4250', tours: 'gl-4260', extras: 'gl-4270', other: 'gl-4900' } as const

const charge = (code: string, name: string, department: Exclude<Department, 'payment' | 'taxes'>): TransactionCode => ({ id: `tc-${code.toLowerCase()}`, code, name, kind: 'charge', department, accountId: REVENUE[department], active: true })
const payment = (code: string, name: string): TransactionCode => ({ id: `tc-${code.toLowerCase()}`, code, name, kind: 'payment', department: 'payment', accountId: null, active: true })

export const DEFAULT_TRANSACTION_CODES: readonly TransactionCode[] = [
  charge('ROOM', 'Room night', 'room'),
  charge('LATE', 'Late check-out', 'room'),
  charge('FNB', 'Food and drinks', 'fnb'),
  charge('MINI', 'Minibar', 'minibar'),
  charge('LDRY', 'Laundry', 'laundry'),
  charge('TRNS', 'Transfers and transport', 'transport'),
  charge('SPA', 'Spa and massage', 'spa'),
  charge('TOUR', 'Tours and activities', 'tours'),
  charge('XTRA', 'Extra bed, decoration and amenities', 'extras'),
  charge('DMG', 'Damage and other charges', 'other'),
  payment('CASH', 'Cash'),
  payment('BANK', 'Bank transfer'),
  payment('QRIS', 'QRIS'),
  payment('VA', 'Virtual account'),
  payment('CARD', 'Card'),
  payment('AIRBNB', 'Airbnb'),
]

/** The code a room night posts on. */
export const ROOM_CODE = 'ROOM'
/** Departure charges and charges that carry no code of their own book here. */
export const OTHER_CODE = 'DMG'

/** Menu items post on the code of their category. */
export const MENU_CATEGORY_CODE: Record<MenuCategory, string> = { breakfast: 'FNB', food: 'FNB', minibar: 'MINI', laundry: 'LDRY', transport: 'TRNS', spa: 'SPA', tours: 'TOUR', extras: 'XTRA', housekeeping: 'XTRA' }

/** Payments show on the folio under the code of their method. */
export const PAYMENT_METHOD_CODE: Record<PaymentMethod, string> = { cash: 'CASH', bank_transfer: 'BANK', qris: 'QRIS', virtual_account: 'VA', card: 'CARD', airbnb_payout: 'AIRBNB' }

/**
 * Guest revenue categories: a cash entry in one of them books to its code's account, so the codes
 * decide every revenue account and the Categories page maps only the rest.
 */
export const CATEGORY_CODE: Readonly<Record<string, string>> = {
  'cat-room': 'ROOM',
  'cat-airbnb': 'ROOM',
  'cat-extra': OTHER_CODE,
  'cat-svc-fnb': 'FNB',
  'cat-svc-laundry': 'LDRY',
  'cat-svc-transport': 'TRNS',
  'cat-svc-spa': 'SPA',
  'cat-svc-tours': 'TOUR',
  'cat-svc-other': 'XTRA',
}

export const findCode = (codes: readonly TransactionCode[], code: string) => codes.find((c) => c.code === code)

/** The revenue account a code books to; an unknown or unmapped code falls to other income. */
export const codeAccount = (codes: readonly TransactionCode[], code: string) => findCode(codes, code)?.accountId ?? REVENUE.other

/** The codes the desk picks for a manual charge: active charge codes other than the room night. */
export const chargeCodes = (codes: readonly TransactionCode[]) => codes.filter((c) => c.kind === 'charge' && c.active && c.code !== ROOM_CODE)

/** `accounts` are the revenue accounts a code may book to. */
export function validateTransactionCode(input: TransactionCodeInput, codes: readonly TransactionCode[], accounts: ReadonlyArray<{ id: string }>, id?: string): Partial<Record<keyof TransactionCodeInput, string>> {
  const errors: Partial<Record<keyof TransactionCodeInput, string>> = {}
  const code = input.code.trim().toUpperCase()
  if (!/^[A-Z][A-Z0-9]{1,7}$/.test(code)) errors.code = 'Two to eight letters or digits, starting with a letter.'
  else if (codes.some((c) => c.code === code && c.id !== id)) errors.code = `${code} is taken.`
  if (input.name.trim().length < 3) errors.name = 'Name the code.'
  if (!CODE_KINDS.includes(input.kind)) errors.kind = 'Pick the kind.'
  if (!DEPARTMENTS.includes(input.department)) errors.department = 'Pick the department.'
  if (input.kind === 'payment' && input.accountId) errors.accountId = 'A payment code books by its cash entry; leave the account empty.'
  if (input.kind !== 'payment' && !accounts.some((a) => a.id === input.accountId)) errors.accountId = 'Pick the revenue account it books to.'
  return errors
}

/** The room night code and the payment codes the folio relies on stay active. */
export function assertCanDeactivate(c: TransactionCode) {
  if (c.code === ROOM_CODE || c.kind === 'payment') throw new RuleError('CODE_IN_USE', `${c.code} is used by every ${c.kind === 'payment' ? 'payment by that method' : 'room night'}; it stays active.`)
}
