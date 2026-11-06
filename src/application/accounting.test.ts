import { beforeEach, describe, expect, it } from 'vitest'
import { bookingTotal, type CheckOutDetails } from '@/domain/booking'
import { balance, counts, signed } from '@/domain/finance'
import { guestFolio, postingGross } from '@/domain/folio'
import { ratesOn, stayTax, taxSplit } from '@/domain/tax'
import { balanceSheet, buildJournals, cashGlId, chartOfAccounts, depositsHeld, incomeStatement, journalFor, monthsSince, nightJournal, ownerCloseJournal, partyBalances, ROOM_SERVICE_ACCOUNTS, stayJournal, statutoryRemittances, totalCredits, totalDebits, trialBalance, GL, type JournalEntry } from '@/domain/journal'
import { codeSplit, orderTotals, PARTNER_COST_CATEGORY, partnerCosts } from '@/domain/serviceOrder'
import { codeAccount, DEFAULT_TRANSACTION_CODES, MENU_CATEGORY_CODE } from '@/domain/transactionCode'
import { accountBalance, statusRules } from '@/domain/cityLedger'
import { addDays, addMonths } from '@/lib/dates'
import { fixedClock } from '@/infrastructure/clock'
import { createMockPorts } from '@/infrastructure/mock'
import { buildState, stayBooks } from '@/infrastructure/mock/state'
import type { Ports } from './ports'
import { createServices, type Services } from './services'

const TODAY = '2026-11-06'

