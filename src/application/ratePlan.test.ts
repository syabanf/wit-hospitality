import { beforeEach, describe, expect, it } from 'vitest'
import { fixedClock } from '@/infrastructure/clock'
import { createMockPorts } from '@/infrastructure/mock'
import { priceSourceLabel } from '@/domain/pricing'
import { unitSetupDefaults } from '@/domain/property'
import { createServices, type Services } from './services'

let s: Services
const signIn = (who: string) => s.access.login({ email: `${who}@balivillas.id`, password: 'villa123' })
const quote = (unitId: string, checkIn: string, checkOut: string) => s.booking.quote({ unitId, groupId: null, checkIn, checkOut, source: 'direct', channelRate: null, price: null })
const direct = (unitId: string, checkIn: string, checkOut: string) =>
  s.booking.create({ guestId: 'g-01', newGuest: null, unitId, groupId: null, source: 'direct', airbnbAccountId: null, airbnbCode: null, checkIn, checkOut, channelRate: null, price: null, notes: '', confirm: true })
const labels = (nights: ReadonlyArray<{ source: Parameters<typeof priceSourceLabel>[0] }>) => nights.map((n) => priceSourceLabel(n.source))

beforeEach(() => {
  s = createServices(createMockPorts(fixedClock('2026-10-05'), 0))
})

