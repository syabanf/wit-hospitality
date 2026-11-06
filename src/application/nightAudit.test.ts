import { beforeEach, describe, expect, it } from 'vitest'
import type { CheckInDetails, CheckOutDetails } from '@/domain/booking'
import { balance } from '@/domain/finance'
import { cashGlId, GL, partyBalances } from '@/domain/journal'
import { emptyChecks } from '@/domain/nightAudit'
import { createMockPorts } from '@/infrastructure/mock'
import { addDays } from '@/lib/dates'
import type { Ports } from './ports'
import { createServices, type Services } from './services'

const TODAY = '2026-11-06'
const arrival: CheckInDetails = { idVerified: true, deposit: 0, keysHanded: true, rulesExplained: true, arrivalTime: '14:00', adults: 2, children: 0, notes: '' }
const departure: CheckOutDetails = { depositReturned: 0, extraCharges: 0, roomInspected: true, keysReturned: true, notes: '' }

let s: Services
let ports: Ports
/** A calendar the test moves forward, the way days pass at the desk. */
const clock = { date: TODAY, today() { return this.date } }
const signIn = (who: string) => s.access.login({ email: `${who}@balivillas.id`, password: 'villa123' })

beforeEach(async () => {
  clock.date = TODAY
  ports = createMockPorts(clock, 0)
  s = createServices(ports)
  await signIn('kadek')
})

/** Signs and posts every cash entry still waiting, as the approval chain and finance would, then signs back in at the desk. */
async function postOpen() {
  for (const who of ['rama', 'ida']) {
    await signIn(who)
    for (const t of (await s.finance.transactions()).list.filter((x) => x.status === 'submitted')) await s.finance.transition(t.id, 'approved').catch(() => undefined)
  }
  for (const t of (await s.finance.transactions()).list.filter((x) => x.status === 'approved')) await s.finance.transition(t.id, 'posted')
  await signIn('kadek')
}

/**
 * A direct stay from today on TR-01, booked through the console with a cash deposit. The seed fills
 * every room tonight, so the guest arriving on TR-01 today cancels first.
 */
async function bookStay(nights: number) {
  const { list } = await s.booking.list()
  const room = list.find((b) => b.unitCode === 'TR-01' && b.status === 'confirmed' && b.checkIn === TODAY)
  if (room) await s.booking.transition(room.id, 'cancelled')
  const unit = (await s.booking.formOptions()).catalog.unitByCode('TR-01')
  return s.booking.create({ guestId: 'g-11', newGuest: null, unitId: unit.id, groupId: null, source: 'direct', airbnbAccountId: null, airbnbCode: null, checkIn: TODAY, checkOut: addDays(TODAY, nights), channelRate: null, price: null, notes: '', confirm: true, payment: { kind: 'deposit', method: 'cash', amount: 1_000_000, reference: '' } })
}

async function books() {
  await signIn('ida')
  const views = (await s.accounting.journals()).views
  await signIn('kadek')
  return views
}
const net = (views: Awaited<ReturnType<typeof books>>, accountId: string, bookingId: string) => {
  const m = partyBalances(views, accountId, 'bookingId').get(bookingId)
  return (m?.debit ?? 0) - (m?.credit ?? 0)
}

