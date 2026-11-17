import { beforeEach, describe, expect, it } from 'vitest'
import { RuleError } from '@/domain/errors'
import { fixedClock } from '@/infrastructure/clock'
import { createMockPorts } from '@/infrastructure/mock'
import type { NewBooking, Ports } from './ports'
import { createServices, type Services } from './services'

const TODAY = '2026-11-11'
let s: Services
let ports: Ports
const signIn = (who: string) => s.access.login({ email: `${who}@balivillas.id`, password: 'villa123' })
const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e instanceof RuleError ? e.code : String(e)))
const arrival = { idVerified: true, deposit: 0, keysHanded: true, rulesExplained: true, arrivalTime: '14:00', adults: 2, children: 0, notes: '' }
const stay = (input: Partial<NewBooking>): NewBooking => ({ guestId: 'g-01', newGuest: null, groupId: null, unitId: null, source: 'direct', airbnbAccountId: null, airbnbCode: null, checkIn: TODAY, checkOut: '2026-11-13', channelRate: null, price: null, notes: '', confirm: true, ...input })

beforeEach(async () => {
  ports = createMockPorts(fixedClock(TODAY), 0, null)
  s = createServices(ports)
  await signIn('rama')
})

describe('room rack', () => {
  it('shows Saka by floor with occupancy, housekeeping and the stays still to assign', async () => {
    expect(await s.desk.hasHotel()).toBe(true)
    const rack = await s.desk.rack('vil-saka')
    expect(rack.tiles).toHaveLength(8)
    expect(rack.floors.map((f) => f.label)).toEqual(['Ground floor', 'Floor 1'])
    expect(Object.values(rack.occupancyCounts).reduce((a, b) => a + b, 0)).toBe(8)
    const inHouse = rack.tiles.find((t) => t.occupancy === 'in_house')
    expect(inHouse?.stay?.guestName).toBeTruthy()
    expect(rack.tiles.every((t) => t.housekeeping !== null)).toBe(true)
    expect(rack.unassigned.map((u) => u.code)).toContain('BK-2011')
    // Another day is a forecast: no housekeeping state.
    expect((await s.desk.rack('vil-saka', '2026-11-12')).tiles.every((t) => t.housekeeping === null)).toBe(true)
  })

  it('ranks the rooms to assign ready first and warns on a room housekeeping has not released, then checks in', async () => {
    // Saka is full tonight; two cancellations free SK-06 (ready) and SK-01 (being cleaned).
    await s.booking.transition('bk-2010', 'cancelled')
    await s.booking.transition('bk-1310', 'cancelled')
    const choices = await s.desk.assignChoices('bk-2011')
    expect(choices.map((c) => c.unit.code)).toEqual(['SK-06', 'SK-01'])
    expect(choices[1]!.warning).toBe('SK-01 is cleaning; housekeeping has not released it.')
    const rank = { ready: 0, inspected: 0, cleaning: 1, dirty: 2, out_of_order: 3 }
    expect(choices.map((c) => rank[c.state])).toEqual([...choices.map((c) => rank[c.state])].sort())
    for (const c of choices) expect(c.warning === null).toBe(c.state === 'ready' || c.state === 'inspected')
    const room = choices[0]!.unit
    await s.booking.assignUnit('bk-2011', room.id)
    const inHouse = await s.booking.checkIn('bk-2011', arrival)
    expect(inHouse.status).toBe('checked_in')
    expect(inHouse.unitId).toBe(room.id)
  })

  it('sells a walk-in on a vacant room tonight and checks the guest in', async () => {
    await s.booking.transition('bk-2009', 'cancelled')
    // SK-03's guest leaves today, so the room sells again tonight.
    const vacant = (await s.desk.rack('vil-saka')).tiles.find((t) => t.unit.code === 'SK-03')
    expect(vacant?.occupancy).toBe('due_out')
    const b = await s.booking.create(stay({ unitId: vacant!.unit.id, checkOut: '2026-11-12', newGuest: null }))
    expect((await s.booking.checkIn(b.id, arrival)).status).toBe('checked_in')
    expect((await s.desk.rack('vil-saka')).tiles.find((t) => t.unit.id === vacant!.unit.id)?.occupancy).toBe('in_house')
  })
})

