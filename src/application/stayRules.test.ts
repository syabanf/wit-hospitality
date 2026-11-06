import { beforeEach, describe, expect, it } from 'vitest'
import { fixedClock } from '@/infrastructure/clock'
import { createMockPorts } from '@/infrastructure/mock'
import { addDays } from '@/lib/dates'
import type { NewBooking } from './ports'
import { createServices, type Services } from './services'

const TODAY = '2026-10-30'
let s: Services
const signIn = (who: string) => s.access.login({ email: `${who}@balivillas.id`, password: 'villa123' })
const direct = (unitId: string | null, checkIn: string, checkOut: string, extra: Partial<NewBooking> = {}) =>
  s.booking.create({ guestId: 'g-01', newGuest: null, unitId, groupId: null, source: 'direct', airbnbAccountId: null, airbnbCode: null, checkIn, checkOut, channelRate: null, price: null, notes: '', confirm: true, ...extra })
/** A Saka standard stay booked against the room type. */
const sakaType = (checkIn: string, nights = 1, extra: Partial<NewBooking> = {}) => direct(null, checkIn, addDays(checkIn, nights), { groupId: 'grp-saka-standard', ...extra })

beforeEach(async () => {
  s = createServices(createMockPorts(fixedClock(TODAY), 0))
  await signIn('dian')
})

