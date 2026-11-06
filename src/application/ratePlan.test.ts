import { beforeEach, describe, expect, it } from 'vitest'
import { fixedClock } from '@/infrastructure/clock'
import { createMockPorts } from '@/infrastructure/mock'
import { priceSourceLabel } from '@/domain/pricing'
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

describe('rate plans', () => {
  it('prices a unit without a live listing from its room type, and a listed unit from the listing as before', async () => {
    // KR-03 has no listing; 2026-11-19 is a Thursday.
    const kr = await quote('unit-kr-03', '2026-11-19', '2026-11-21')
    expect(kr?.priceList).toBe('plan')
    expect(kr?.listRates).toEqual([3_200_000, 3_850_000])
    expect(labels(kr?.nights ?? [])).toEqual(['Rate plan: Weekday', 'Rate plan: Weekend'])
    // SK-08's listing is paused, so the Saka plan sells it.
    expect((await quote('unit-sk-08', '2026-12-21', '2026-12-22'))?.nights[0]).toMatchObject({ rate: 2_590_000, source: { kind: 'plan', name: 'High season' } })
    const tr = await quote('unit-tr-04', '2026-11-19', '2026-11-22')
    expect(tr?.priceList).toBe('listing')
    expect(tr?.listRates).toEqual([1_650_000, 1_900_000, 1_900_000])
    expect(labels(tr?.nights ?? [])).toEqual(['Airbnb listing', 'Airbnb listing', 'Airbnb listing'])
  })

  it('keeps the price source on the booking and reprices new nights from the plan', async () => {
    const b = await direct('unit-kr-03', '2026-11-19', '2026-11-20')
    expect(b.total).toBe(3_200_000)
    const longer = await s.booking.adjustStay(b.id, '2026-11-19', '2026-11-21')
    expect(longer.listRates).toEqual([3_200_000, 3_850_000])
    expect(labels((await s.booking.detail(b.id)).nights)).toEqual(['Rate plan: Weekday', 'Rate plan: Weekend'])
  })

  it('refuses a direct stay with no listing and no rate plan, and starts a plan when the unit joins a room type', async () => {
    const base = { villaId: 'vil-saka', code: 'SK-09', name: 'Saka 9', bedrooms: 1, nightlyRate: 1_500_000, status: 'active' as const, amenities: [] }
    const { unit, newPlan } = await s.property.createUnit({ ...base, groupId: null })
    expect(newPlan).toBeNull()
    await expect(quote(unit.id, '2026-11-19', '2026-11-21')).rejects.toMatchObject({ code: 'NO_PRICE' })
    await expect(direct(unit.id, '2026-11-19', '2026-11-21')).rejects.toMatchObject({ code: 'NO_PRICE' })
    expect((await s.property.unit(unit.id)).priceList).toBeNull()

    const group = await s.property.createGroup({ villaId: 'vil-saka', name: 'Saka garden', interchangeable: false, operatorAssigns: false })
    expect((await s.property.roomType(group.id)).plan).toBeNull()
    const moved = await s.property.updateUnit(unit.id, { ...base, groupId: group.id })
    expect(moved.newPlan).toMatchObject({ weekdayRate: 1_500_000, weekendRate: 1_800_000 })
    expect((await direct(unit.id, '2026-11-19', '2026-11-21')).listRates).toEqual([1_500_000, 1_800_000])
    expect((await s.property.unit(unit.id)).priceList).toBe('plan')
  })

  it('lets only people who may edit property change a plan, and shows it on the room type page', async () => {
    const page = await s.property.roomType('grp-karang-cliff')
    expect(page.units.map((u) => [u.unit.code, u.priceList])).toEqual([['KR-01', 'listing'], ['KR-02', 'listing'], ['KR-03', 'plan']])
    expect(page.nights).toHaveLength(14)
    await signIn('dian')
    await expect(s.property.saveRatePlan('grp-karang-cliff', { weekdayRate: 1, weekendRate: 1, seasons: [] })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await signIn('kadek')
    await expect(s.property.saveRatePlan('grp-karang-cliff', { weekdayRate: 0, weekendRate: 1, seasons: [] })).rejects.toMatchObject({ errors: { weekdayRate: 'Enter the weekday rate in whole rupiah.' } })
    const saved = await s.property.saveRatePlan('grp-karang-cliff', { weekdayRate: 3_000_000, weekendRate: 3_600_000, seasons: [{ name: ' Peak ', from: '11-01', to: '11-30', kind: 'fixed', value: 4_000_000 }] })
    expect(saved.seasons[0]?.name).toBe('Peak')
    expect((await quote('unit-kr-03', '2026-11-19', '2026-11-20'))?.nights[0]).toMatchObject({ rate: 4_000_000, source: { kind: 'plan', name: 'Peak' } })
    expect((await s.access.audit()).entries[0]).toMatchObject({ entity: 'rate_plan', userName: 'Kadek Ariani' })
  })
})