describe('room move', () => {
  it('moves a guest in house to another room, keeps or reprices the rate, and leaves the old room dirty', async () => {
    await s.booking.transition('bk-1310', 'cancelled')
    const rack = await s.desk.rack('vil-saka')
    const guest = rack.tiles.find((t) => t.stay?.code === 'BK-1305')!
    const detail = await s.booking.detail(guest.stay!.id)
    const target = detail.swapTargets[0]!
    const before = detail.booking.listRates
    const kept = await s.booking.moveUnit(guest.stay!.id, target.id, 'Air conditioning broke', undefined, 'keep')
    expect(kept.listRates).toEqual(before)
    expect(kept.movements.at(-1)?.toUnitId).toBe(target.id)
    const board = await ports.maintenance.housekeeping()
    expect(board.find((h) => h.unitId === guest.unit.id)).toMatchObject({ state: 'dirty', updatedBy: 'Front desk' })
  })

  it('reprices the nights from the move on and refuses to reprice a channel stay', async () => {
    const b = await s.booking.create(stay({ unitId: 'unit-sk-05', checkIn: '2026-11-16', checkOut: '2026-11-17', packageId: 'pkg-with-breakfast' }))
    const moved = await s.booking.moveUnit(b.id, 'unit-sk-06', 'Guest asked for upstairs', undefined, 'reprice')
    expect(moved.listRates).toEqual(b.listRates)
    expect(moved.listSources?.[0]).toMatchObject({ name: expect.stringContaining('With breakfast') })
    const channel = await s.booking.create(stay({ unitId: 'unit-sk-05', checkIn: '2026-11-16', checkOut: '2026-11-17', source: 'airbnb', airbnbAccountId: 'acc-saka-stays', airbnbCode: 'HMQ2', channelRate: 1_500_000 }))
    expect(await code(s.booking.moveUnit(channel.id, 'unit-sk-06', 'Upgrade', undefined, 'reprice'))).toBe('CHANNEL_PRICE_LOCKED')
  })
})

describe('rate packages', () => {
  it('validates packages on a room type and refuses them on a villa', async () => {
    const plan = (await ports.property.ratePlans()).find((p) => p.groupId === 'grp-saka-standard')!
    expect(plan.packages?.map((k) => k.name)).toEqual(['With breakfast', 'Nusa Retreats corporate'])
    const base = { weekdayRate: plan.weekdayRate, weekendRate: plan.weekendRate, seasons: plan.seasons }
    await expect(s.property.saveRatePlan('grp-saka-standard', { ...base, packages: [{ name: 'Room only', rate: 'plan', value: 0, breakfast: 100_000, accountId: null }] })).rejects.toThrow('Room only is always offered')
    await expect(s.property.saveRatePlan('grp-saka-standard', { ...base, packages: [{ name: 'Agent', rate: 'percent', value: 95, breakfast: 0, accountId: null }] })).rejects.toThrow('A whole percentage from 1 to 90.')
    await expect(s.property.saveRatePlan('grp-saka-standard', { ...base, packages: [{ name: 'Guest corp', rate: 'fixed', value: 1_000_000, breakfast: 0, accountId: 'nope' }] })).rejects.toThrow('Pick a company account')
    const saved = await s.property.saveRatePlan('grp-saka-standard', { ...base, packages: [...plan.packages!, { name: 'Long stay', rate: 'percent', value: 15, breakfast: 0, accountId: null }] })
    expect(saved.packages?.at(-1)?.id).toBe('pkg-long-stay')
    // Leaving packages out keeps them.
    expect((await s.property.saveRatePlan('grp-saka-standard', base)).packages).toHaveLength(3)
  })

  it('prices a room booking through its package and enforces the package rules', async () => {
    const quote = await s.booking.quote({ unitId: 'unit-sk-05', groupId: null, checkIn: '2026-11-16', checkOut: '2026-11-17', source: 'direct', channelRate: null, price: null, packageId: 'pkg-nusa-corporate', partySize: { adults: 2, children: 0 } })
    expect(quote?.listRates).toEqual([1_650_000])
    expect(quote?.breakfast).toEqual({ perPerson: 120_000, persons: 2, total: 240_000 })
    expect(quote?.packages.map((k) => k.id)).toEqual(['pkg-with-breakfast', 'pkg-nusa-corporate'])

    const later = { unitId: 'unit-sk-05', checkIn: '2026-11-16', checkOut: '2026-11-17' }
    expect(await code(s.booking.create(stay({ ...later, packageId: 'pkg-nusa-corporate' })))).toBe('PACKAGE_ACCOUNT')
    expect(await code(s.booking.create(stay({ ...later, packageId: 'pkg-none' })))).toBe('PACKAGE_UNKNOWN')
    expect(await code(s.booking.create(stay({ ...later, source: 'airbnb', airbnbAccountId: 'acc-saka-stays', airbnbCode: 'HMQ1', channelRate: 1_500_000, packageId: 'pkg-with-breakfast' })))).toBe('PACKAGE_NOT_ALLOWED')
    const sold = await s.booking.create(stay({ ...later, packageId: 'pkg-with-breakfast' }))
    expect(sold.ratePackage?.name).toBe('With breakfast')
    expect(sold.listSources?.[0]).toMatchObject({ kind: 'plan', name: expect.stringContaining('With breakfast') })
  })

  it('posts breakfast on the folio when the night audit runs', async () => {
    await signIn('admin')
    await s.booking.transition('bk-2009', 'cancelled')
    const sold = await s.booking.create(stay({ unitId: 'unit-sk-03', checkOut: '2026-11-12', packageId: 'pkg-with-breakfast' }))
    const inHouse = await s.booking.checkIn(sold.id, arrival)
    const businessDate = await ports.audit.businessDate()
    await ports.audit.run({ date: businessDate, checks: {}, noShows: [] } as never)
    const folio = await s.booking.folio(inHouse.id)
    expect(folio.folio.lines.some((l) => l.code === 'BKF' && l.description.startsWith('Breakfast, night'))).toBe(true)
    expect(folio.folio.lines.some((l) => l.kind === 'room' && l.description.includes('With breakfast'))).toBe(true)
  })
})

