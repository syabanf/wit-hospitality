import { beforeEach, describe, expect, it } from 'vitest'
import { bookingTotal, type CheckInDetails, type CheckOutDetails } from '@/domain/booking'
import { guestFolio, type FolioLine } from '@/domain/folio'
import { buildJournals, GL, partyBalances, payableBilled, PB1_CATEGORY } from '@/domain/journal'
import { PB1_CODE, SERVICE_CODE } from '@/domain/tax'
import { createMockPorts } from '@/infrastructure/mock'
import { buildState, stayBooks } from '@/infrastructure/mock/state'
import { addDays } from '@/lib/dates'
import type { Ports } from './ports'
import { createServices, type Services } from './services'

const TODAY = '2026-11-06'
const arrival: CheckInDetails = { idVerified: true, deposit: 0, keysHanded: true, rulesExplained: true, arrivalTime: '14:00', adults: 2, children: 0, notes: '' }
const departure: CheckOutDetails = { depositReturned: 0, extraCharges: 0, roomInspected: true, keysReturned: true, notes: '' }

/** Posted lines on one tax code, rebates taken off. */
const taxOn = (lines: readonly FolioLine[], code: string, pick: (l: FolioLine) => boolean = () => true) => lines.filter((l) => l.code === code && !l.forecast && pick(l)).reduce((sum, l) => sum + l.debit - l.credit, 0)

describe('the seeded books', () => {
  const s = buildState(TODAY)
  const stays = stayBooks(s)
  const rebuilt = buildJournals({ cashAccounts: s.cashAccounts, transactions: s.transactions, periods: s.periods, loans: s.loans, map: s.categoryAccounts, categories: s.categories, stays })
  const payable = (accountId: string, bookingId: string) => {
    const m = partyBalances(rebuilt, accountId, 'bookingId').get(bookingId)
    return (m?.credit ?? 0) - (m?.debit ?? 0)
  }

  it('holds on the payables the service and PB1 the folios billed through the console', () => {
    let checked = 0
    for (const b of s.bookings.filter((x) => x.status === 'checked_in' || x.status === 'checked_out')) {
      const f = guestFolio({ booking: b, payments: s.payments, orders: s.orders, postings: s.folioPostings, tax: s.tax })
      // Room money paid before the console sits in the opening books with its tax; the payables carry the rest.
      const beforeConsole = s.payments.some((p) => p.bookingId === b.id && p.transactionId === null && p.status === 'paid')
      const billed = (l: FolioLine) => !beforeConsole || l.part !== 'room'
      expect(payable(GL.servicePayable, b.id), `${b.code} service`).toBe(taxOn(f.lines, SERVICE_CODE, billed))
      expect(payable(GL.pb1Payable, b.id), `${b.code} PB1`).toBe(taxOn(f.lines, PB1_CODE, billed))
      if (taxOn(f.lines, SERVICE_CODE, billed) > 0) checked++
    }
    expect(checked).toBeGreaterThan(0)
  })

  it('shows the room of a stay paid before the console split, with the bill and the cash as they were', () => {
    const b = s.bookings.find((x) => x.status === 'checked_out' && x.source === 'direct')
    if (!b) throw new Error('no direct stay that left')
    const f = guestFolio({ booking: b, payments: s.payments.filter((p) => !p.orderIds?.length), orders: [], postings: [], tax: s.tax })
    expect(f.taxes.service).toBeGreaterThan(0)
    expect(f.taxes.total).toBe(bookingTotal(b))
    expect(f.taxes.subtotal + f.taxes.service + f.taxes.pb1).toBe(bookingTotal(b))
    expect(f.balance).toBe(0)
  })

  it('pays the payroll service charge out of what the books collected', () => {
    for (const p of s.periods) expect(p.revenueBase, p.month).toBe(payableBilled(rebuilt, GL.servicePayable, p.month))
    const closed = s.periods.filter((p) => p.status === 'closed')
    const paidOut = closed.reduce((sum, p) => sum + p.lines.reduce((x, l) => x + l.serviceCharge, 0), 0)
    const debited = rebuilt.filter((e) => e.source === 'payroll').flatMap((e) => e.lines).filter((l) => l.accountId === GL.servicePayable).reduce((sum, l) => sum + l.debit, 0)
    expect(debited).toBe(paidOut)
  })
})

