import { beforeEach, describe, expect, it } from 'vitest'
import { countFor, countTotal, needsSignOff, shiftTotals } from '@/domain/cashier'
import type { Transaction } from '@/domain/finance'
import type { Payment } from '@/domain/payment'
import { createMockPorts } from '@/infrastructure/mock'
import { addDays } from '@/lib/dates'
import type { Ports } from './ports'
import { createServices, type Services } from './services'

const TODAY = '2026-11-06'
let s: Services
let ports: Ports
const signIn = (who: string) => s.access.login({ email: `${who}@balivillas.id`, password: 'villa123' })

beforeEach(async () => {
  ports = createMockPorts({ today: () => TODAY }, 0)
  s = createServices(ports)
  await signIn('kadek')
})

/** Kadek, a manager, opens the Ubud drawer on a counted float. */
const openUbud = (float = 1_000_000) => s.cashier.open({ accountId: 'cb-ubud', count: countFor(float), handOverFrom: null })

/** A submitted cash entry on an account, as the desk records it. */
const deskEntry = (accountId: string, kind: 'cash_in' | 'cash_out', amount: number) =>
  s.finance.createTransaction({ accountId, kind, categoryId: kind === 'cash_in' ? 'cat-extra' : 'cat-house', amount, date: TODAY, locationId: 'loc-ubud', villaId: 'vil-tirta', unitId: null, bookingId: null, description: 'Desk entry for the test', reference: '', attachments: [] }, true)

describe('cashier shift domain', () => {
  it('counts a drawer by denomination', () => {
    expect(countTotal({ notes: { 100000: 3, 5000: 2, 1000: 4 }, coins: 1_500 })).toBe(315_500)
    expect(countTotal(countFor(2_347_500))).toBe(2_347_500)
  })

  it('expects the float plus cash in less cash out, leaving drafts, rejected entries and other drawers out', () => {
    const shift = { id: 'cs-x', accountId: 'cb', float: 500_000 }
    const t = (kind: Transaction['kind'], amount: number, status: Transaction['status'] = 'submitted', accountId = 'cb') => ({ shiftId: 'cs-x', accountId, kind, amount, status, categoryId: 'cat-extra' }) as Transaction
    const p = (method: Payment['method'], amount: number, kind: Payment['kind'] = 'balance') => ({ shiftId: 'cs-x', method, amount, kind, status: 'paid' }) as Payment
    const totals = shiftTotals(shift, [t('cash_in', 300_000), t('cash_out', 50_000, 'posted'), t('cash_in', 99_000, 'draft'), t('cash_in', 77_000, 'rejected'), t('cash_in', 10_000, 'submitted', 'other')], [p('qris', 400_000), p('card', 250_000), p('qris', 100_000, 'refund')])
    expect(totals).toMatchObject({ cashIn: 300_000, cashOut: 50_000, expected: 750_000 })
    expect(totals.byMethod).toEqual(expect.arrayContaining([{ method: 'qris', count: 2, amount: 300_000 }, { method: 'card', count: 1, amount: 250_000 }]))
  })

  it('needs a sign-off only past the tolerance', () => {
    expect(needsSignOff(-10_000, { tolerance: 10_000 })).toBe(false)
    expect(needsSignOff(10_001, { tolerance: 10_000 })).toBe(true)
  })
})