describe('check the books', () => {
  const s = buildState(TODAY)
  const rebuilt = buildJournals({ cashAccounts: s.cashAccounts, transactions: s.transactions, periods: s.periods, loans: s.loans, map: s.categoryAccounts, categories: s.categories, stays: stayBooks(s), ownerStatements: s.ownerStatements, cityLedgerInvoices: s.cityLedgerInvoices })
  const chart = chartOfAccounts(s.cashAccounts)

  it('rebuilds the seeded journal from the cash ledger', () => {
    expect(rebuilt.map((e) => e.lines)).toEqual(s.journals.map((e) => e.lines))
    expect(rebuilt.some((e) => e.source === 'opening')).toBe(true)
    expect(rebuilt.filter((e) => e.source === 'payroll')).toHaveLength(2)
    expect(rebuilt.some((e) => e.source === 'transfer')).toBe(true)
    expect(rebuilt.filter((e) => e.source === 'owner')).toHaveLength(s.ownerStatements.length)
  })

  it('balances every entry', () => {
    for (const e of rebuilt) expect(totalDebits(e.lines), e.memo).toBe(totalCredits(e.lines))
  })

  it('nets the trial balance to zero and balances the sheet at every month end', () => {
    const first = rebuilt.reduce((min, e) => (e.date < min ? e.date : min), TODAY)
    for (const month of monthsSince(first, TODAY)) {
      const end = addDays(addMonths(`${month}-01`, 1), -1)
      const tb = trialBalance(chart, rebuilt, { to: end })
      expect(tb.debit, month).toBe(tb.credit)
      const bs = balanceSheet(chart, rebuilt, { asOf: end })
      expect(bs.totalAssets, month).toBe(bs.totalLiabilities + bs.totalEquity)
    }
  })

  it('keeps every cash GL account equal to its cash ledger balance', () => {
    const tb = trialBalance(chart, rebuilt, {})
    for (const a of s.cashAccounts) {
      const row = tb.rows.find((r) => r.account.id === cashGlId(a.id))
      expect((row?.debit ?? 0) - (row?.credit ?? 0), a.name).toBe(balance(a, s.transactions))
    }
    const loans = tb.rows.find((r) => r.account.id === GL.employeeLoans)
    expect((loans?.debit ?? 0) - (loans?.credit ?? 0)).toBe(s.loans.filter((l) => l.status === 'active').reduce((sum, l) => sum + l.amount - l.repaid, 0))
  })

  it('ends the receivable of every settled stay at zero', () => {
    const owed = partyBalances(rebuilt, GL.receivable, 'bookingId')
    const settled = s.bookings.filter((b) => b.status === 'checked_out' && guestFolio({ booking: b, payments: s.payments, orders: s.orders, postings: s.folioPostings }).balance === 0)
    expect(settled.length).toBeGreaterThan(0)
    for (const b of settled) {
      const m = owed.get(b.id)
      expect((m?.debit ?? 0) - (m?.credit ?? 0), b.code).toBe(0)
    }
  })

  it('keeps City ledger receivable equal to the open account balances, and the stays it took at zero', () => {
    const src = { transfers: s.folioPostings, invoices: s.cityLedgerInvoices, payments: s.cityLedgerPayments, writeOffs: s.cityLedgerWriteOffs, bookingCode: (id: string) => id, ...statusRules((id) => s.transactions.find((t) => t.id === id)?.status, (id) => s.manualJournals.find((m) => m.id === id)?.status) }
    const open = s.cityLedgerAccounts.reduce((sum, a) => sum + accountBalance(a.id, src), 0)
    const tb = trialBalance(chart, rebuilt, {})
    const row = tb.rows.find((r) => r.account.id === GL.cityLedger)
    expect(open).toBeGreaterThan(0)
    expect((row?.debit ?? 0) - (row?.credit ?? 0)).toBe(open)
    expect(rebuilt.some((e) => e.source === 'city_ledger' && e.lines.some((l) => l.accountId === GL.agentCommission))).toBe(true)
    const owed = partyBalances(rebuilt, GL.receivable, 'bookingId')
    const moved = s.bookings.filter((b) => b.cityLedger && b.status === 'checked_out')
    expect(moved.length).toBeGreaterThan(0)
    for (const b of moved) {
      expect(guestFolio({ booking: b, payments: s.payments, orders: s.orders, postings: s.folioPostings, tax: s.tax }).balance, b.code).toBe(0)
      const m = owed.get(b.id)
      expect((m?.debit ?? 0) - (m?.credit ?? 0), b.code).toBe(0)
    }
  })

  it('books room service revenue on delivery, net of items on the house and discounts', () => {
    const from = `${TODAY.slice(0, 4)}-01-01`
    const delivered = s.orders.filter((o) => o.status === 'delivered' && o.deliveredOn && o.deliveredOn >= from && o.deliveredOn <= TODAY)
    expect(delivered.some((o) => s.bookings.find((b) => b.id === o.bookingId)?.status === 'checked_out')).toBe(true)
    expect(delivered.some((o) => orderTotals(o).comp > 0) && delivered.some((o) => orderTotals(o).discount > 0)).toBe(true)
    const statement = incomeStatement(chart, rebuilt, { from, to: TODAY }).revenue
    const revenue = statement.filter((l) => ROOM_SERVICE_ACCOUNTS.includes(l.account.id)).reduce((sum, l) => sum + l.amount, 0)
    // Folio charges on a room service code (a minibar charge) book beside the orders.
    const charged = s.folioPostings.filter((p) => ROOM_SERVICE_ACCOUNTS.includes(codeAccount(s.transactionCodes, p.code))).reduce((sum, p) => sum + (p.kind === 'charge' ? p.amount : -p.amount), 0)
    // Menu prices include service and PB1: revenue is each code's charge net of them.
    const nets = delivered.flatMap((o) => codeSplit(o).map((r) => ({ code: r.code, net: taxSplit(r.amount, r.code, ratesOn(s.tax, o.deliveredOn ?? ''), 'inclusive').net })))
    expect(revenue).toBe(nets.reduce((sum, r) => sum + r.net, 0) + charged)
    // Each code books to its own account: food and drinks, minibar and the rest apart.
    const byCode = (code: string) => nets.filter((r) => r.code === code).reduce((sum, r) => sum + r.net, 0)
    expect(statement.find((l) => l.account.id === GL.fnb)?.amount).toBe(byCode('FNB'))
    expect(byCode('FNB')).toBeGreaterThan(0)
    expect(revenue).toBeGreaterThan(0)
    // Order money pays the receivable and never waits on Guest deposits.
    const orderEntries = new Set(s.payments.filter((p) => p.orderIds?.length).flatMap((p) => [p.transactionId, ...(p.extraTransactionIds ?? [])]))
    const orderLines = rebuilt.filter((e) => orderEntries.has(e.sourceId)).flatMap((e) => e.lines)
    expect(orderLines.some((l) => l.accountId === GL.receivable)).toBe(true)
    expect(orderLines.some((l) => l.accountId === GL.deposits)).toBe(false)
  })

  it('clears an Airbnb stay through the receivable: nights at the channel price, the fee at check-out, the payout settling the rest', () => {
    const seeded = s.bookings.find((x) => x.source === 'airbnb' && x.status === 'checked_out' && x.checkedOutOn)
    const template = s.transactions.find((t) => t.status === 'posted' && t.kind === 'cash_in')
    if (!seeded?.checkedOutOn || !template) throw new Error('seed has no checked-out Airbnb stay')
    const on = addDays(seeded.checkIn, 1)
    const payout = { ...template, id: 'tx-payout', accountId: 'bank-bca', categoryId: 'cat-airbnb', amount: bookingTotal(seeded) - seeded.airbnbFee, date: on, bookingId: seeded.id, transferId: null, reversalOf: null, origin: 'payment' as const, history: [{ kind: 'posted' as const, by: 'Ida Bagus Rai', role: 'finance' as const, on, note: '' }] }
    /** The same stay with its payout through the console instead of before it, audited or not. */
    const run = (nightsPosted: readonly string[]) => {
      const b = { ...seeded, nightsPosted }
      const stays = { ...stayBooks(s), bookings: s.bookings.map((x) => (x.id === b.id ? b : x)), payments: s.payments.filter((p) => p.bookingId !== b.id) }
      const paid = journalFor(payout, { transactions: [payout], periods: [], map: s.categoryAccounts, categories: s.categories, stays })
      const nights = nightsPosted.map((date, i) => nightJournal(b, stays, { from: i, to: i + 1 }, i === 0 ? depositsHeld([paid], b.id) : 0, date))
      const entries = [paid, ...nights, stayJournal(b, stays, nightsPosted.length ? 0 : depositsHeld([paid], b.id), seeded.checkedOutOn ?? '')].filter((e) => e !== null)
      const line = (id: string) => entries.flatMap((e) => e.lines).filter((l) => l.accountId === id).reduce((sum, l) => sum + l.debit - l.credit, 0)
      return { paid, line }
    }
    // Not audited: the payout waits on Guest deposits and check-out bills every night.
    const unaudited = run([])
    expect(unaudited.paid.lines.find((l) => l.accountId === GL.deposits)).toMatchObject({ credit: payout.amount, bookingId: seeded.id })
    // Audited night by night: the payout after the first night pays the receivable.
    const audited = run(seeded.nightsPosted ?? [])
    expect(audited.paid.lines.find((l) => l.accountId === GL.receivable)).toMatchObject({ credit: payout.amount, bookingId: seeded.id })
    for (const { line } of [unaudited, audited]) {
      // Airbnb prices are inclusive: the channel price splits into room revenue, service and PB1.
      const split = stayTax(seeded, s.tax)
      expect(split.total).toBe(bookingTotal(seeded))
      expect(line(GL.roomRevenue)).toBe(-split.net)
      expect(line(GL.servicePayable)).toBe(-split.service)
      expect(line(GL.pb1Payable)).toBe(-split.pb1)
      expect(line(GL.fees)).toBe(seeded.airbnbFee)
      expect(line(GL.deposits)).toBe(0)
      expect(line(GL.receivable)).toBe(0)
    }
  })

  it('keeps the partner payable at delivered partner cost less the partner bills paid', () => {
    expect(partnerOwed(rebuilt)).toEqual(partnerExpected(s.orders, s.transactions))
    expect(rebuilt.some((e) => e.source === 'order')).toBe(true)
  })

  it('pays the older payroll month to the BPJS and tax offices and leaves the latest one owed', () => {
    const closed = s.periods.filter((p) => p.status === 'closed')
    const [older, latest] = closed
    expect(statutoryRemittances(older!, s.transactions).every((r) => r.entry?.status === 'posted')).toBe(true)
    const owed = statutoryRemittances(latest!, s.transactions)
    expect(owed.every((r) => r.entry === null && r.amount > 0)).toBe(true)
    const tb = trialBalance(chart, rebuilt, {})
    const credit = (id: string) => (tb.rows.find((r) => r.account.id === id)?.credit ?? 0)
    expect(credit(GL.bpjsPayable)).toBe(owed.find((r) => r.key === 'bpjs')?.amount)
    expect(credit(GL.pph21Payable)).toBe(owed.find((r) => r.key === 'pph21')?.amount)
  })

  it('clears the payable to owners for every paid statement and owes the rest, a carried shortfall as a debit', () => {
    const payable = (entries: readonly JournalEntry[]) => entries.flatMap((e) => e.lines).filter((l) => l.accountId === GL.ownerPayable).reduce((sum, l) => sum + l.credit - l.debit, 0)
    const paid = s.ownerStatements.filter((st) => s.transactions.find((t) => t.id === st.payoutTransactionId)?.status === 'posted')
    expect(paid.length).toBe(s.contracts.length)
    for (const st of paid) expect(payable(rebuilt.filter((e) => (e.source === 'owner' && e.sourceId === st.id) || e.sourceId === st.payoutTransactionId)), st.number).toBe(0)
    const unpaid = s.ownerStatements.filter((st) => !paid.includes(st))
    expect(payable(rebuilt)).toBe(unpaid.reduce((sum, st) => sum + st.payable, 0))
    const reserve = trialBalance(chart, rebuilt, {}).rows.find((r) => r.account.id === GL.ownerReserve)
    expect(reserve?.credit).toBe(s.ownerStatements.reduce((sum, st) => sum + st.figures.reserve, 0))
  })
})