describe('tax through the console', () => {
  let s: Services
  let ports: Ports
  const clock = { date: TODAY, today() { return this.date } }
  const signIn = (who: string) => s.access.login({ email: `${who}@balivillas.id`, password: 'villa123' })

  beforeEach(async () => {
    clock.date = TODAY
    ports = createMockPorts(clock, 0)
    s = createServices(ports)
    await signIn('kadek')
  })

  async function postOpen() {
    for (const who of ['rama', 'ida']) {
      await signIn(who)
      for (const t of (await s.finance.transactions()).list.filter((x) => x.status === 'submitted')) await s.finance.transition(t.id, 'approved').catch(() => undefined)
    }
    for (const t of (await s.finance.transactions()).list.filter((x) => x.status === 'approved')) await s.finance.transition(t.id, 'posted')
    await signIn('kadek')
  }

  it('quotes, bills and books a net direct stay: Rp 1,000,000 a night comes to 1,210,000', async () => {
    const { list } = await s.booking.list()
    const taken = list.find((b) => b.unitCode === 'TR-01' && b.status === 'confirmed' && b.checkIn === TODAY)
    if (taken) await s.booking.transition(taken.id, 'cancelled')
    const unit = (await s.booking.formOptions()).catalog.unitByCode('TR-01')
    const input = { unitId: unit.id, groupId: null, checkIn: TODAY, checkOut: addDays(TODAY, 2), source: 'direct' as const, channelRate: null, price: { rateOverride: 1_000_000, discount: null, reason: 'Agreed rate' } }
    const quote = await s.booking.quote(input)
    expect(quote?.tax).toMatchObject({ mode: 'net', net: 2_000_000, service: 200_000, pb1: 220_000, total: 2_420_000, note: 'Prices exclude 10% service and 10% PB1' })
    await expect(s.booking.create({ ...input, guestId: 'g-11', newGuest: null, airbnbAccountId: null, airbnbCode: null, notes: '', confirm: true, payment: { kind: 'full', method: 'cash', amount: 2_420_001, reference: '' } })).rejects.toMatchObject({ errors: { 'payment.amount': expect.any(String) } })
    const b = await s.booking.create({ ...input, guestId: 'g-11', newGuest: null, airbnbAccountId: null, airbnbCode: null, notes: '', confirm: true, payment: { kind: 'deposit', method: 'cash', amount: 726_000, reference: '' } })
    expect(b.total).toBe(2_420_000)
    const inv = await s.payments.invoice(b.id)
    expect(inv.tax).toEqual({ subtotal: 2_000_000, service: 200_000, pb1: 220_000, total: 2_420_000, note: 'Prices exclude 10% service and 10% PB1' })
    expect(inv.outstanding).toBe(2_420_000 - 726_000)

    await s.booking.checkIn(b.id, arrival)
    await s.nightAudit.run()
    const { folio } = await s.booking.folio(b.id)
    expect(folio.lines.filter((l) => l.kind === 'tax' && !l.forecast).map((l) => [l.code, l.debit]).sort()).toEqual([[PB1_CODE, 110_000], [SERVICE_CODE, 100_000]])
    expect(folio.taxes).toEqual({ subtotal: 2_000_000, service: 200_000, pb1: 220_000, total: 2_420_000 })
    expect(folio.balance).toBe(1_210_000 - 726_000)

    // A desk charge on a net stay gets service and PB1 on top; a rebate on it takes its share back.
    await s.booking.postCharge(b.id, { code: 'LATE', description: 'Late check-out', amount: 500_000 })
    const charge = (await s.booking.folio(b.id)).folio.lines.find((l) => l.kind === 'charge')
    if (!charge) throw new Error('no charge')
    const rebate = await s.booking.postRebate(b.id, { lineId: charge.id, amount: 50_000, reason: 'Pool pump noise' })
    expect(rebate).toMatchObject({ amount: 50_000, service: 5_000, pb1: 5_500 })
    const settled = await s.booking.settlement(b.id)
    expect(settled.charges).toBe(605_000 - 60_500)

    await s.booking.settleAndCheckOut(b.id, { details: departure, method: 'cash', reference: '', attachments: [] })
    await postOpen()
    await signIn('ida')
    const views = (await s.accounting.journals()).views
    const party = (accountId: string) => {
      const m = partyBalances(views, accountId, 'bookingId').get(b.id)
      return (m?.credit ?? 0) - (m?.debit ?? 0)
    }
    expect(party(GL.receivable)).toBe(0)
    expect(party(GL.servicePayable)).toBe(200_000 + 50_000 - 5_000)
    expect(party(GL.pb1Payable)).toBe(220_000 + 55_000 - 5_500)
    const tb = await s.accounting.trialBalance({})
    expect(tb.debit).toBe(tb.credit)
  })

  it('starts new rates today or later and keeps the earlier ones', async () => {
    await signIn('ida')
    const { tax, current } = await s.accounting.taxSettings()
    if (!current) throw new Error('no rates')
    const input = { rates: { ...current, effectiveFrom: addDays(TODAY, -1), servicePct: 11 }, directMode: tax.directMode, regencies: {} }
    await expect(s.accounting.saveTaxSettings(input)).rejects.toMatchObject({ code: 'TAX_RATES_BACKDATED' })
    const saved = await s.accounting.saveTaxSettings({ ...input, rates: { ...input.rates, effectiveFrom: addDays(TODAY, 1) } })
    expect(saved.rates.map((r) => [r.effectiveFrom, r.servicePct])).toEqual([[current.effectiveFrom, 10], [addDays(TODAY, 1), 11]])
    await signIn('nia')
    await expect(s.accounting.saveTaxSettings(input)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('pays PB1 for a closed month, one cash-out per regency through approval', async () => {
    // November's orders billed PB1; once the month is over and every entry in it has posted, finance closes it.
    clock.date = '2026-12-02'
    await postOpen()
    await signIn('ida')
    await expect(s.accounting.payPb1('2026-11', 'bank-bca')).rejects.toMatchObject({ code: 'PERIOD_OPEN' })
    await s.accounting.closePeriod('2026-11', '')
    const owed = (await s.accounting.taxSettings()).months.find((m) => m.month === '2026-11')?.remittances.filter((r) => r.amount > 0) ?? []
    expect(owed.length).toBeGreaterThan(0)
    const created = await s.accounting.payPb1('2026-11', 'bank-bca')
    expect(created.map((t) => [t.categoryId, t.amount, t.status, t.reference])).toEqual(owed.map((r) => [PB1_CATEGORY, r.amount, 'submitted', r.reference]))
    await expect(s.accounting.payPb1('2026-11', 'bank-bca')).rejects.toMatchObject({ code: 'PB1_PAID' })
    const report = await s.reports.run('pb1-regency', { from: '2026-11-01', to: '2026-11-30' })
    expect(report.rows.find((r) => r.regency === owed[0]?.regency)).toMatchObject({ billed: owed[0]?.amount, status: 'Submitted' })
    expect((await s.reports.run('service-villa', { from: '2026-11-01', to: '2026-11-30' })).rows.length).toBeGreaterThan(0)
  })
})
