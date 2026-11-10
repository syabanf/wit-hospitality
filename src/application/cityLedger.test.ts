import { beforeEach, describe, expect, it } from 'vitest'
import type { CheckOutDetails } from '@/domain/booking'
import { GL } from '@/domain/journal'
import { fixedClock } from '@/infrastructure/clock'
import { createMockPorts } from '@/infrastructure/mock'
import { addDays } from '@/lib/dates'
import type { Ports } from './ports'
import { createServices, type Services } from './services'

const TODAY = '2026-11-06'
let s: Services
let ports: Ports
const signIn = (who: string) => s.access.login({ email: `${who}@balivillas.id`, password: 'villa123' })
const details: CheckOutDetails = { depositReturned: 0, extraCharges: 0, roomInspected: true, keysReturned: true, notes: '' }

beforeEach(async () => {
  ports = createMockPorts(fixedClock(TODAY), 0, null)
  s = createServices(ports)
  await signIn('kadek')
})

/** A direct stay in house of its own, repriced so the room has a balance to move. */
async function owingStay() {
  const stay = (await ports.booking.bookings()).find((b) => b.status === 'checked_in' && b.source === 'direct' && !b.bookingGroupId)
  if (!stay) throw new Error('seed has no direct stay in house')
  await s.booking.setPrice(stay.id, { rateOverride: 6_000_000, discount: null, reason: 'Corporate suite' })
  return stay
}

/** A direct week in KR-01 two months out, billed to no one. */
const futureStay = () => ({ guestId: 'g-11', newGuest: null, unitId: 'unit-kr-01', groupId: null, source: 'direct' as const, airbnbAccountId: null, airbnbCode: null, checkIn: addDays(TODAY, 60), checkOut: addDays(TODAY, 67), channelRate: null, price: null, notes: '', confirm: true })

/** Signs every level with the signers in turn, then posts as finance. */
async function signAndPost(id: string) {
  for (const who of ['kadek', 'rama']) {
    await signIn(who)
    const t = (await s.finance.transactions()).list.find((x) => x.id === id)
    if (t?.status === 'submitted') await s.finance.transition(id, 'approved').catch(() => undefined)
  }
  await signIn('ida')
  const t = (await s.finance.transactions()).list.find((x) => x.id === id)
  if (t?.status === 'submitted') await s.finance.transition(id, 'approved')
  await s.finance.transition(id, 'posted')
}

/** City ledger receivable in the books against the balances on the accounts. */
async function tie() {
  const tb = await s.accounting.trialBalance({})
  const row = tb.rows.find((r) => r.account.id === GL.cityLedger)
  const { balance } = await s.cityLedger.overview()
  expect((row?.debit ?? 0) - (row?.credit ?? 0)).toBe(balance)
  expect(tb.debit).toBe(tb.credit)
}