describe('stay restrictions on bookings', () => {
  it('refuses a direct stay that breaks the high season minimum, and only a manager overrides it with a reason', async () => {
    const check = await s.stayRules.check({ unitId: 'unit-kr-01', groupId: null, checkIn: '2026-12-21', checkOut: '2026-12-23', source: 'direct' })
    expect(check.violations.map((v) => v.rule)).toEqual(['min_stay'])
    expect(check.mayOverride).toBe(false)
    expect(check.marks.filter((m) => m.minNights === 3).map((m) => m.date)).toContain('2026-12-21')
    await expect(direct('unit-kr-01', '2026-12-21', '2026-12-23')).rejects.toMatchObject({ code: 'RESTRICTION_VIOLATED', message: expect.stringContaining('stay at least 3 nights') })
    await expect(direct('unit-kr-01', '2026-12-21', '2026-12-23', { override: { reason: 'Regular guest' } })).rejects.toMatchObject({ code: 'RESTRICTION_OVERRIDE_FORBIDDEN' })
    await signIn('kadek')
    await expect(direct('unit-kr-01', '2026-12-21', '2026-12-23', { override: { reason: ' ' } })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    const b = await direct('unit-kr-01', '2026-12-21', '2026-12-23', { override: { reason: 'Regular guest, two nights only' } })
    expect(b.restrictionNote).toMatchObject({ kind: 'override', rules: ['min_stay'], reason: 'Regular guest, two nights only', by: 'Kadek Ariani' })
    const audit = await s.access.audit()
    expect(audit.entries.some((e) => e.entityId === b.code && e.summary.includes('past stay restrictions'))).toBe(true)
    const report = await s.reports.run('restriction-overrides', { from: TODAY, to: TODAY })
    expect(report.rows).toEqual([expect.objectContaining({ code: b.code, kind: 'Override', rules: 'Minimum stay' })])
  })

  it('keeps an Airbnb stay the channel sold against a rule, with a warning', async () => {
    const listing = (await s.booking.formOptions()).listings.find((l) => l.unitId === 'unit-kr-02')
    if (!listing) throw new Error('KR-02 has no listing')
    const b = await direct('unit-kr-02', '2026-12-30', '2027-01-01', { source: 'airbnb', airbnbAccountId: listing.accountId, airbnbCode: 'HMWARN01', channelRate: 6_000_000 })
    expect(b.restrictionNote).toMatchObject({ kind: 'channel', rules: ['min_stay', 'min_stay_through'], reason: '' })
  })

  it('closes one unit under its stop sell and leaves the rest of the type on sale', async () => {
    const closedFrom = addDays(TODAY, 29)
    await expect(direct('unit-tr-04', closedFrom, addDays(closedFrom, 2))).rejects.toMatchObject({ code: 'RESTRICTION_VIOLATED', message: expect.stringContaining('Closed for sale') })
    await expect(direct('unit-tr-03', closedFrom, addDays(closedFrom, 2))).resolves.toMatchObject({ unitCode: 'TR-03' })
  })

  it('checks new dates on a stay change, and lets a guest in house leave early', async () => {
    const b = await direct('unit-kr-01', '2026-12-10', '2026-12-13')
    await expect(s.booking.adjustStay(b.id, '2026-12-20', '2026-12-22')).rejects.toMatchObject({ code: 'RESTRICTION_VIOLATED' })
    await signIn('kadek')
    const moved = await s.booking.adjustStay(b.id, '2026-12-20', '2026-12-22', undefined, { reason: 'Owner friend' })
    expect(moved.restrictionNote?.kind).toBe('override')
    // A guest in house who leaves early is never held to the minimum.
    const inHouse = (await s.booking.list()).list.find((x) => x.status === 'checked_in' && x.nights >= 3 && x.checkOut > addDays(TODAY, 1))
    if (!inHouse) throw new Error('no guest in house')
    await expect(s.booking.adjustStay(inHouse.id, inHouse.checkIn, addDays(TODAY, 1))).resolves.toMatchObject({ checkOut: addDays(TODAY, 1) })
  })

  it('refuses a whole group when one stay breaks a rule, and books it with an override', async () => {
    const stay = (unitId: string) => ({ unitId, roomTypeId: null, checkIn: '2026-12-30', checkOut: '2027-01-02', adults: 2, children: 0, price: null })
    const input = { name: 'New Year party', guestId: 'g-11', newGuest: null, source: 'direct' as const, billing: 'per_stay' as const, stays: [stay('unit-kr-01'), stay('unit-tr-01')], discount: null, note: '', confirm: true, deposit: null }
    const before = (await s.booking.list()).list.length
    await expect(s.groups.create(input)).rejects.toMatchObject({ code: 'RESTRICTION_VIOLATED', message: expect.stringContaining('KR-01') })
    expect((await s.booking.list()).list).toHaveLength(before)
    await signIn('kadek')
    const { group } = await s.groups.create({ ...input, override: { reason: 'Wedding party, agreed with the owner' } })
    const stays = (await s.booking.list()).list.filter((b) => b.group?.id === group.id)
    expect(stays.map((b) => b.restrictionNote?.kind)).toEqual(['override', 'override'])
  })
})

describe('restriction editing', () => {
  it('needs property edit, checks the unit belongs to the type, and adds a rule to several types at once', async () => {
    const rule = { groupId: 'grp-lumbung-loft', unitId: null, rule: 'closed_to_departure' as const, nights: null, yearly: false, from: '2026-11-15', to: '2026-11-15', weekdays: [], note: 'Festival' }
    await expect(s.stayRules.save(null, rule)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await signIn('kadek')
    await expect(s.stayRules.save(null, { ...rule, unitId: 'unit-kr-01' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    const saved = await s.stayRules.save(null, rule)
    expect((await s.stayRules.roomType('grp-lumbung-loft')).restrictions.map((r) => r.id)).toContain(saved.id)
    const bulk = await s.stayRules.bulk({ groupIds: ['grp-saka-standard', 'grp-tirta-pool'], rule: 'max_stay', nights: 14, yearly: true, from: '01-06', to: '06-30', weekdays: [], note: '' })
    expect(bulk.map((r) => r.groupId)).toEqual(['grp-saka-standard', 'grp-tirta-pool'])
    await expect(s.stayRules.bulk({ groupIds: [], rule: 'stop_sell', nights: null, yearly: false, from: '2026-11-15', to: '2026-11-16', weekdays: [], note: '' })).rejects.toMatchObject({ errors: { groupIds: 'Pick at least one room type.' } })
    await s.stayRules.remove(saved.id)
    expect((await s.stayRules.overview()).restrictions.some((r) => r.id === saved.id)).toBe(false)
  })
})

describe('overbooking and walks', () => {
  it('sells a room type past its rooms up to the policy and never a room sold room by room', async () => {
    const night = '2026-12-08'
    const made = []
    for (let i = 0; i < 9; i++) made.push(await sakaType(night, 2))
    await expect(sakaType(night, 2)).rejects.toMatchObject({ code: 'ROOM_TYPE_FULL' })
    expect(made).toHaveLength(9)
    expect((await s.stayRules.overbooked(night, 2)).map((n) => [n.groupName, n.date, n.over])).toEqual([['Saka standard', night, 1], ['Saka standard', '2026-12-09', 1]])
    const cal = await s.booking.calendar(night, 7, { villaId: 'vil-saka' })
    expect(cal.typeRows.find((r) => r.groupId === 'grp-saka-standard')?.overbooked.slice(0, 3)).toEqual([1, 1, 0])
    await expect(s.stayRules.setOverbooking('grp-karang-cliff', 1)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await signIn('kadek')
    await expect(s.stayRules.setOverbooking('grp-karang-cliff', 1)).rejects.toMatchObject({ code: 'OVERBOOK_ROOM_BY_ROOM' })
    await s.stayRules.setOverbooking('grp-saka-standard', 0)
    await expect(sakaType('2026-12-15')).resolves.toBeDefined()
  })

  it('walks a guest off an overbooked night, out to another property or into another villa, with the cost for approval', async () => {
    await signIn('kadek')
    // Fill Saka standard tonight up to its rooms and one past them.
    const tonight = []
    for (;;) {
      const next = await sakaType(TODAY, 1, { payment: { kind: 'deposit', method: 'cash', amount: 500_000, reference: '' } }).catch((e: { code?: string }) => {
        if (e.code === 'ROOM_TYPE_FULL') return null
        throw e
      })
      if (!next) break
      tonight.push(next)
    }
    const last = tonight.at(-1)
    if (!last) throw new Error('nothing booked tonight')
    expect((await s.dashboard.attention()).overbooked).toEqual([expect.objectContaining({ groupName: 'Saka standard', date: TODAY, over: 1 })])
    const info = await s.stayRules.forBooking(last.id)
    expect(info).toMatchObject({ walkable: true, over: 1, walk: null })
    expect(info.targets.every((t) => t.unit.groupId !== 'grp-saka-standard')).toBe(true)

    const later = await sakaType(addDays(TODAY, 3))
    await expect(s.stayRules.walk(later.id, { destination: 'outside', unitId: null, property: 'Hotel Canggu', cost: 0, method: 'cash', compensation: '', reason: 'Overbooked' })).rejects.toMatchObject({ code: 'WALK_NOT_ALLOWED' })

    const out = await s.stayRules.walk(last.id, { destination: 'outside', unitId: null, property: 'Hotel Canggu Beach', cost: 800_000, method: 'cash', compensation: 'Free airport transfer', reason: 'Saka standard overbooked tonight' })
    expect(out.booking.status).toBe('cancelled')
    expect(out.walk).toMatchObject({ destination: 'outside', property: 'Hotel Canggu Beach', cost: 800_000, toUnitId: null })
    const entry = (await s.finance.transactions()).list.find((t) => t.id === out.walk.transactionId)
    expect(entry).toMatchObject({ kind: 'cash_out', categoryId: 'cat-relocation', amount: 800_000, status: 'submitted', bookingId: last.id, accountId: 'cb-canggu' })
    const invoice = await s.payments.invoice(last.id)
    expect(invoice.payments.filter((p) => p.kind === 'refund').map((p) => p.amount)).toEqual([500_000])
    // The night is no longer overbooked, so the next guest cannot be walked.
    const prev = tonight.at(-2)
    if (!prev) throw new Error('one stay only')
    await expect(s.stayRules.walk(prev.id, { destination: 'outside', unitId: null, property: 'Hotel Canggu', cost: 0, method: 'cash', compensation: '', reason: 'Overbooked' })).rejects.toMatchObject({ code: 'WALK_NOT_OVERBOOKED' })

    // Overbook again and walk the guest into a unit of another villa.
    const again = await sakaType(TODAY, 1)
    const { targets } = await s.stayRules.forBooking(again.id)
    const target = targets[0]?.unit
    if (!target) throw new Error('no unit to walk to')
    const moved = await s.stayRules.walk(again.id, { destination: 'group_villa', unitId: target.id, property: '', cost: 0, method: 'cash', compensation: 'Upgrade at no charge', reason: 'Saka standard overbooked tonight' })
    expect(moved.booking).toMatchObject({ status: 'confirmed', unitId: target.id, unitAssigned: true })
    expect(moved.booking.movements.at(-1)?.toUnitId).toBe(target.id)
    expect(moved.walk.transactionId).toBeNull()

    const report = await s.reports.run('guest-walks', { from: TODAY, to: TODAY })
    expect(report.rows.map((r) => [r.code, r.cost])).toEqual([
      [last.code, 800_000],
      [again.code, 0],
    ])
  })
})

describe('restrictions on assigning a room and adding a group stay', () => {
  it('holds a stay booked by type to the stop sell on the room it gets, and only a manager sells past it', async () => {
    const arrive = '2026-11-24'
    const b = await sakaType(arrive, 2)
    const [closed, open] = (await s.booking.detail(b.id)).assignable
    if (!closed || !open) throw new Error('two Saka rooms should be free')
    await signIn('kadek')
    await s.stayRules.save(null, { groupId: 'grp-saka-standard', unitId: closed.id, rule: 'stop_sell', nights: null, yearly: false, from: arrive, to: arrive, weekdays: [], note: 'Pool pump' })
    await signIn('dian')
    const check = await s.stayRules.assignCheck(b.id, closed.id)
    expect(check).toMatchObject({ channel: false, mayOverride: false })
    expect(check.violations.map((v) => v.rule)).toEqual(['stop_sell'])
    expect((await s.stayRules.assignCheck(b.id, open.id)).violations).toEqual([])
    await expect(s.booking.assignUnit(b.id, closed.id)).rejects.toMatchObject({ code: 'RESTRICTION_VIOLATED', message: expect.stringContaining(closed.code) })
    await expect(s.booking.assignUnit(b.id, closed.id, { reason: 'Guest asked for it' })).rejects.toMatchObject({ code: 'RESTRICTION_OVERRIDE_FORBIDDEN' })
    await expect(s.booking.assignUnit(b.id, open.id)).resolves.toMatchObject({ unitId: open.id })
    await signIn('kadek')
    const placed = await s.booking.assignUnit(b.id, closed.id, { reason: 'Pump fixed early, guest asked for it' })
    expect(placed).toMatchObject({ unitId: closed.id, restrictionNote: { kind: 'override', rules: ['stop_sell'], reason: 'Pump fixed early, guest asked for it', by: 'Kadek Ariani' } })
    expect((await s.access.audit()).entries.some((e) => e.entityId === b.code && e.summary.includes('past stay restrictions'))).toBe(true)
  })

  it('checks a stay added to a group against the restrictions, with the override', async () => {
    const stay = (unitId: string) => ({ unitId, roomTypeId: null, checkIn: '2027-02-10', checkOut: '2027-02-13', adults: 2, children: 0, price: null })
    const { group } = await s.groups.create({ name: 'Retreat', guestId: 'g-11', newGuest: null, source: 'direct', billing: 'per_stay', stays: [stay('unit-kr-01'), stay('unit-kr-03')], discount: null, note: '', confirm: true, deposit: null })
    await signIn('kadek')
    await s.stayRules.save(null, { groupId: 'grp-karang-cliff', unitId: 'unit-kr-02', rule: 'stop_sell', nights: null, yearly: false, from: '2027-02-11', to: '2027-02-11', weekdays: [], note: 'Photo shoot' })
    await signIn('dian')
    await expect(s.groups.addStay(group.id, stay('unit-kr-02'))).rejects.toMatchObject({ code: 'RESTRICTION_VIOLATED', message: expect.stringContaining('KR-02') })
    await expect(s.groups.addStay(group.id, stay('unit-kr-02'), { override: { reason: 'Retreat needs it' } })).rejects.toMatchObject({ code: 'RESTRICTION_OVERRIDE_FORBIDDEN' })
    await signIn('kadek')
    const added = await s.groups.addStay(group.id, stay('unit-kr-02'), { override: { reason: 'Shoot moved, retreat takes it' } })
    expect(added).toMatchObject({ unitCode: 'KR-02', restrictionNote: { kind: 'override', rules: ['stop_sell'] } })
  })

  it('books a group for a blacklisted lead only with a manager override', async () => {
    const stay = (unitId: string) => ({ unitId, roomTypeId: null, checkIn: '2027-02-10', checkOut: '2027-02-12', adults: 2, children: 0, price: null })
    const input = { name: 'Returning party', guestId: 'g-25', newGuest: null, source: 'direct' as const, billing: 'master' as const, stays: [stay('unit-kr-03'), stay('unit-tr-01')], discount: null, note: '', confirm: true, deposit: null }
    await expect(s.groups.create(input)).rejects.toMatchObject({ code: 'GUEST_BLACKLISTED' })
    await expect(s.groups.create({ ...input, blacklistOverride: 'Paid the damage' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await signIn('kadek')
    const { group } = await s.groups.create({ ...input, blacklistOverride: 'Paid the damage in full' })
    expect(group.leadGuestId).toBe('g-25')
    expect((await s.access.audit()).entries.find((e) => e.entity === 'guest' && e.entityId === 'g-25')?.action).toBe('approve')
  })
})
