import type { Booking } from '@/domain/booking'
import { countFor, shiftTotals, type CashierShift, type HandOver } from '@/domain/cashier'
import type { CashAccount, Reconciliation, Transaction } from '@/domain/finance'
import type { Payment } from '@/domain/payment'
import type { Catalog } from '@/domain/property'
import { addDays, type IsoDate } from '@/lib/dates'

type SeedEntry = Pick<Transaction, 'accountId' | 'kind' | 'categoryId' | 'amount' | 'date' | 'locationId' | 'villaId' | 'unitId' | 'bookingId' | 'description' | 'reference' | 'origin'>

interface Deps {
  today: IsoDate
  catalog: Catalog
  cashAccounts: readonly CashAccount[]
  bookings: readonly Booking[]
  transactions: Transaction[]
  payments: Payment[]
  /** The seed's ledger entry maker, posted or submitted. */
  entry: (fields: SeedEntry, posted: boolean) => Transaction
}

/** Who works each desk drawer in the seed. */
const CASHIERS: Record<string, { id: string; name: string }> = {
  'cb-canggu': { id: 'usr-wayan', name: 'Wayan Sudiarta' },
  'cb-ubud': { id: 'usr-putu', name: 'Putu Eka Wijaya' },
  'cb-seminyak': { id: 'usr-dian', name: 'Dian Permata' },
  'cb-uluwatu': { id: 'usr-kadek', name: 'Kadek Ariani' },
}
/** The float each drawer starts the day with; the rest goes to the bank at close. */
const FLOAT = 2_000_000
/** Drawers that did not match: cashbox and days ago, with the difference and the reason given. */
const DIFFERENCES: Record<string, { amount: number; reason: string; signedBy?: string }> = {
  'cb-ubud|3': { amount: -5_000, reason: 'Change given twice on a laundry bill.' },
  'cb-seminyak|5': { amount: -25_000, reason: 'Short after the late check-out rush; no slip for one transfer fare.', signedBy: 'Kadek Ariani' },
}
const DESK_IN = [
  { categoryId: 'cat-extra', what: 'Airport transfer paid at the desk', amounts: [350_000, 400_000, 450_000] },
  { categoryId: 'cat-room', what: 'Extra night paid in cash', amounts: [1_250_000, 1_600_000, 1_850_000] },
  { categoryId: 'cat-extra', what: 'Scooter rental', amounts: [150_000, 225_000, 300_000] },
]
const DESK_OUT = { categoryId: 'cat-house', what: 'Desk supplies and drinking water', amounts: [65_000, 85_000, 120_000] }

const pick = (list: readonly number[], a: number, b: number) => list[(a * 7 + b * 3) % list.length] ?? 0

/**
 * A closed shift per cashbox for each of the last seven days: the float handed over from the day
 * before, the desk's cash and the guest payments of that day, a close on a counted drawer with the
 * excess dropped to the bank, and today an open shift at Canggu.
 */
