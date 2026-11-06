import { beforeEach, describe, expect, it } from 'vitest'
import { fixedClock } from '@/infrastructure/clock'
import { createMockPorts } from '@/infrastructure/mock'
import type { CheckInDetails, CheckOutDetails } from '@/domain/booking'
import type { GroupStayInput } from '@/domain/group'
import { GL, partyBalances } from '@/domain/journal'
import { addDays } from '@/lib/dates'
import type { NewBookingGroup } from './ports'
import { createServices, type Services } from './services'

const TODAY = '2026-10-05'
let s: Services
const signIn = (who: string) => s.access.login({ email: `${who}@balivillas.id`, password: 'villa123' })
const arrival: CheckInDetails = { idVerified: true, deposit: 0, keysHanded: true, rulesExplained: true, arrivalTime: '14:00', adults: 2, children: 0, notes: '' }
const departure: CheckOutDetails = { depositReturned: 0, extraCharges: 0, roomInspected: true, keysReturned: true, notes: '' }
const stay = (unitId: string | null, nights = 2, roomTypeId: string | null = null): GroupStayInput => ({ unitId, roomTypeId, checkIn: TODAY, checkOut: addDays(TODAY, nights), adults: 2, children: 1, price: null })
const input = (fields: Partial<NewBookingGroup> = {}): NewBookingGroup => ({
  name: 'Offsite of PT Maju',
  guestId: 'g-11',
  newGuest: null,
  source: 'corporate',
  billing: 'master',
  stays: [stay('unit-sk-06'), stay('unit-kr-01')],
  discount: null,
  note: '',
  confirm: true,
  deposit: null,
  ...fields,
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

/** A massage delivered and a minibar charge posted on each stay; returns the orders. */
async function orderAndCharge(stays: readonly { id: string; place: { villa: { id: string } } }[]) {
  const options = await s.orders.formOptions()
  const orders = []
  for (const b of stays) {
    const item = options.menu.find((i) => i.villaId === b.place.villa.id && i.name.startsWith('Balinese massage'))
    if (!item) throw new Error('no massage on the menu')
    const order = await s.orders.place({ bookingId: b.id, lines: [{ itemId: item.id, quantity: 1 }], note: '', requestedOn: addDays(TODAY, 1), requestedAt: 12 * 60, priority: 'normal', discountPct: 0, discountReason: '', compReason: '' })
    for (const to of ['confirmed', 'preparing', 'delivered'] as const) await s.orders.transition(order.id, to)
    orders.push({ ...order, charge: item.price })
    await s.booking.postCharge(b.id, { category: 'minibar', description: 'Two beers', amount: 120_000 })
  }
  return orders
}

/** What the books hold for the stays once all of them left and every entry posted. */
async function expectSettledBooks(stays: readonly { id: string; code: string; total: number }[], orders: ReadonlyArray<{ id: string; charge: number }>) {
  await signIn('ida')
  const books = (await s.accounting.journals()).views
  const net = (accountId: string, key: 'bookingId', id: string) => {
    const m = partyBalances(books, accountId, key).get(id)
    return (m?.debit ?? 0) - (m?.credit ?? 0)
  }
  for (const b of stays) {
    expect(net(GL.receivable, 'bookingId', b.id), `${b.code} receivable`).toBe(0)
    expect(net(GL.deposits, 'bookingId', b.id), `${b.code} deposits`).toBe(0)
  }
  const credited = (source: string, ids: readonly string[], accountId: string) =>
    books.filter((e) => e.source === source && ids.includes(e.sourceId)).flatMap((e) => e.lines).filter((l) => l.account.id === accountId).reduce((sum, l) => sum + l.credit - l.debit, 0)
  expect(credited('folio', stays.map((b) => b.id), GL.roomRevenue)).toBe(stays.reduce((sum, b) => sum + b.total, 0))
  expect(credited('order', orders.map((o) => o.id), GL.roomService)).toBe(orders.reduce((sum, o) => sum + o.charge, 0))
  expect(credited('charge', stays.map((b) => b.id), GL.otherIncome)).toBe(stays.length * 120_000)
  const tb = await s.accounting.trialBalance({})
  expect(tb.debit).toBe(tb.credit)
  const bs = await s.accounting.balanceSheet({})
  expect(bs.balanced).toBe(true)
}

beforeEach(async () => {
  s = createServices(createMockPorts(fixedClock(TODAY), 0))
  await signIn('kadek')
})

describe('group bookings', () => {
  it('seeds a master-billed wedding whose master folio and stay folios add up to the bill', async () => {
    const { rows } = await s.groups.list()
    expect(rows.map((r) => r.group.code)).toEqual(['GRP-1002', 'GRP-1001'])
    const wedding = await s.groups.detail('bg-1')
    expect(wedding.stays.map((x) => x.booking.unitCode)).toEqual(['KR-01', 'KR-02', 'KR-03'])
    expect(wedding.stays.every((x) => x.roomDue === 0 && x.booking.discount?.reason.startsWith('Group discount'))).toBe(true)
    expect(wedding.batches).toHaveLength(1)
    expect(wedding.master?.lines.filter((l) => l.kind === 'payment')).toHaveLength(1)
    expect(wedding.master?.due).toBe(wedding.row.outstanding)
    const folios = await Promise.all(wedding.stays.map((x) => s.booking.folio(x.booking.id)))
    expect(folios.every((f) => f.folio.lines.every((l) => l.part !== 'room' || l.kind === 'deposit'))).toBe(true)
    expect((wedding.master?.balance ?? 0) + folios.reduce((sum, f) => sum + f.folio.balance, 0)).toBe(wedding.row.total - wedding.row.paid)
    const family = await s.groups.detail('bg-2')
    expect(family.master).toBeNull()
    expect(family.stays.every((x) => x.roomDue > 0)).toBe(true)
  })

  it('refuses the whole group when one unit clashes, and names it', async () => {
    const before = (await s.booking.list()).list.length
    // KR-01 is free for two nights, then its next seed stay arrives.
    const clash = input({ stays: [stay('unit-sk-06'), stay('unit-kr-01', 4)] })
    await expect(s.groups.create(clash)).rejects.toMatchObject({ code: 'GROUP_UNAVAILABLE', message: expect.stringContaining('KR-01') })
    await expect(s.groups.create(input({ stays: [stay('unit-sk-06'), stay('unit-sk-06')] }))).rejects.toMatchObject({ code: 'GROUP_UNAVAILABLE', message: expect.stringContaining('stay 1 of this group') })
    expect((await s.booking.list()).list.length).toBe(before)
    expect((await s.groups.check(clash.stays, null)).clashes.map((c) => c.label)).toEqual(['KR-01'])
  })

  it('takes one deposit over the stays, checks the group in, and closes the master folio with the last stay', async () => {
    const { group } = await s.groups.create(input({ discount: { pct: 10, reason: 'Company rate' }, deposit: { kind: 'deposit', method: 'cash', amount: 6_000_000, reference: '', note: '' } }))
    let detail = await s.groups.detail(group.id)
    const [first, last] = detail.stays.map((x) => x.booking)
    if (!first || !last) throw new Error('stays missing')
    expect(detail.row.stays.every((b) => b.discount?.value === 10 && b.partySize?.children === 1)).toBe(true)
    expect(detail.batches).toEqual([expect.objectContaining({ kind: 'deposit', amount: 6_000_000, stays: [first.code, last.code] })])
    const entries = (await s.finance.transactions()).list.filter((t) => t.reference === detail.batches[0]?.batch)
    expect(entries.map((t) => [t.kind, t.categoryId, t.amount, t.status])).toEqual([['cash_in', 'cat-room', 6_000_000, 'submitted']])

    expect(await s.groups.checkIn(group.id, arrival)).toHaveLength(2)
    await s.booking.postCharge(first.id, { category: 'minibar', description: 'Two beers', amount: 120_000 })
    // The first stay pays its own extras; the room stays on the master folio.
    const due = await s.booking.settlement(first.id)
    expect(due.roomDue).toBe(0)
    expect(due.master).toMatchObject({ code: group.code, closes: false })
    await s.booking.settleAndCheckOut(first.id, { details: departure, method: 'cash', reference: '', attachments: [] })

    await expect(s.booking.settleAndCheckOut(last.id, { details: departure, method: 'cash', reference: '', attachments: [] })).rejects.toMatchObject({ code: 'GROUP_MASTER_OPEN' })
    detail = await s.groups.detail(group.id)
    await s.groups.pay(group.id, { kind: 'balance', method: 'bank_transfer', amount: detail.master?.due ?? 0, reference: 'TRF-889', note: '' })
    expect((await s.groups.detail(group.id)).master?.due).toBe(0)
    await s.booking.settleAndCheckOut(last.id, { details: departure, method: 'cash', reference: '', attachments: [] })
    expect((await s.groups.detail(group.id)).row.status).toBe('checked_out')
  })

  it('sells a room type inside a group and checks in only once every room is assigned', async () => {
    const { group } = await s.groups.create(input({ billing: 'per_stay', stays: [stay('unit-kr-01', 1), stay(null, 1, 'grp-saka-standard')] }))
    const detail = await s.groups.detail(group.id)
    const waiting = detail.row.stays.find((b) => !b.unitAssigned)
    if (!waiting) throw new Error('room type stay missing')
    expect(waiting.roomType).toBe('Saka standard')
    await expect(s.groups.checkIn(group.id, arrival)).rejects.toMatchObject({ code: 'UNIT_UNASSIGNED' })
    const room = (await s.booking.detail(waiting.id)).assignable[0]
    if (!room) throw new Error('no free Saka room')
    await s.booking.assignUnit(waiting.id, room.id)
    expect(await s.groups.checkIn(group.id, arrival)).toHaveLength(2)
    // Each stay keeps its own folio and pays its own room.
    expect((await s.booking.settlement(waiting.id)).roomDue).toBeGreaterThan(0)
  })

  it('sends one link for a gateway deposit and pays every share when the guest pays', async () => {
    const { group, link } = await s.groups.create(input({ billing: 'per_stay', deposit: { kind: 'deposit', method: 'qris', amount: 2_000_000, reference: '', note: '' } }))
    if (!link) throw new Error('no link')
    expect((await s.payments.checkout(link.token)).total).toBe(2_000_000)
    await s.payments.settle(link.token, 'paid')
    const detail = await s.groups.detail(group.id)
    expect(detail.batches).toEqual([expect.objectContaining({ status: 'paid', amount: 2_000_000 })])
    expect(detail.row.paid).toBe(2_000_000)
  })

  it('adds and removes stays, and cancels the rest under each stay’s policy', async () => {
    const { group } = await s.groups.create(input({ billing: 'per_stay', stays: [stay('unit-kr-01', 1), stay('unit-sk-06', 1)] }))
    const added = await s.groups.addStay(group.id, { ...stay('unit-tr-03', 2), checkIn: addDays(TODAY, 3), checkOut: addDays(TODAY, 5) })
    expect(added.group?.code).toBe(group.code)
    await expect(s.groups.addStay(group.id, stay('unit-kr-01', 1))).rejects.toMatchObject({ code: 'GROUP_UNAVAILABLE' })
    const removed = await s.groups.removeStay(group.id, added.id)
    expect(removed.group).toBeNull()
    expect(await s.groups.cancel(group.id)).toBe(2)
    expect((await s.groups.detail(group.id)).row.status).toBe('cancelled')
    await expect(s.groups.cancel(group.id)).rejects.toMatchObject({ code: 'BOOKING_INVALID_STATE' })
  })

  it('books a master-billed group stay by stay: each receivable and deposit ends at zero', async () => {
    const { group } = await s.groups.create(input({ stays: [stay('unit-sk-06'), stay('unit-kr-01'), stay('unit-sk-02')], discount: { pct: 10, reason: 'Company rate' }, deposit: { kind: 'deposit', method: 'cash', amount: 1_000_000, reference: '', note: '' } }))
    await postOpen()
    await s.groups.checkIn(group.id, arrival)
    const stays = (await s.groups.detail(group.id)).row.stays
    const orders = await orderAndCharge(stays)
    // Every stay but the last pays its own extras and leaves with its room still on the master folio.
    for (const b of stays.slice(0, -1)) await s.booking.settleAndCheckOut(b.id, { details: departure, method: 'cash', reference: '', attachments: [] })
    const due = (await s.groups.detail(group.id)).master?.due ?? 0
    expect(due).toBeGreaterThan(0)
    await s.groups.pay(group.id, { kind: 'balance', method: 'bank_transfer', amount: due, reference: 'TRF-990', note: '' })
    const last = stays.at(-1)
    if (!last) throw new Error('stays missing')
    await s.booking.settleAndCheckOut(last.id, { details: departure, method: 'cash', reference: '', attachments: [] })
    await postOpen()
    await expectSettledBooks(stays, orders)
  })

  it('books a per-stay group: each stay settles its own room, room service and charges', async () => {
    const { group } = await s.groups.create(input({ billing: 'per_stay', deposit: { kind: 'deposit', method: 'bank_transfer', amount: 2_000_000, reference: 'TRF-77', note: '' } }))
    await postOpen()
    await s.groups.checkIn(group.id, arrival)
    const stays = (await s.groups.detail(group.id)).row.stays
    const orders = await orderAndCharge(stays)
    for (const b of stays) await s.booking.settleAndCheckOut(b.id, { details: departure, method: 'cash', reference: '', attachments: [] })
    await postOpen()
    await expectSettledBooks(stays, orders)
  })

  it('reports group bookings per villa with CSV-ready columns', async () => {
    const report = await s.reports.run('group-bookings', { from: TODAY, to: addDays(TODAY, 40) })
    expect(report.rows.map((r) => [r.code, r.villa, r.stays])).toEqual([
      ['GRP-1001', 'Villa Karang', 3],
      ['GRP-1002', 'Villa Lumbung', 2],
    ])
    expect(report.rows.every((r) => Number(r.deposit) > 0 && Number(r.balance) > 0)).toBe(true)
  })
})