describe('night audit', () => {
  it('posts exactly one ROOM line per stay in house, marks a no-show, rolls the business date and refuses a rerun', async () => {
    const stay = await bookStay(3)
    await postOpen()
    await s.booking.checkIn(stay.id, arrival)
    const before = await s.nightAudit.overview()
    expect(before.businessDate).toBe(TODAY)
    expect(before.audits).toHaveLength(30)
    const arrivals = before.checks.find((c) => c.key === 'arrivals')?.items ?? []
    expect(arrivals.length).toBeGreaterThan(0)
    const tonight = before.tonight.map((t) => t.booking.id)
    expect(tonight).toContain(stay.id)
    // The deposit sits on Guest deposits until the room is first billed.
    expect(net(await books(), GL.deposits, stay.id)).toBe(-1_000_000)

    const audit = await s.nightAudit.run()
    expect(audit.stays.map((x) => x.bookingId).sort()).toEqual([...tonight].sort())
    expect(audit.stays.every((x) => x.nights === 1)).toBe(true)
    expect(audit.noShows).toHaveLength(arrivals.length)
    for (const id of tonight) {
      const { folio } = await s.booking.folio(id)
      expect(folio.lines.filter((l) => l.kind === 'room' && !l.forecast && l.date === TODAY && l.code === 'ROOM' && l.postedBy === 'Night audit'), id).toHaveLength(1)
    }
    const noShow = (await s.booking.list()).list.find((b) => b.code === audit.noShows[0])
    expect(noShow?.status).toBe('no_show')

    // The night books on the receivable and moves the deposit over.
    const views = await books()
    const night = views.find((e) => e.source === 'audit' && e.sourceId === stay.id)
    expect(night?.lines.find((l) => l.account.id === GL.roomRevenue)).toMatchObject({ credit: audit.stays.find((x) => x.bookingId === stay.id)?.amount, code: 'ROOM' })
    expect(net(views, GL.deposits, stay.id)).toBe(0)

    expect(await s.nightAudit.businessDate()).toBe(addDays(TODAY, 1))
    await expect(s.nightAudit.run()).rejects.toMatchObject({ code: 'AUDIT_TOO_EARLY' })
    await expect(ports.audit.run({ date: TODAY, checks: emptyChecks(), noShows: [] })).rejects.toMatchObject({ code: 'AUDIT_ALREADY_RUN' })
    await signIn('wayan')
    await expect(s.nightAudit.run()).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('keeps the books balanced over several audits and settles the receivable at check-out', async () => {
    const stay = await bookStay(4)
    await postOpen()
    await s.booking.checkIn(stay.id, arrival)
    for (let i = 0; i < 3; i++) {
      clock.date = addDays(TODAY, i)
      await s.nightAudit.run()
      await signIn('ida')
      const tb = await s.accounting.trialBalance({})
      expect(tb.debit, clock.date).toBe(tb.credit)
      expect((await s.accounting.balanceSheet({})).balanced, clock.date).toBe(true)
      await signIn('kadek')
    }
    const { folio } = await s.booking.folio(stay.id)
    expect(folio.lines.filter((l) => l.kind === 'room').map((l) => l.forecast)).toEqual([false, false, false, true])
    expect(folio.estimated).toBe(folio.balance + folio.forecast)
    const due = await s.booking.settlement(stay.id)
    expect(due.roomDue).toBe(stay.total - 1_000_000)
    // The deposit moved onto the receivable at the first audit: the receivable is the folio's posted balance.
    expect(net(await books(), GL.receivable, stay.id)).toBe(folio.balance)

    // Leaving after the third audit: check-out posts the night no audit reached and takes the rest.
    await s.booking.settleAndCheckOut(stay.id, { details: departure, method: 'cash', reference: '', attachments: [] })
    await postOpen()
    const views = await books()
    expect(net(views, GL.receivable, stay.id)).toBe(0)
    expect(net(views, GL.deposits, stay.id)).toBe(0)
    const room = views.filter((e) => (e.source === 'audit' || e.source === 'folio') && e.sourceId === stay.id).flatMap((e) => e.lines).filter((l) => l.account.id === GL.roomRevenue).reduce((sum, l) => sum + l.credit - l.debit, 0)
    expect(room).toBe(stay.total)
    expect(views.filter((e) => e.source === 'audit' && e.sourceId === stay.id)).toHaveLength(3)
    // Cash and its GL account still agree.
    await signIn('ida')
    const tb = await s.accounting.trialBalance({})
    const transactions = await ports.finance.transactions()
    for (const a of await ports.finance.accounts()) {
      const row = tb.rows.find((r) => r.account.id === cashGlId(a.id))
      expect((row?.debit ?? 0) - (row?.credit ?? 0), a.name).toBe(balance(a, transactions))
    }
  })

  it('refuses to shorten a stay below the nights already posted', async () => {
    const stay = await bookStay(3)
    await s.booking.checkIn(stay.id, arrival)
    await s.nightAudit.run()
    clock.date = addDays(TODAY, 1)
    await s.nightAudit.run()
    await expect(s.booking.adjustStay(stay.id, TODAY, addDays(TODAY, 1))).rejects.toMatchObject({ code: 'NIGHT_POSTED' })
    expect((await s.booking.adjustStay(stay.id, TODAY, addDays(TODAY, 2))).nights).toBe(2)
  })
})