export function seedShifts({ today, catalog, cashAccounts, bookings, transactions, payments, entry }: Deps) {
  const shifts: CashierShift[] = []
  const handOvers: HandOver[] = []
  const reconciliations: Reconciliation[] = []
  const boxes = cashAccounts.filter((a) => a.kind === 'cashbox' && a.locationId && CASHIERS[a.id])
  const locationOf = (b: Booking) => catalog.place(b.unitId).location.id
  const at = (date: IsoDate, time: string) => `${date}T${time}:00`

  function open(box: CashAccount, date: IsoDate, time: string, from: CashierShift | null): CashierShift {
    const cashier = CASHIERS[box.id] ?? { id: 'usr-kadek', name: 'Kadek Ariani' }
    const n = shifts.length + 1
    const sh: CashierShift = { id: `cs-${n}`, number: `SH-${String(n).padStart(4, '0')}`, accountId: box.id, locationId: box.locationId ?? '', cashierId: cashier.id, cashierName: cashier.name, businessDate: date, openedAt: at(date, time), openingCount: countFor(FLOAT), float: FLOAT, handOverId: null, status: 'open', closedAt: null, closingCount: null, counted: null, expected: null, difference: null, reason: '', signOff: null, reconciliationId: null, dropped: 0, dropTransactionId: null, handedOverId: null }
    if (from) {
      const h: HandOver = { id: `ho-${handOvers.length + 1}`, accountId: box.id, fromShiftId: from.id, toShiftId: sh.id, amount: FLOAT, at: sh.openedAt, from: from.cashierName, to: cashier.name }
      handOvers.push(h)
      from.handedOverId = h.id
      sh.handOverId = h.id
    }
    shifts.push(sh)
    return sh
  }

  boxes.forEach((box, i) => {
    const locationId = box.locationId ?? ''
    let last: CashierShift | null = null
    for (let ago = 7; ago >= 1; ago--) {
      const date = addDays(today, -ago)
      const sh = open(box, date, '07:05', last)
      // What the desk recorded on the cashbox that day, and the guest money it took at this location.
      for (const t of transactions) if (t.accountId === box.id && t.date === date && t.origin !== 'reconciliation' && t.shiftId === undefined) t.shiftId = sh.id
      for (const p of payments) {
        const stay = bookings.find((b) => b.id === p.bookingId)
        if (p.paidOn === date && p.method !== 'airbnb_payout' && (p.method !== 'cash' || p.transactionId) && stay && locationOf(stay) === locationId) p.shiftId = sh.id
      }
      const base = { accountId: box.id, date, locationId, villaId: null, unitId: null, bookingId: null, reference: sh.number, origin: 'front_desk' as const }
      DESK_IN.slice(0, 2 + ((i + ago) % 2)).forEach((d, k) => {
        entry({ ...base, kind: 'cash_in', categoryId: d.categoryId, amount: pick(d.amounts, i + k, ago), description: d.what }, true).shiftId = sh.id
      })
      entry({ ...base, kind: 'cash_out', categoryId: DESK_OUT.categoryId, amount: pick(DESK_OUT.amounts, i, ago), description: DESK_OUT.what }, true).shiftId = sh.id

      const expected = shiftTotals(sh, transactions, payments).expected
      const diff = DIFFERENCES[`${box.id}|${ago}`]
      const counted = expected + (diff?.amount ?? 0)
      const closedAt = at(date, '21:50')
      Object.assign(sh, { status: 'closed', closedAt, closingCount: countFor(counted), counted, expected, difference: counted - expected, reason: diff?.reason ?? '', signOff: diff?.signedBy ? { by: diff.signedBy, at: at(date, '22:10'), note: 'Checked the slips with the cashier.' } : null })
      if (diff) {
        const adjustment = entry({ ...base, kind: diff.amount > 0 ? 'cash_in' : 'cash_out', categoryId: diff.amount > 0 ? 'cat-adjust-in' : 'cat-adjust-out', amount: Math.abs(diff.amount), description: `Cash count ${diff.amount > 0 ? 'over' : 'short'} on ${date}: Shift ${sh.number}, ${sh.cashierName}: ${diff.reason}`, reference: '', origin: 'reconciliation' }, true)
        const r: Reconciliation = { id: `rec-cs-${sh.id}`, accountId: box.id, date, expected, counted, difference: counted - expected, note: `Shift ${sh.number}, ${sh.cashierName}: ${diff.reason}`, by: sh.cashierName, adjustmentId: adjustment.id, shiftId: sh.id }
        reconciliations.push(r)
        sh.reconciliationId = r.id
      }
      // The excess over the float goes to the bank; the float stays for the next shift.
      const drop = counted - FLOAT
      if (drop > 0) {
        const transfer = { amount: drop, date, locationId, villaId: null, unitId: null, bookingId: null, description: `Cash drop from ${sh.number}`, reference: sh.number, origin: 'transfer' as const }
        const out = entry({ ...transfer, accountId: box.id, kind: 'cash_out', categoryId: 'cat-transfer-out' }, true)
        const back = entry({ ...transfer, accountId: 'bank-bca', kind: 'cash_in', categoryId: 'cat-transfer-in' }, true)
        for (const t of [out, back]) Object.assign(t, { transferId: `trf-${sh.id}`, shiftId: null })
        Object.assign(sh, { dropped: drop, dropTransactionId: out.id })
      }
      last = sh
    }
    // Canggu works today: the afternoon cashier took over yesterday's float and has one entry so far.
    if (box.id === 'cb-canggu' && last) {
      const sh = open(box, today, '14:02', last)
      entry({ accountId: box.id, date: today, locationId, villaId: null, unitId: null, bookingId: null, reference: sh.number, origin: 'front_desk', kind: 'cash_in', categoryId: 'cat-extra', amount: 300_000, description: 'Late check-out fee paid in cash' }, true).shiftId = sh.id
    }
  })
  return { shifts, handOvers, reconciliations }
}
