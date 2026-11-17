import type { Booking } from '@/domain/booking'
import type { Catalog } from '@/domain/property'
import { packageNight, type RatePackage } from '@/domain/ratePackage'
import { soldNights } from '@/domain/ratePlan'
import { floorLabel, type Section } from '@/domain/section'

/** Villa Saka sells its standard rooms with breakfast and on a corporate rate for PT Nusa Retreats. */
export const SAKA_PACKAGES: RatePackage[] = [
  { id: 'pkg-with-breakfast', name: 'With breakfast', rate: 'plan', value: 0, breakfast: 150_000, accountId: null },
  { id: 'pkg-nusa-corporate', name: 'Nusa Retreats corporate', rate: 'fixed', value: 1_650_000, breakfast: 120_000, accountId: 'cl-nusa' },
]
export const PACKAGE_PLANS: Record<string, RatePackage[]> = { 'grp-saka-standard': SAKA_PACKAGES }

/** One section per floor of Saka. */
export function seedSections(catalog: Catalog): Section[] {
  const rooms = catalog.units.filter((u) => u.villaId === 'vil-saka').sort((a, b) => a.code.localeCompare(b.code))
  const floors = [...new Set(rooms.map((u) => u.floor))]
  return floors.map((floor) => ({ id: `sec-saka-${floor.toLowerCase() || 'none'}`, villaId: 'vil-saka', name: floorLabel(floor), unitIds: rooms.filter((u) => u.floor === floor).map((u) => u.id) }))
}

/**
 * A few Saka stays sold on packages: tonight's first arrival and the guest in house on breakfast,
 * tomorrow's room-type booking on the corporate rate billed to the company. They are repriced
 * through the package as the desk would have sold them.
 */
export function seedPackageStays(bookings: Booking[], catalog: Catalog, today: string) {
  const saka = (b: Booking) => catalog.unit(b.unitId).villaId === 'vil-saka' && b.source === 'direct' && !b.bookingGroupId
  const sell = (b: Booking | undefined, pkg: RatePackage) => {
    if (!b) return
    const nights = soldNights(b).map((n) => packageNight(pkg, n))
    Object.assign(b, { ratePackage: { ...pkg }, listRates: nights.map((n) => n.rate), listSources: nights.map((n) => n.source) })
  }
  const [breakfast, corporate] = SAKA_PACKAGES as [RatePackage, RatePackage]
  sell(bookings.find((b) => saka(b) && b.status === 'checked_in'), breakfast)
  sell(bookings.find((b) => saka(b) && b.status === 'confirmed' && b.checkIn === today && b.unitAssigned), breakfast)
  const company = bookings.find((b) => b.id === 'bk-2005')
  if (company) {
    sell(company, corporate)
    company.cityLedger = { accountId: 'cl-nusa', instruction: 'room', override: null }
  }
}