describe('pricing by unit kind', () => {
  it('prices a hotel room from its rate plan, even when it has a live Airbnb listing', async () => {
    // SK-01 is a Saka hotel room with a live listing; 2026-11-19 is a Thursday.
    const sk = await quote('unit-sk-01', '2026-11-19', '2026-11-21')
    expect(sk?.priceList).toBe('plan')
    expect(sk?.listRates).toEqual([1_850_000, 2_200_000])
    expect(labels(sk?.nights ?? [])).toEqual(['Rate plan: Weekday', 'Rate plan: Weekend'])
    expect((await quote('unit-sk-08', '2026-12-21', '2026-12-22'))?.nights[0]).toMatchObject({ rate: 2_590_000, source: { kind: 'plan', name: 'High season' } })
  })

  it('prices a villa from its live listing, else its own nightly rate', async () => {
    const tr = await quote('unit-tr-04', '2026-11-19', '2026-11-22')
    expect(tr?.priceList).toBe('listing')
    expect(tr?.listRates).toEqual([1_650_000, 1_900_000, 1_900_000])
    expect(labels(tr?.nights ?? [])).toEqual(['Airbnb listing', 'Airbnb listing', 'Airbnb listing'])
    // KR-03 has no listing: its nightly rate, not the Karang rate plan's weekend rate.
    const kr = await quote('unit-kr-03', '2026-11-19', '2026-11-21')
    expect(kr?.priceList).toBe('villa')
    expect(kr?.listRates).toEqual([3_200_000, 3_200_000])
    expect(labels(kr?.nights ?? [])).toEqual(['Villa rate', 'Villa rate'])
  })

  it('keeps a stay at the prices it was sold at, and reprices only new nights by the rule', async () => {
    const room = await direct('unit-sk-01', '2026-11-19', '2026-11-20')
    expect(room.price.total).toBe(1_850_000)
    await s.property.saveRatePlan('grp-saka-standard', { weekdayRate: 2_000_000, weekendRate: 2_500_000, seasons: [] })
    expect((await s.booking.detail(room.id)).booking.listRates).toEqual([1_850_000])
    expect((await s.booking.adjustStay(room.id, '2026-11-19', '2026-11-21')).listRates).toEqual([1_850_000, 2_500_000])

    const villa = await direct('unit-kr-03', '2026-11-19', '2026-11-20')
    await s.airbnb.createListing({ accountId: 'acc-bali-escapes', unitId: 'unit-kr-03', title: 'Karang cliff villa 3', airbnbId: '471100990', status: 'active' })
    await s.booking.adjustStay(villa.id, '2026-11-19', '2026-11-21')
    expect(labels((await s.booking.detail(villa.id)).nights)).toEqual(['Villa rate', 'Airbnb listing'])
  })

  it('refuses a hotel room with no rate plan, and prices it once it joins a room type', async () => {
    const base = { villaId: 'vil-saka', code: 'SK-09', name: 'Saka 9', bedrooms: 1, nightlyRate: 1_500_000, status: 'active' as const, amenities: [], ...unitSetupDefaults(1) }
    const { unit, newPlan } = await s.property.createUnit({ ...base, groupId: null })
    expect(newPlan).toBeNull()
    await expect(quote(unit.id, '2026-11-19', '2026-11-21')).rejects.toMatchObject({ code: 'NO_PRICE', message: 'SK-09 has no rate plan. Add one on the room type page.' })
    await expect(direct(unit.id, '2026-11-19', '2026-11-21')).rejects.toMatchObject({ code: 'NO_PRICE' })
    expect((await s.property.unit(unit.id)).priceList).toBeNull()

    const group = await s.property.createGroup({ villaId: 'vil-saka', name: 'Saka garden', interchangeable: false, operatorAssigns: false, kind: 'room' })
    expect((await s.property.roomType(group.id)).plan).toBeNull()
    const moved = await s.property.updateUnit(unit.id, { ...base, groupId: group.id })
    expect(moved.newPlan).toMatchObject({ weekdayRate: 1_500_000, weekendRate: 1_800_000 })
    expect((await direct(unit.id, '2026-11-19', '2026-11-21')).listRates).toEqual([1_500_000, 1_800_000])
    expect((await s.property.unit(unit.id)).priceList).toBe('plan')
  })

  it('prices rooms and villas of a mixed property each by their own rule', async () => {
    const { villa } = await s.property.villa('vil-saka')
    const { id: _id, ...input } = villa
    await s.property.updateVilla(villa.id, { ...input, operation: 'mixed' })
    const garden = await s.property.createGroup({ villaId: villa.id, name: 'Garden villas', interchangeable: false, operatorAssigns: false, kind: 'villa' })
    const { unit } = await s.property.createUnit({ villaId: villa.id, groupId: garden.id, code: 'SK-10', name: 'Garden villa', bedrooms: 2, nightlyRate: 3_000_000, status: 'active', amenities: [], ...unitSetupDefaults(2) })
    expect(await quote(unit.id, '2026-11-19', '2026-11-21')).toMatchObject({ priceList: 'villa', listRates: [3_000_000, 3_000_000] })
    expect(await quote('unit-sk-01', '2026-11-19', '2026-11-21')).toMatchObject({ priceList: 'plan', listRates: [1_850_000, 2_200_000] })
  })

  it('lets only people who may edit property change a plan, and shows it on the room type page', async () => {
    const page = await s.property.roomType('grp-karang-cliff')
    expect(page.units.map((u) => [u.unit.code, u.priceList])).toEqual([['KR-01', 'listing'], ['KR-02', 'listing'], ['KR-03', 'villa']])
    expect(page.nights).toHaveLength(14)
    await signIn('dian')
    await expect(s.property.saveRatePlan('grp-saka-standard', { weekdayRate: 1, weekendRate: 1, seasons: [] })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await signIn('kadek')
    await expect(s.property.saveRatePlan('grp-saka-standard', { weekdayRate: 0, weekendRate: 1, seasons: [] })).rejects.toMatchObject({ errors: { weekdayRate: 'Enter the weekday rate in whole rupiah.' } })
    const saved = await s.property.saveRatePlan('grp-saka-standard', { weekdayRate: 1_800_000, weekendRate: 2_100_000, seasons: [{ name: ' Peak ', from: '11-01', to: '11-30', kind: 'fixed', value: 2_400_000 }] })
    expect(saved.seasons[0]?.name).toBe('Peak')
    expect((await quote('unit-sk-01', '2026-11-19', '2026-11-20'))?.nights[0]).toMatchObject({ rate: 2_400_000, source: { kind: 'plan', name: 'Peak' } })
    expect((await s.access.audit()).entries[0]).toMatchObject({ entity: 'rate_plan', userName: 'Kadek Ariani' })
  })
})
