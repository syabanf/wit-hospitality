import { beforeEach, describe, expect, it } from 'vitest'
import { fixedClock } from '@/infrastructure/clock'
import { createMockPorts } from '@/infrastructure/mock'
import type { CheckInDetails, CheckOutDetails } from '@/domain/booking'
import type { GroupStayInput } from '@/domain/group'
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

  it('reports group bookings per villa with CSV-ready columns', async () => {
    const report = await s.reports.run('group-bookings', { from: TODAY, to: addDays(TODAY, 40) })
    expect(report.rows.map((r) => [r.code, r.villa, r.stays])).toEqual([
      ['GRP-1001', 'Villa Karang', 3],
      ['GRP-1002', 'Villa Lumbung', 2],
    ])
    expect(report.rows.every((r) => Number(r.deposit) > 0 && Number(r.balance) > 0)).toBe(true)
  })
})