describe('cashier shifts', () => {
  it('seeds a week of closed shifts per cashbox, a couple of differences and one open shift at Canggu', async () => {
    const all = await ports.cashier.shifts()
    for (const box of ['cb-canggu', 'cb-ubud', 'cb-seminyak', 'cb-uluwatu']) {
      const closed = all.filter((x) => x.accountId === box && x.status === 'closed')
      expect(closed.map((x) => x.businessDate)).toEqual(Array.from({ length: 7 }, (_, i) => addDays(TODAY, i - 7)))
    }
    expect(all.filter((x) => x.status === 'open').map((x) => [x.accountId, x.cashierName])).toEqual([['cb-canggu', 'Wayan Sudiarta']])
    expect(all.filter((x) => x.difference).length).toBe(2)
    expect(all.find((x) => x.signOff)?.reconciliationId).toBeTruthy()
  })

  it('allows one open shift per cashbox and only the roster or a manager', async () => {
    await expect(s.cashier.open({ accountId: 'cb-canggu', count: countFor(500_000), handOverFrom: null })).rejects.toMatchObject({ code: 'SHIFT_ALREADY_OPEN' })
    await signIn('dian')
    await expect(s.cashier.open({ accountId: 'cb-ubud', count: countFor(500_000), handOverFrom: null })).rejects.toMatchObject({ code: 'SHIFT_NOT_ROSTERED' })
    await signIn('kadek')
    const shift = await s.cashier.open({ accountId: 'cb-ubud', count: countFor(500_000), handOverFrom: null })
    expect(shift).toMatchObject({ status: 'open', float: 500_000, cashierName: 'Kadek Ariani' })
  })

  it('stamps desk cash on the open cashbox and desk payments at its location, not entries elsewhere', async () => {
    const shift = await openUbud()
    const onBox = await deskEntry('cb-ubud', 'cash_in', 250_000)
    const onBank = await deskEntry('bank-bca', 'cash_in', 250_000)
    expect(onBox.shiftId).toBe(shift.id)
    expect(onBank.shiftId).toBeUndefined()

    const bookings = await ports.booking.bookings()
    const units = await ports.property.units()
    const ubudVilla = (unitId: string) => units.find((u) => u.id === unitId)?.villaId === 'vil-tirta'
    const stay = bookings.find((b) => ubudVilla(b.unitId) && b.source === 'direct' && (b.status === 'confirmed' || b.status === 'checked_in') && b.paymentStatus !== 'paid')
    expect(stay).toBeDefined()
    if (!stay) return
    const paid = await s.payments.record({ bookingId: stay.id, kind: 'balance', method: 'bank_transfer', amount: 100_000, reference: 'TRF-TEST', payer: 'Guest', note: '' })
    expect(paid.shiftId).toBe(shift.id)
    const detail = await s.cashier.shift(shift.id)
    expect(detail.shift.totals.byMethod).toContainEqual({ method: 'bank_transfer', count: 1, amount: 100_000 })
    expect(detail.shift.totals.expected).toBe(1_250_000)
  })

  it('posts a difference within the tolerance through the cash count reconciliation', async () => {
    const shift = await openUbud()
    await deskEntry('cb-ubud', 'cash_in', 400_000)
    await deskEntry('cb-ubud', 'cash_out', 100_000)
    const closed = await s.cashier.close(shift.id, { count: countFor(1_295_000), reason: '' })
    expect(closed).toMatchObject({ status: 'closed', expected: 1_300_000, counted: 1_295_000, difference: -5_000 })
    const count = (await ports.finance.reconciliations()).find((r) => r.id === closed.reconciliationId)
    expect(count).toMatchObject({ accountId: 'cb-ubud', expected: 1_300_000, counted: 1_295_000, difference: -5_000, shiftId: shift.id })
    const adjustment = (await ports.finance.transactions()).find((t) => t.id === count?.adjustmentId)
    expect(adjustment).toMatchObject({ kind: 'cash_out', categoryId: 'cat-adjust-out', amount: 5_000, origin: 'reconciliation', status: 'submitted' })
    expect(adjustment?.shiftId).toBeUndefined()
  })

  it('holds a difference past the tolerance for a reason and another manager’s sign-off', async () => {
    const shift = await openUbud()
    await expect(s.cashier.close(shift.id, { count: countFor(950_000), reason: '' })).rejects.toMatchObject({ code: 'SHIFT_REASON_REQUIRED' })
    const held = await s.cashier.close(shift.id, { count: countFor(950_000), reason: 'Paid a taxi from the drawer, slip lost.' })
    expect(held).toMatchObject({ status: 'awaiting_signoff', difference: -50_000, reconciliationId: null })
    await expect(s.cashier.signOff(shift.id, 'ok')).rejects.toMatchObject({ code: 'SHIFT_SELF_SIGNOFF' })
    await signIn('wayan')
    await expect(s.cashier.signOff(shift.id, 'ok')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await signIn('ida')
    const signed = await s.cashier.signOff(shift.id, 'Checked with Kadek.')
    expect(signed).toMatchObject({ status: 'closed', signOff: { by: 'Ida Bagus Rai' } })
    expect((await ports.finance.reconciliations()).find((r) => r.id === signed.reconciliationId)?.difference).toBe(-50_000)
  })

  it('hands the rest of the drawer to the next cashier after a drop to the bank', async () => {
    const shift = await openUbud()
    await deskEntry('cb-ubud', 'cash_in', 700_000)
    await s.cashier.close(shift.id, { count: countFor(1_700_000), reason: '' })
    const dropped = await s.cashier.drop(shift.id, { toAccountId: 'bank-bca', amount: 1_200_000, note: 'Evening bank run' })
    const entries = await ports.finance.transactions()
    const transferId = entries.find((t) => t.id === dropped.dropTransactionId)?.transferId
    const transfer = entries.filter((t) => transferId && t.transferId === transferId)
    expect(transfer.map((t) => [t.accountId, t.kind, t.amount])).toEqual([['cb-ubud', 'cash_out', 1_200_000], ['bank-bca', 'cash_in', 1_200_000]])
    await expect(s.cashier.drop(shift.id, { toAccountId: 'bank-bca', amount: 100_000, note: '' })).rejects.toMatchObject({ code: 'SHIFT_ALREADY_DROPPED' })

    await signIn('putu')
    const next = await s.cashier.open({ accountId: 'cb-ubud', count: countFor(0), handOverFrom: shift.id })
    expect(next).toMatchObject({ float: 500_000, cashierName: 'Putu Eka Wijaya' })
    const handOver = (await ports.cashier.handOvers()).find((h) => h.id === next.handOverId)
    expect(handOver).toMatchObject({ fromShiftId: shift.id, toShiftId: next.id, amount: 500_000, from: 'Kadek Ariani', to: 'Putu Eka Wijaya' })
    await s.cashier.close(next.id, { count: countFor(500_000), reason: '' })
    await expect(s.cashier.open({ accountId: 'cb-ubud', count: countFor(0), handOverFrom: shift.id })).rejects.toMatchObject({ code: 'SHIFT_HANDED_OVER' })
  })

  it('counts a closed shift as the cashbox count and lists open shifts on the night audit', async () => {
    const shift = await openUbud()
    let checks = (await s.nightAudit.overview()).checks
    expect(checks.find((c) => c.key === 'shiftsOpen')?.items.map((i) => i.to)).toEqual(expect.arrayContaining([`/finance/shifts/${shift.id}`]))
    expect(checks.find((c) => c.key === 'cashCount')?.items.map((i) => i.label)).toContain('Ubud cashbox')
    await s.cashier.close(shift.id, { count: countFor(1_000_000), reason: '' })
    checks = (await s.nightAudit.overview()).checks
    expect(checks.find((c) => c.key === 'cashCount')?.items.map((i) => i.label)).not.toContain('Ubud cashbox')
    expect(checks.find((c) => c.key === 'shiftsOpen')?.items.map((i) => i.to)).not.toContain(`/finance/shifts/${shift.id}`)
  })

  it('reports shifts by day and over and short by cashier', async () => {
    await signIn('ida')
    const summary = await s.reports.run('cashier-shifts', { from: addDays(TODAY, -7), to: TODAY })
    expect(summary.rows.length).toBe(29)
    const byCashier = await s.reports.run('cashier-over-short', { from: addDays(TODAY, -7), to: TODAY })
    expect(byCashier.rows.find((r) => r.cashier === 'Dian Permata')).toMatchObject({ shifts: 7, short: -25_000, beyond: 1, signedOff: 1 })
  })
})