/** Payable per partner from the journal lines that name one. */
function partnerOwed(entries: readonly JournalEntry[]) {
  return Object.fromEntries([...partyBalances(entries, GL.partnerPayable, 'partnerId')].map(([id, m]) => [id, m.credit - m.debit]).filter(([, v]) => v !== 0))
}

/** Delivered partner cost per partner less the partner bills that counted, reversals netted. */
function partnerExpected(orders: ReturnType<typeof buildState>['orders'], transactions: ReturnType<typeof buildState>['transactions']) {
  const out: Record<string, number> = {}
  for (const o of orders.filter((x) => x.status === 'delivered'))
    partnerCosts(o).forEach((c, i) => {
      const bill = transactions.find((t) => t.id === o.costTransactionIds[i])
      const paid = transactions.filter((t) => t.categoryId === PARTNER_COST_CATEGORY && counts(t) && (t.id === bill?.id || t.reversalOf === bill?.id)).reduce((sum, t) => sum - signed(t), 0)
      out[c.partnerId] = (out[c.partnerId] ?? 0) + c.amount - paid
    })
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== 0))
}

describe('accounting use cases', () => {
  let svc: Services
  let ports: Ports
  const signIn = (who: string) => svc.access.login({ email: `${who}@balivillas.id`, password: 'villa123' })
  /** Signs every level with the signers in turn, then posts as finance. */
  async function signAndPost(id: string, signers = ['rama', 'ida']) {
    for (const who of signers) {
      await signIn(who)
      const t = (await svc.finance.transactions()).list.find((x) => x.id === id)
      if (t?.status === 'submitted') await svc.finance.transition(id, 'approved')
    }
    await svc.finance.transition(id, 'posted')
  }
  beforeEach(() => {
    ports = createMockPorts(fixedClock(TODAY), 0)
    svc = createServices(ports)
  })

  it('writes a journal entry when an entry posts and the reversing entry on reversal', async () => {
    await signIn('kadek')
    const t = await svc.finance.createTransaction({ accountId: 'cb-ubud', kind: 'cash_out', categoryId: 'cat-util', amount: 400_000, date: TODAY, locationId: 'loc-ubud', villaId: 'vil-tirta', unitId: null, bookingId: null, description: 'Gas refill', reference: '', attachments: [] }, true)
    await signIn('rama')
    await svc.finance.transition(t.id, 'approved')
    await svc.finance.transition(t.id, 'posted')
    const reversal = await svc.finance.reverse(t.id, 'Charged twice')
    const { views } = await svc.accounting.journals()
    const posted = views.find((e) => e.sourceId === t.id)
    expect(posted?.lines.map((l) => [l.account.id, l.debit, l.credit])).toEqual([['gl-6200', 400_000, 0], [cashGlId('cb-ubud'), 0, 400_000]])
    expect(posted?.href).toBe(`/finance/transactions/${t.id}`)
    expect(views.find((e) => e.sourceId === reversal.id)?.lines.map((l) => [l.account.id, l.debit, l.credit])).toEqual([[cashGlId('cb-ubud'), 400_000, 0], ['gl-6200', 0, 400_000]])
    const tb = await svc.accounting.trialBalance({})
    expect(tb.debit).toBe(tb.credit)
  })

  it('maps a category to another account for new postings only', async () => {
    const before = (await svc.accounting.journals()).views.length
    await expect(svc.accounting.mapCategory('cat-util', cashGlId('bank-bca'))).rejects.toMatchObject({ code: 'LEDGER_ACCOUNT_INVALID' })
    await svc.accounting.mapCategory('cat-util', 'gl-6400')
    expect((await svc.accounting.categoryAccounts()).categories.find((c) => c.id === 'cat-util')?.accountId).toBe('gl-6400')
    expect((await svc.accounting.journals()).views).toHaveLength(before)
  })

  it('books guest revenue by transaction code: a remapped code applies to postings from then on', async () => {
    await signIn('ida')
    await expect(svc.accounting.mapCategory('cat-svc-fnb', GL.otherIncome)).rejects.toMatchObject({ code: 'CATEGORY_FOLLOWS_CODE' })
    expect((await svc.accounting.categoryAccounts()).byCode.map((c) => c.id)).toContain('cat-svc-fnb')
    const { codes } = await svc.accounting.transactionCodes()
    const mini = codes.find((c) => c.code === 'MINI')
    const room = codes.find((c) => c.code === 'ROOM')
    if (!mini || !room) throw new Error('seed codes missing')
    await expect(svc.accounting.setTransactionCodeActive(room.id, false)).rejects.toMatchObject({ code: 'CODE_IN_USE' })
    await expect(svc.accounting.saveTransactionCode(null, { code: 'MINI', name: 'Second minibar', kind: 'charge', department: 'minibar', accountId: GL.minibar, active: true })).rejects.toMatchObject({ errors: { code: expect.any(String) } })
    const before = (await svc.accounting.journals()).views.filter((e) => e.lines.some((l) => l.account.id === GL.minibar)).length
    await svc.accounting.saveTransactionCode(mini.id, { ...mini, accountId: GL.otherIncome })

    await signIn('kadek')
    const stay = (await svc.booking.list()).list.find((b) => b.status === 'checked_in')
    if (!stay) throw new Error('nobody in house')
    await svc.booking.postCharge(stay.id, { code: 'MINI', description: 'Two colas', amount: 60_000 })
    await expect(svc.booking.postCharge(stay.id, { code: 'ROOM', description: 'Extra night', amount: 60_000 })).rejects.toMatchObject({ errors: { code: expect.any(String) } })
    await signIn('ida')
    const views = (await svc.accounting.journals()).views
    expect(views.filter((e) => e.lines.some((l) => l.account.id === GL.minibar))).toHaveLength(before)
    // The seeded stay reads inclusive: the 60,000 splits into net revenue, service and PB1.
    const colas = views.find((e) => e.source === 'charge' && e.memo.includes('Two colas'))?.lines ?? []
    expect(colas.find((l) => l.code === 'MINI')).toMatchObject({ account: { id: GL.otherIncome }, credit: 49_587 })
    expect(colas.filter((l) => l.credit > 0).reduce((sum, l) => sum + l.credit, 0)).toBe(60_000)
    const report = await svc.reports.run('revenue-codes', { from: TODAY, to: TODAY })
    expect(report.rows.find((r) => r.code === 'MINI')).toMatchObject({ department: 'Minibar' })
    expect(Number(report.rows.find((r) => r.code === 'MINI')?.amount)).toBeGreaterThanOrEqual(49_587)
  })

  it('signs a manual journal through the chain and posts it', async () => {
    await signIn('ida')
    const lines = [{ accountId: GL.receivable, debit: 2_000_000, credit: 0 }, { accountId: GL.roomRevenue, debit: 0, credit: 2_000_000 }]
    await expect(svc.accounting.createManualJournal({ date: TODAY, villaId: 'vil-saka', memo: 'Accrue an unpaid stay', lines: [lines[0]!, { ...lines[1]!, credit: 1_000_000 }], attachments: [] }, true)).rejects.toMatchObject({ code: 'JOURNAL_UNBALANCED' })
    const m = await svc.accounting.createManualJournal({ date: TODAY, villaId: 'vil-saka', memo: 'Accrue an unpaid stay', lines, attachments: [] }, true)
    expect(m.status).toBe('submitted')
    await expect(svc.accounting.transitionManualJournal(m.id, 'approved')).rejects.toMatchObject({ code: 'APPROVAL_SELF' })
    await signIn('kadek')
    await svc.accounting.transitionManualJournal(m.id, 'approved')
    await signIn('ida')
    const posted = await svc.accounting.transitionManualJournal(m.id, 'posted')
    expect(posted.journalId).not.toBeNull()
    expect((await svc.accounting.journal(posted.journalId ?? '')).href).toBe(`/accounting/manual/${m.id}`)
  })

  it('closes a month and refuses posting into it until it reopens', async () => {
    await signIn('ida')
    const periods = await svc.accounting.periods()
    expect(periods[0]?.month).toBe('2026-11')
    await expect(svc.accounting.closePeriod('2026-11', '')).rejects.toMatchObject({ code: 'PERIOD_NOT_ENDED' })
    const october = periods.find((p) => p.month === '2026-10')
    if (october?.pending) await expect(svc.accounting.closePeriod('2026-10', '')).rejects.toMatchObject({ code: 'PERIOD_PENDING' })
    await svc.accounting.closePeriod('2026-08', 'August books final')
    const m = await svc.accounting.createManualJournal({ date: '2026-08-31', villaId: null, memo: 'Late accrual', lines: [{ accountId: GL.receivable, debit: 100_000, credit: 0 }, { accountId: GL.otherIncome, debit: 0, credit: 100_000 }], attachments: [] }, true)
    await signIn('rama')
    await svc.accounting.transitionManualJournal(m.id, 'approved')
    await expect(svc.accounting.transitionManualJournal(m.id, 'posted')).rejects.toMatchObject({ code: 'PERIOD_CLOSED' })
    await svc.accounting.reopenPeriod('2026-08', 'Late accrual found')
    expect((await svc.accounting.transitionManualJournal(m.id, 'posted')).status).toBe('posted')
  })

  it('lists manual journals in the approval inbox for whoever signs the next level, and counts them as pending', async () => {
    await signIn('ida')
    const lines = [{ accountId: GL.receivable, debit: 300_000, credit: 0 }, { accountId: GL.otherIncome, debit: 0, credit: 300_000 }]
    const first = await svc.accounting.createManualJournal({ date: TODAY, villaId: 'vil-saka', memo: 'Accrue a late laundry bill', lines, attachments: [] }, true)
    const second = await svc.accounting.createManualJournal({ date: TODAY, villaId: 'vil-saka', memo: 'Accrue a minibar refill', lines, attachments: [] }, true)
    // The author waits for others and cannot sign their own journal.
    const own = await svc.finance.inbox()
    expect(own.journals.mine.map((j) => j.id)).not.toContain(first.id)
    expect(own.journals.others.map((j) => j.id)).toEqual(expect.arrayContaining([first.id, second.id]))
    expect((await svc.dashboard.attention()).journals).toHaveLength(0)

    await signIn('kadek')
    const inbox = await svc.finance.inbox()
    expect(inbox.journals.mine.map((j) => j.id)).toEqual([first.id, second.id])
    expect(inbox.journals.mine[0]?.progress.next).toBe('manager')
    const attention = await svc.dashboard.attention()
    expect(attention.journals.map((j) => j.id)).toEqual([first.id, second.id])

    expect((await svc.accounting.transitionManualJournal(first.id, 'approved', 'Bill seen')).status).toBe('approved')
    await expect(svc.accounting.transitionManualJournal(second.id, 'rejected', '')).rejects.toMatchObject({ errors: { note: expect.any(String) } })
    await svc.accounting.transitionManualJournal(second.id, 'rejected', 'No bill attached')
    const after = await svc.finance.inbox()
    expect(after.journals.mine.map((j) => j.id)).not.toContain(first.id)
    expect(after.journals.rejected.map((j) => [j.id, j.rejectionReason])).toEqual([[second.id, 'No bill attached']])
    expect((await svc.dashboard.attention()).journals).toHaveLength(0)

    // Approved, it waits for finance to post it from the same inbox.
    await signIn('rama')
    expect((await svc.finance.inbox()).journals.mine.map((j) => j.id)).toContain(first.id)
    expect((await svc.accounting.transitionManualJournal(first.id, 'posted')).status).toBe('posted')
  })

  it('pays the statutory payables of a closed payroll through the approval chain', async () => {
    await signIn('ida')
    const periods = (await svc.payroll.overview()).periods.map((r) => r.period)
    const latest = periods.find((p) => p.status === 'closed')
    const open = periods.find((p) => p.status !== 'closed')
    if (!latest || !open) throw new Error('seed has no closed and open payroll')
    await expect(svc.payroll.payStatutory(open.id, 'bank-bca')).rejects.toMatchObject({ code: 'PAYROLL_INVALID_STATE' })
    const due = (await svc.payroll.period(latest.id)).statutory
    const created = await svc.payroll.payStatutory(latest.id, 'bank-bca')
    expect(created.map((t) => [t.categoryId, t.amount, t.status])).toEqual(due.map((r) => [r.categoryId, r.amount, 'submitted']))
    await expect(svc.payroll.payStatutory(latest.id, 'bank-bca')).rejects.toMatchObject({ code: 'STATUTORY_PAID' })
    for (const t of created) await signAndPost(t.id, ['kadek', 'rama'])
    const tb = await svc.accounting.trialBalance({})
    expect(tb.rows.some((r) => r.account.id === GL.bpjsPayable || r.account.id === GL.pph21Payable)).toBe(false)
    expect(tb.debit).toBe(tb.credit)
  })

  it('bills a stay on its receivable at check-out and clears it with the guest money and the partner bill', async () => {
    await signIn('kadek')
    const options = await svc.orders.formOptions()
    const stay = options.stays.find((b) => b.source === 'direct' && options.menu.some((i) => i.villaId === b.place.villa.id && i.partnerId))
    const item = options.menu.find((i) => i.villaId === stay?.place.villa.id && i.partnerId)
    if (!stay || !item?.partnerId) throw new Error('no direct stay with a partner item in house')
    await svc.booking.setPrice(stay.id, { rateOverride: 5_000_000, discount: null, reason: 'Upgraded to the pool suite' })
    const order = await svc.orders.place({ bookingId: stay.id, lines: [{ itemId: item.id, quantity: 1 }], note: '', requestedOn: addDays(TODAY, 1), requestedAt: 12 * 60, priority: 'normal', discountPct: 0, discountReason: '', compReason: '' })
    for (const to of ['confirmed', 'preparing', 'delivered'] as const) await svc.orders.transition(order.id, to)
    const books = async () => (await svc.accounting.journals()).views
    const partnerOwed = async () => {
      const m = partyBalances(await books(), GL.partnerPayable, 'partnerId').get(item.partnerId ?? '')
      return (m?.credit ?? 0) - (m?.debit ?? 0)
    }
    const owedBefore = await partnerOwed()
    // Delivered, the order earns its revenue on the stay's receivable while the guest is still in house.
    const delivered = (await books()).find((e) => e.source === 'order' && e.sourceId === order.id)
    expect(delivered?.lines.find((l) => l.account.id === codeAccount(DEFAULT_TRANSACTION_CODES, MENU_CATEGORY_CODE[item.category]))).toMatchObject({ credit: item.price, code: MENU_CATEGORY_CODE[item.category] })
    expect(delivered?.lines.find((l) => l.account.id === GL.receivable)).toMatchObject({ debit: item.price, bookingId: stay.id })

    const details: CheckOutDetails = { depositReturned: 0, extraCharges: 120_000, roomInspected: true, keysReturned: true, notes: 'Minibar' }
    await svc.booking.settleAndCheckOut(stay.id, { details, method: 'cash', reference: '', attachments: [] })
    const billed = (await books()).find((e) => e.source === 'folio' && e.sourceId === stay.id)
    expect(billed?.href).toBe(`/bookings/${stay.id}/folio`)
    const ar = async () => {
      const m = partyBalances(await books(), GL.receivable, 'bookingId').get(stay.id)
      return (m?.debit ?? 0) - (m?.credit ?? 0)
    }
    expect(await ar()).toBeGreaterThan(0)

    const open = (await svc.finance.transactions()).list.filter((t) => t.bookingId === stay.id && t.status === 'submitted')
    for (const t of open) await signAndPost(t.id)
    expect(await ar()).toBe(0)
    const held = partyBalances(await books(), GL.deposits, 'bookingId').get(stay.id)
    expect((held?.credit ?? 0) - (held?.debit ?? 0)).toBe(0)
    expect(await partnerOwed()).toBeLessThan(owedBefore)
    const tb = await svc.accounting.trialBalance({})
    expect(tb.debit).toBe(tb.credit)
    const rows = (await svc.reports.run('stay-receivables', { to: TODAY })).rows
    expect(rows.find((r) => r.code === stay.code)).toMatchObject({ receivable: 0, held: 0 })
    expect((await svc.reports.run('partner-balances', { to: TODAY })).rows.length).toBeGreaterThan(0)
  })

  it('rebates an order line after payment and refunds it: the receivable ends at zero, revenue drops on its code, cash agrees', async () => {
    await signIn('kadek')
    const options = await svc.orders.formOptions()
    const stay = options.stays.find((b) => b.status === 'checked_in' && b.source === 'direct' && options.menu.some((i) => i.villaId === b.place.villa.id && i.name === 'Nasi goreng ayam'))
    const item = options.menu.find((i) => i.villaId === stay?.place.villa.id && i.name === 'Nasi goreng ayam')
    if (!stay || !item) throw new Error('no direct stay in house with nasi goreng')
    const books = async () => (await svc.accounting.journals()).views
    const ar = async () => {
      const m = partyBalances(await books(), GL.receivable, 'bookingId').get(stay.id)
      return (m?.debit ?? 0) - (m?.credit ?? 0)
    }
    const fnb = async () => (await svc.accounting.incomeStatement({})).revenue.find((l) => l.account.id === GL.fnb)?.amount ?? 0
    const [arBefore, fnbBefore] = [await ar(), await fnb()]

    const order = await svc.orders.place({ bookingId: stay.id, lines: [{ itemId: item.id, quantity: 2 }], note: '', requestedOn: addDays(TODAY, 1), requestedAt: 12 * 60, priority: 'normal', discountPct: 0, discountReason: '', compReason: '' })
    for (const to of ['confirmed', 'preparing', 'delivered'] as const) await svc.orders.transition(order.id, to)
    const { payment } = await svc.orders.pay({ bookingId: stay.id, orderIds: [order.id], method: 'cash', reference: '' })
    if (!payment) throw new Error('no payment')
    // Half the food back, past the 10% limit, which a villa manager may give. The menu price includes
    // service and PB1, so the line shows net and the rebate takes its share of both back with it.
    const line = (await svc.booking.folio(stay.id)).folio.lines.find((l) => l.id === `${order.id}-FNB`)
    const half = Math.round((line?.debit ?? 0) / 2)
    const rebate = await svc.booking.postRebate(stay.id, { lineId: `${order.id}-FNB`, amount: half, reason: 'Cold on arrival' })
    expect(rebate).toMatchObject({ kind: 'rebate', code: 'FNB', part: 'orders', orderId: order.id, approvedBy: 'Kadek Ariani' })
    const back = postingGross(rebate)
    expect(Math.abs(back - item.price)).toBeLessThanOrEqual(1)
    const folio = await svc.booking.folio(stay.id)
    expect(folio.folio.refundDue).toBe(back)
    expect(folio.refunds.map((r) => [r.payment.id, r.refundable])).toEqual([[payment.id, back]])

    await expect(svc.booking.refund(stay.id, { paymentId: payment.id, amount: back, reason: 'Cold food' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await signIn('ida')
    await expect(svc.booking.refund(stay.id, { paymentId: payment.id, amount: back + 1_000, reason: 'Cold food' })).rejects.toMatchObject({ code: 'REFUND_EXCEEDS_CREDIT' })
    const refund = await svc.booking.refund(stay.id, { paymentId: payment.id, amount: back, reason: 'Cold food' })
    expect(refund).toMatchObject({ kind: 'refund', refundOf: payment.id, orderIds: [order.id] })
    expect((await svc.booking.folio(stay.id)).folio.refundDue).toBe(0)

    for (const t of (await svc.finance.transactions()).list.filter((x) => x.bookingId === stay.id && x.status === 'submitted')) await signAndPost(t.id)
    expect(await ar()).toBe(arBefore)
    expect(await fnb()).toBe(fnbBefore + (line?.debit ?? 0) - half)
    const tb = await svc.accounting.trialBalance({})
    expect(tb.debit).toBe(tb.credit)
    const transactions = await ports.finance.transactions()
    for (const a of await ports.finance.accounts()) {
      const row = tb.rows.find((r) => r.account.id === cashGlId(a.id))
      expect((row?.debit ?? 0) - (row?.credit ?? 0), a.name).toBe(balance(a, transactions))
    }
  })

  it('voids a delivery on its business day and refuses one from a closed day', async () => {
    await signIn('kadek')
    const options = await svc.orders.formOptions()
    const stay = options.stays.find((b) => b.status === 'checked_in' && b.checkOut > addDays(TODAY, 1) && options.menu.some((i) => i.villaId === b.place.villa.id && i.partnerId))
    const item = options.menu.find((i) => i.villaId === stay?.place.villa.id && i.partnerId)
    if (!stay || !item) throw new Error('no stay with a partner item')
    const order = await svc.orders.place({ bookingId: stay.id, lines: [{ itemId: item.id, quantity: 1 }], note: '', requestedOn: addDays(TODAY, 1), requestedAt: 12 * 60, priority: 'normal', discountPct: 0, discountReason: '', compReason: '' })
    for (const to of ['confirmed', 'preparing', 'delivered'] as const) await svc.orders.transition(order.id, to)
    await expect(svc.orders.transition(order.id, 'voided', '')).rejects.toMatchObject({ errors: { note: expect.any(String) } })
    const voided = await svc.orders.transition(order.id, 'voided', 'Delivered to the wrong room')
    expect(voided.status).toBe('voided')
    expect((await svc.booking.folio(stay.id)).folio.lines.some((l) => l.orderId === order.id)).toBe(false)
    await signIn('ida')
    const entries = (await svc.accounting.journals()).views.filter((e) => e.source === 'order' && e.sourceId === order.id)
    expect(entries).toHaveLength(2)
    const net = (id: string) => entries.flatMap((e) => e.lines).filter((l) => l.account.id === id).reduce((sum, l) => sum + l.debit - l.credit, 0)
    for (const id of [GL.receivable, GL.partnerPayable, GL.partnerCost, codeAccount(DEFAULT_TRANSACTION_CODES, MENU_CATEGORY_CODE[item.category])]) expect(net(id)).toBe(0)
    const bills = (await svc.finance.transactions()).list.filter((t) => voided.costTransactionIds.includes(t.id))
    expect(bills.every((t) => t.status === 'rejected')).toBe(true)
    await signIn('kadek')
    const old = (await svc.orders.board()).list.find((o) => o.status === 'delivered' && o.deliveredOn !== null && o.deliveredOn < TODAY)
    if (!old) throw new Error('seed has no older delivery')
    await expect(svc.orders.transition(old.id, 'voided', 'Too late')).rejects.toMatchObject({ code: 'VOID_DAY_CLOSED' })
  })

  /** The villa's balance on Payable to villa owners, credit side positive. */
  async function ownerPayable(villaId: string) {
    const row = (await svc.accounting.trialBalance({ villaId })).rows.find((r) => r.account.id === GL.ownerPayable)
    return (row?.credit ?? 0) - (row?.debit ?? 0)
  }
  async function seeded(contractId: string, month: string) {
    const st = (await svc.owners.statements(month)).rows.find((r) => r.contract.id === contractId)?.statement
    if (!st) throw new Error(`no ${month} statement for ${contractId}`)
    return st
  }

  it('moves the owner share out on close and clears the payable to owners once the payout posts', async () => {
    await signIn('ida')
    const st = await seeded('ct-karang', '2026-10')
    const f = st.figures
    const close = (await svc.accounting.journals()).views.find((e) => e.source === 'owner' && e.sourceId === st.id)
    expect(close?.date).toBe('2026-10-31')
    expect(close?.villaId).toBe('vil-karang')
    expect(close?.lines.map((l) => [l.account.id, l.debit, l.credit])).toEqual(ownerCloseJournal(st).lines.map((l) => [l.accountId, l.debit, l.credit]))
    expect(close?.lines.find((l) => l.account.id === GL.ownerShare)?.debit).toBe(f.gop)
    expect(close?.lines.find((l) => l.account.id === GL.managementFee)?.credit).toBe(f.managementFee)
    expect(close?.lines.find((l) => l.account.id === GL.ownerPayable)?.credit).toBe(f.netPayable)
    expect(await ownerPayable('vil-karang')).toBe(st.payable)
    await signAndPost(st.payoutTransactionId ?? '', ['kadek', 'rama'])

    expect(await ownerPayable('vil-karang')).toBe(0)
    const tb = await svc.accounting.trialBalance({})
    expect(tb.debit).toBe(tb.credit)
    // The operator keeps the fee and the owner stay charge out of the villa's result.
    const is = await svc.accounting.incomeStatement({ from: '2026-10-01', to: '2026-10-31', villaId: 'vil-karang' })
    expect(is.revenue.find((l) => l.account.id === GL.managementFee)?.amount).toBe(f.managementFee)
    expect(is.expenses.find((l) => l.account.id === GL.ownerShare)?.amount).toBe(f.gop)
  })

  it('reopens an unpaid statement by reversing its close entry on the same month end', async () => {
    await signIn('ida')
    const st = await seeded('ct-pandawa', '2026-10')
    expect(st.payable).toBeLessThan(0)
    expect(await ownerPayable('vil-pandawa')).toBe(st.payable)
    await svc.owners.reopen(st.id, 'Utility bill booked to the wrong villa')
    const views = (await svc.accounting.journals()).views.filter((e) => e.source === 'owner' && e.sourceId === st.id)
    expect(views).toHaveLength(2)
    const [close, reversal] = views.sort((a, b) => a.number.localeCompare(b.number))
    expect(reversal?.date).toBe('2026-10-31')
    expect(reversal?.memo).toContain('Utility bill booked to the wrong villa')
    expect(reversal?.lines.map((l) => [l.account.id, l.credit, l.debit])).toEqual(close?.lines.map((l) => [l.account.id, l.debit, l.credit]))
    expect(await ownerPayable('vil-pandawa')).toBe(0)
    expect((await svc.owners.statement('ct-pandawa', '2026-10')).statement).toBeNull()
    const tb = await svc.accounting.trialBalance({})
    expect(tb.debit).toBe(tb.credit)
  })

  it('has the owner top up a shortfall: the receivable from villa owners carries it until the cash comes in', async () => {
    await signIn('ida')
    const st = await seeded('ct-pandawa', '2026-10')
    const c = (await svc.owners.overview()).contracts.find((x) => x.id === 'ct-pandawa')
    if (!c) throw new Error('no Pandawa contract')
    await svc.owners.saveContract(c.id, { villaId: c.villaId, ownerId: c.ownerId, start: c.start, end: c.end, feeBasis: c.feeBasis, feePct: c.feePct, fixedMonthlyFee: c.fixedMonthlyFee, charged: c.charged, maintenanceThreshold: c.maintenanceThreshold, ownerNightsPerYear: c.ownerNightsPerYear, ownerStayPricing: c.ownerStayPricing, ownerStayPrice: c.ownerStayPrice, reservePct: c.reservePct, payoutDay: c.payoutDay, shortfall: 'topup', document: c.document })
    await svc.owners.reopen(st.id, 'Owner tops up instead')
    const again = await svc.owners.close('ct-pandawa', '2026-10', '')
    expect(again).toMatchObject({ payable: st.payable, shortfall: 'topup' })
    const close = (await svc.accounting.journals()).views.find((e) => e.source === 'owner' && e.sourceId === again.id)
    expect(close?.lines.find((l) => l.account.id === GL.ownerReceivable)?.debit).toBe(-st.payable)
    expect(await ownerPayable('vil-pandawa')).toBe(0)
    await signIn('rama')
    await svc.owners.approve(again.id, '')
    await signIn('ida')
    const asked = await svc.owners.pay(again.id, 'bank-bca')
    const topUp = (await svc.finance.transactions()).list.find((t) => t.id === asked.payoutTransactionId)
    expect(topUp).toMatchObject({ kind: 'cash_in', categoryId: 'cat-owner-topup', amount: -st.payable, status: 'submitted' })
    expect((await svc.owners.statements('2026-10')).rows.find((r) => r.contract.id === 'ct-pandawa')?.statement?.label).toBe('Top-up due')
    await signAndPost(topUp?.id ?? '', ['rama'])
    const tb = await svc.accounting.trialBalance({})
    expect(tb.debit).toBe(tb.credit)
    const receivable = tb.rows.find((r) => r.account.id === GL.ownerReceivable)
    expect((receivable?.debit ?? 0) - (receivable?.credit ?? 0)).toBe(0)
    expect(await ownerPayable('vil-pandawa')).toBe(0)
  })

  it('serves the statements as reports', async () => {
    const tb = await svc.reports.run('trial-balance', { to: TODAY })
    const sum = (key: string) => tb.rows.reduce((s, r) => s + Number(r[key] ?? 0), 0)
    expect(sum('debit')).toBe(sum('credit'))
    const bs = await svc.reports.run('balance-sheet', { to: TODAY })
    expect(bs.rows.reduce((s, r) => s + Number(r.assets), 0)).toBe(bs.rows.reduce((s, r) => s + Number(r.claims), 0))
    const is = await svc.reports.run('income-statement', { from: '2026-10-01', to: '2026-10-31' })
    expect(is.rows.length).toBeGreaterThan(0)
    expect((await svc.reports.run('general-journal', { from: '2026-10-01', to: '2026-10-31' })).rows.length).toBeGreaterThan(0)
  })
})