describe('city ledger', () => {
  it('seeds four accounts with invoices paid, partly paid and overdue, and one near its limit', async () => {
    await signIn('ida')
    const { rows } = await s.cityLedger.overview()
    expect(rows.map((r) => r.kind).sort()).toEqual(['company', 'company', 'travel_agent', 'travel_agent'])
    expect(rows.find((r) => r.commissionPct === 15)).toBeDefined()
    expect(rows.find((r) => r.commissionPct === 10)?.usedPct).toBeGreaterThan(0.85)
    const invoices = (await Promise.all(rows.map((r) => s.cityLedger.account(r.id)))).flatMap((a) => a.invoices)
    expect(invoices.some((i) => i.state === 'paid')).toBe(true)
    expect(invoices.some((i) => i.state === 'partly_paid')).toBe(true)
    expect(invoices.some((i) => i.state === 'overdue' && i.daysOverdue > 45)).toBe(true)
    expect((await s.dashboard.attention()).overdueInvoices.length).toBeGreaterThan(0)
    await tie()
  })

  it('transfers the room at check-out, settles the rest with the guest, and moves the bill from 1200 to 1210', async () => {
    const stay = await owingStay()
    const before = await s.booking.settlement(stay.id)
    expect(before.roomDue).toBeGreaterThan(0)
    const options = await s.cityLedger.transferOptions(stay.id)
    expect(options.allowed).toBe(true)
    expect(options.preview.room).toBe(before.roomDue)
    const posted = await s.cityLedger.transfer(stay.id, { accountId: 'cl-nusa', instruction: 'room' })
    expect(posted.reduce((sum, p) => sum + p.amount, 0)).toBe(before.roomDue)
    const after = await s.booking.settlement(stay.id)
    expect(after.roomDue).toBe(0)
    const { folio } = await s.booking.folio(stay.id)
    expect(folio.lines.some((l) => l.kind === 'transfer' && l.credit === before.roomDue)).toBe(true)
    await expect(s.cityLedger.transfer(stay.id, { accountId: 'cl-nusa', instruction: 'room' })).rejects.toMatchObject({ code: 'CITY_LEDGER_NOTHING' })
    if (after.owed > 0) await s.booking.settleAndCheckOut(stay.id, { details, method: 'cash', reference: '', attachments: [] })
    else await s.booking.checkOut(stay.id, details)
    const journals = await ports.ledger.journals()
    const entry = journals.find((e) => e.source === 'city_ledger' && e.sourceNumber === stay.code)
    expect(entry?.lines).toEqual([
      { accountId: GL.cityLedger, debit: before.roomDue, credit: 0 },
      { accountId: GL.receivable, debit: 0, credit: before.roomDue, bookingId: stay.id },
    ])
    await signIn('ida')
    expect((await s.cityLedger.account('cl-nusa')).uninvoiced.some((u) => u.bookingId === stay.id)).toBe(true)
    await tie()
  })

  it('issues an agent invoice with its commission off the net, books the commission, and emails it through the outbox', async () => {
    await signIn('ida')
    const before = await s.cityLedger.account('cl-jaya')
    const open = before.uninvoiced.reduce((sum, u) => sum + u.amount, 0)
    expect(open).toBeGreaterThan(0)
    const inv = await s.cityLedger.issueInvoice('cl-jaya', TODAY)
    expect(inv.number).toMatch(/^CL-2026-11-\d{3}$/)
    expect(inv.gross).toBe(open)
    expect(inv.commission).toBe(Math.round((inv.gross - inv.service - inv.pb1) * 0.1))
    expect(inv.net).toBe(inv.gross - inv.commission)
    expect(inv.dueOn).toBe(addDays(TODAY, 21))
    const entry = (await ports.ledger.journals()).find((e) => e.id === inv.journalId)
    expect(entry?.lines).toEqual([
      { accountId: GL.agentCommission, debit: inv.commission, credit: 0 },
      { accountId: GL.cityLedger, debit: 0, credit: inv.commission },
    ])
    await expect(s.cityLedger.issueInvoice('cl-jaya', TODAY)).rejects.toMatchObject({ code: 'CITY_LEDGER_NOTHING' })
    const sent = await s.cityLedger.sendInvoice(inv.id)
    const message = (await ports.messaging.messages()).find((m) => m.id === sent.messageId)
    expect(message).toMatchObject({ templateKey: 'city_ledger_invoice', to: 'billing@jayawisata.example', cityLedger: { accountId: 'cl-jaya', invoiceId: inv.id } })
    expect(message?.body).toContain(inv.number)
    await tie()
  })

  it('spreads a payment over the invoices, keeps the rest as credit, and counts it once the cash-in posts', async () => {
    await signIn('ida')
    const before = await s.cityLedger.account('cl-southern')
    const invoice = before.invoices.find((i) => i.state === 'partly_paid')
    if (!invoice) throw new Error('seed has no partly paid invoice')
    await expect(s.cityLedger.recordPayment({ accountId: 'cl-southern', method: 'bank_transfer', cashAccountId: 'bank-bca', amount: invoice.open + 10_000_000, reference: 'TRF-1', note: '', allocations: [{ invoiceId: invoice.id, amount: invoice.open + 1 }] })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    const p = await s.cityLedger.recordPayment({ accountId: 'cl-southern', method: 'bank_transfer', cashAccountId: 'bank-bca', amount: invoice.open + 2_000_000, reference: 'TRF-SCIH-NOV', note: '', allocations: null })
    expect(p.allocations).toEqual([{ invoiceId: invoice.id, amount: invoice.open }])
    let now = await s.cityLedger.account('cl-southern')
    expect(now.account.balance).toBe(before.account.balance)
    expect(now.invoices.find((i) => i.id === invoice.id)?.pending).toBe(invoice.open)
    await signAndPost(p.transactionId)
    await signIn('ida')
    now = await s.cityLedger.account('cl-southern')
    expect(now.account.balance).toBe(before.account.balance - p.amount)
    expect(now.account.credit).toBe(2_000_000)
    expect(now.invoices.find((i) => i.id === invoice.id)?.state).toBe('paid')
    await tie()
  })

  it('refuses a booking past the credit limit unless a manager overrides with a reason', async () => {
    await signIn('dian')
    const input = futureStay()
    await expect(s.booking.create({ ...input, cityLedger: { accountId: 'cl-jaya', instruction: 'room' } })).rejects.toMatchObject({ code: 'CREDIT_LIMIT' })
    await signIn('kadek')
    await expect(s.booking.create({ ...input, cityLedger: { accountId: 'cl-jaya', instruction: 'room' } })).rejects.toMatchObject({ code: 'CREDIT_LIMIT' })
    const b = await s.booking.create({ ...input, cityLedger: { accountId: 'cl-jaya', instruction: 'room', overrideReason: 'Director signed the extension' } })
    expect(b.cityLedger).toMatchObject({ accountId: 'cl-jaya', instruction: 'room', override: { by: 'Kadek Ariani', reason: 'Director signed the extension' } })
    const nusa = await s.booking.create({ ...input, unitId: 'unit-kr-02', cityLedger: { accountId: 'cl-nusa', instruction: 'all' } })
    expect(nusa.cityLedger?.override).toBeNull()
  })

  it('sets, changes and removes who pays a booking, with the audit trail, and leaves posted transfers alone', async () => {
    const b = await s.booking.create(futureStay())
    expect((await s.cityLedger.billing({ bookingId: b.id })).current).toBeNull()
    await s.cityLedger.setBilling({ bookingId: b.id }, { accountId: 'cl-nusa', instruction: 'room' })
    let view = await s.cityLedger.billing({ bookingId: b.id })
    expect(view.current).toMatchObject({ accountId: 'cl-nusa', code: 'CL-001', instruction: 'room', override: null })
    await s.cityLedger.setBilling({ bookingId: b.id }, { accountId: 'cl-southern', instruction: 'room_breakfast' })
    expect((await ports.booking.bookings()).find((x) => x.id === b.id)?.cityLedger).toMatchObject({ accountId: 'cl-southern', instruction: 'room_breakfast' })
    const trail = (await ports.access.audit()).find((e) => e.entity === 'booking' && e.entityId === b.code && e.after?.account === 'CL-003')
    expect(trail).toMatchObject({ before: { account: 'CL-001', instruction: 'room' }, after: { account: 'CL-003', instruction: 'room_breakfast' } })
    expect(await s.cityLedger.setBilling({ bookingId: b.id }, null)).toBeNull()
    view = await s.cityLedger.billing({ bookingId: b.id })
    expect(view.current).toBeNull()
    expect((await ports.access.audit()).find((e) => e.entityId === b.code && e.before?.account === 'CL-003')?.after).toEqual({ account: null })

    // A stay in house moves its room to the account, then goes back to the guest: the transfer stays posted.
    const stay = await owingStay()
    await s.cityLedger.setBilling({ bookingId: stay.id }, { accountId: 'cl-nusa', instruction: 'room' })
    const posted = await s.cityLedger.transfer(stay.id, { accountId: 'cl-nusa', instruction: 'room' })
    await s.cityLedger.setBilling({ bookingId: stay.id }, null)
    expect((await ports.cityLedger.transfers()).filter((p) => p.bookingId === stay.id).map((p) => p.id)).toEqual(posted.map((p) => p.id))
    await tie()
  })

  it('refuses billing an Airbnb stay, a stay checked out, and a group whose stays all left', async () => {
    const bookings = await ports.booking.bookings()
    const airbnb = bookings.find((b) => b.source === 'airbnb' && (b.status === 'confirmed' || b.status === 'checked_in'))
    const gone = bookings.find((b) => b.source === 'direct' && b.status === 'checked_out')
    if (!airbnb || !gone) throw new Error('seed has no live Airbnb stay or no direct stay checked out')
    await expect(s.cityLedger.setBilling({ bookingId: airbnb.id }, { accountId: 'cl-nusa', instruction: 'all' })).rejects.toMatchObject({ code: 'CITY_LEDGER_CHANNEL' })
    expect((await s.cityLedger.billing({ bookingId: airbnb.id })).allowed).toBe(false)
    await expect(s.cityLedger.setBilling({ bookingId: gone.id }, { accountId: 'cl-nusa', instruction: 'all' })).rejects.toMatchObject({ code: 'BOOKING_INVALID_STATE' })
    await expect(s.cityLedger.setBilling({ bookingId: gone.id }, null)).rejects.toMatchObject({ code: 'BOOKING_INVALID_STATE' })
    const groups = await ports.groups.groups()
    const left = groups.find((g) => bookings.filter((b) => b.bookingGroupId === g.id).every((b) => b.status === 'checked_out' || b.status === 'cancelled'))
    if (left) await expect(s.cityLedger.setBilling({ groupId: left.id }, { accountId: 'cl-nusa', instruction: 'all' })).rejects.toMatchObject({ code: 'BOOKING_INVALID_STATE' })
  })

  it('holds a later billing to the credit limit, lets a manager override with a reason, and keeps the override on the same account', async () => {
    const b = await s.booking.create(futureStay())
    await signIn('dian')
    expect((await s.cityLedger.billing({ bookingId: b.id })).mayOverride).toBe(false)
    await expect(s.cityLedger.setBilling({ bookingId: b.id }, { accountId: 'cl-jaya', instruction: 'room' })).rejects.toMatchObject({ code: 'CREDIT_LIMIT' })
    await signIn('kadek')
    await expect(s.cityLedger.setBilling({ bookingId: b.id }, { accountId: 'cl-jaya', instruction: 'room' })).rejects.toMatchObject({ code: 'CREDIT_LIMIT' })
    const billed = await s.cityLedger.setBilling({ bookingId: b.id }, { accountId: 'cl-jaya', instruction: 'room', overrideReason: 'Director signed the extension' })
    expect(billed).toMatchObject({ accountId: 'cl-jaya', override: { by: 'Kadek Ariani', reason: 'Director signed the extension' } })
    // The stay already counts against the account: changing what it pays keeps the override.
    await signIn('dian')
    expect(await s.cityLedger.setBilling({ bookingId: b.id }, { accountId: 'cl-jaya', instruction: 'all' })).toMatchObject({ instruction: 'all', override: { reason: 'Director signed the extension' } })
    expect((await s.cityLedger.billing({ bookingId: b.id })).accounts.find((a) => a.id === 'cl-jaya')?.available).toBeGreaterThan(0)
  })

  it('sets who pays a group and covers only the stays not billed on their own', async () => {
    const bookings = await ports.booking.bookings()
    const group = (await ports.groups.groups()).find((g) => bookings.some((b) => b.bookingGroupId === g.id && (b.status === 'confirmed' || b.status === 'checked_in')))
    if (!group) throw new Error('seed has no live group')
    const billed = await s.cityLedger.setBilling({ groupId: group.id }, { accountId: 'cl-nusa', instruction: 'room' })
    expect(billed).toMatchObject({ accountId: 'cl-nusa', instruction: 'room' })
    const view = await s.cityLedger.billing({ groupId: group.id })
    expect(view.current?.code).toBe('CL-001')
    expect(view.amount).toBeGreaterThan(0)
    const stay = bookings.find((b) => b.bookingGroupId === group.id)
    if (stay) expect((await s.cityLedger.billing({ bookingId: stay.id })).fromGroup?.code).toBe('CL-001')
    expect((await ports.access.audit()).some((e) => e.entity === 'booking-group' && e.entityId === group.code && e.after?.account === 'CL-001')).toBe(true)
    await s.cityLedger.setBilling({ groupId: group.id }, null)
    expect((await ports.groups.groups()).find((g) => g.id === group.id)?.cityLedger).toBeUndefined()
  })

  it('writes off a small balance through a manual journal and refuses a large one', async () => {
    await signIn('ida')
    const { invoices } = await s.cityLedger.account('cl-consulate')
    const overdue = invoices.find((i) => i.state === 'overdue')
    if (!overdue) throw new Error('seed has no overdue invoice')
    await expect(s.cityLedger.writeOff({ accountId: 'cl-consulate', invoiceId: overdue.id, amount: 600_000, reason: 'Bank charges on the transfer' })).rejects.toMatchObject({ code: 'WRITE_OFF_LIMIT' })
    const w = await s.cityLedger.writeOff({ accountId: 'cl-consulate', invoiceId: overdue.id, amount: 150_000, reason: 'Bank charges on the transfer' })
    const before = (await s.cityLedger.account('cl-consulate')).account.balance
    await signIn('kadek')
    await s.accounting.transitionManualJournal(w.manualJournalId, 'approved')
    await signIn('rama')
    const m = await s.accounting.manualJournal(w.manualJournalId)
    if (m.status === 'submitted') await s.accounting.transitionManualJournal(w.manualJournalId, 'approved')
    await s.accounting.transitionManualJournal(w.manualJournalId, 'posted')
    await signIn('ida')
    const after = await s.cityLedger.account('cl-consulate')
    expect(after.account.balance).toBe(before - 150_000)
    expect(after.invoices.find((i) => i.id === overdue.id)?.writtenOff).toBe(150_000)
    await tie()
  })
})