describe('sections', () => {
  it('keeps sections on hotel properties only and checks their rooms', async () => {
    const sections = await s.desk.sections('vil-saka')
    expect(sections.map((x) => x.name)).toEqual(['Ground floor', 'Floor 1'])
    expect(await code(s.desk.saveSection(null, { villaId: 'vil-tirta', name: 'Pool wing', unitIds: [] }))).toBe('SECTION_HOTEL_ONLY')
    await expect(s.desk.saveSection(null, { villaId: 'vil-saka', name: 'ground FLOOR', unitIds: ['unit-sk-01'] })).rejects.toThrow('ground FLOOR is already a section of Villa Saka.')
    await expect(s.desk.saveSection(null, { villaId: 'vil-saka', name: 'Garden', unitIds: ['unit-sk-01'] })).rejects.toThrow('SK-01 is already in Ground floor.')
    const edited = await s.desk.saveSection(sections[1]!.id, { villaId: 'vil-saka', name: 'Upstairs', unitIds: ['unit-sk-05', 'unit-sk-06'] })
    expect(edited.unitIds).toEqual(['unit-sk-05', 'unit-sk-06'])
    const added = await s.desk.saveSection(null, { villaId: 'vil-saka', name: 'Garden', unitIds: ['unit-sk-07', 'unit-sk-07'] })
    expect(added.unitIds).toEqual(['unit-sk-07'])
    await s.desk.removeSection(added.id)
    expect((await s.desk.sections('vil-saka')).map((x) => x.name)).toEqual(['Ground floor', 'Upstairs'])
  })

  it('gives a section to an attendant for the day and later tasks of its rooms start with them', async () => {
    await signIn('admin')
    const day = await s.housekeeping.day(TODAY)
    expect(day.groups.some((g) => g.label === 'Villa Saka, Ground floor')).toBe(true)
    const section = day.sections.find((x) => x.name === 'Floor 1')!
    const attendant = day.attendants.find((a) => a.villaNames.includes('Villa Saka'))!
    expect(await code(s.housekeeping.assignSection(section.id, '2026-12-31', attendant.id))).toBe('NOT_ON_SHIFT')
    await s.housekeeping.assignSection(section.id, TODAY, attendant.id)
    const task = await s.housekeeping.addTask({ unitId: 'unit-sk-06', date: TODAY, type: 'inspection', attendantId: null, note: '' })
    expect(task.attendantId).toBe(attendant.id)
    const cleared = await s.housekeeping.assignSection(section.id, TODAY, null)
    expect(cleared.every((t) => t.attendantId === null)).toBe(true)
    expect(cleared.map((t) => t.id)).toContain(task.id)
  })
})
