import type { NightPrice } from './pricing'
import type { UnitKind } from './property'

/**
 * Rate packages: the ways a hotel room type sells beside Room only. A package sells at the plan's
 * nightly rate, a fixed nightly price or a percent off the plan, can add breakfast per person per
 * night, and a corporate rate belongs to one company's city ledger account. Villas sell at their
 * own price and take no package. Contract: api/docs/contracts/hotel-desk-contract.md section 4.
 */

export type PackageRate = 'plan' | 'fixed' | 'percent'
export const PACKAGE_RATES: readonly PackageRate[] = ['plan', 'fixed', 'percent']
export const PACKAGE_RATE_LABEL: Record<PackageRate, string> = { plan: 'Plan rate', fixed: 'Fixed nightly price', percent: 'Percent off the plan' }

export const MAX_PACKAGES = 12
/** The package every stay without one sells on; never stored. */
export const ROOM_ONLY = 'Room only'

export interface RatePackage {
  id: string
  name: string
  rate: PackageRate
  /** Rupiah a night for fixed, percent off for percent, 0 for plan. */
  value: number
  /** Rupiah per person per night, 0 without breakfast. */
  breakfast: number
  /** The company's city ledger account on a corporate rate. */
  accountId: string | null
}

/** A package from the form; one without an id is new. */
export type RatePackageInput = Omit<RatePackage, 'id'> & { id?: string }

/** validateRatePackages. `isCompany` reports whether an id is a city ledger account of kind company. */
export function validateRatePackages(pkgs: readonly RatePackageInput[], kind: UnitKind, isCompany: (id: string) => boolean): Record<string, string> {
  const errors: Record<string, string> = {}
  if (pkgs.length > MAX_PACKAGES) errors.packages = `Keep at most ${MAX_PACKAGES} packages.`
  if (pkgs.length > 0 && kind !== 'room') errors.packages = 'Packages are for hotel room types; a villa sells at its own price.'
  const seen: string[] = []
  pkgs.forEach((p, i) => {
    const key = `packages.${i}.`
    const name = p.name.trim()
    const lower = name.toLowerCase()
    if ([...name].length < 2) errors[`${key}name`] = 'Name the package.'
    else if (lower === ROOM_ONLY.toLowerCase()) errors[`${key}name`] = 'Room only is always offered; name this one differently.'
    else if (seen.includes(lower)) errors[`${key}name`] = `${name} is listed twice.`
    seen.push(lower)
    if (p.rate === 'fixed' && (!Number.isInteger(p.value) || p.value <= 0)) errors[`${key}value`] = 'Enter the nightly price in whole rupiah.'
    else if (p.rate === 'percent' && (!Number.isInteger(p.value) || p.value < 1 || p.value > 90)) errors[`${key}value`] = 'A whole percentage from 1 to 90.'
    else if (!PACKAGE_RATES.includes(p.rate)) errors[`${key}rate`] = 'Pick how the room is priced.'
    if (!Number.isInteger(p.breakfast) || p.breakfast < 0) errors[`${key}breakfast`] = 'Enter the breakfast price per person in whole rupiah, or zero.'
    else if (p.rate === 'plan' && p.breakfast === 0) errors[`${key}breakfast`] = 'Add breakfast or a rate; without either this is Room only.'
    const account = p.accountId?.trim()
    if (account && !isCompany(account)) errors[`${key}accountId`] = 'Pick a company account from the city ledger.'
  })
  return errors
}

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

/** Valid forms as the plan stores them: names trimmed, a plan rate's value 0, a new package named pkg-<slug>, -2, -3 on a clash. */
export function packagesFrom(input: readonly RatePackageInput[]): RatePackage[] {
  const taken = new Set(input.flatMap((p) => (p.id ? [p.id] : [])))
  return input.map((p) => {
    const name = p.name.trim()
    let id = p.id ?? ''
    if (!id) {
      const base = `pkg-${slug(name) || 'x'}`
      id = base
      for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
      taken.add(id)
    }
    const account = p.accountId?.trim()
    return { id, name, rate: p.rate, value: p.rate === 'plan' ? 0 : p.value, breakfast: p.breakfast, accountId: account || null }
  })
}

/** packageNight: a rate plan night through the stay's package. Nights no rate plan priced stay as they are. */
export function packageNight(pkg: Pick<RatePackage, 'name' | 'rate' | 'value'> | null | undefined, n: NightPrice): NightPrice {
  if (!pkg || n.source.kind !== 'plan') return n
  if (pkg.rate === 'fixed') return { ...n, rate: pkg.value, source: { kind: 'plan', name: pkg.name } }
  const rate = pkg.rate === 'percent' ? Math.round((n.rate * (100 - pkg.value)) / 100) : n.rate
  return { ...n, rate, source: { kind: 'plan', name: `${n.source.name}, ${pkg.name}` } }
}

/** One line about how a package prices, for pickers and the plan page. */
export function packageSummary(pkg: Pick<RatePackage, 'rate' | 'value' | 'breakfast' | 'accountId'>, money: (n: number) => string): string {
  const rate = pkg.rate === 'fixed' ? `${money(pkg.value)} a night` : pkg.rate === 'percent' ? `${pkg.value}% off the plan` : 'Plan rate'
  const parts = [rate, pkg.breakfast > 0 ? `breakfast ${money(pkg.breakfast)} per person` : 'no breakfast']
  if (pkg.accountId) parts.push('company rate')
  return parts.join(', ')
}

/** Who breakfast is charged for: the check-in record's party, else the booked party, else one. */
export function breakfastPersons(b: { arrival: { adults: number; children: number } | null; partySize?: { adults: number; children: number } }): number {
  if (b.arrival && b.arrival.adults + b.arrival.children >= 1) return b.arrival.adults + b.arrival.children
  if (b.partySize && b.partySize.adults + b.partySize.children >= 1) return b.partySize.adults + b.partySize.children
  return 1
}

/** The night audit's breakfast posting for night i (0 based) of n, or null without breakfast. */
export function breakfastLine(pkg: Pick<RatePackage, 'breakfast'> | null | undefined, persons: number, night: number, of: number): { amount: number; description: string } | null {
  if (!pkg || pkg.breakfast <= 0) return null
  return { amount: pkg.breakfast * persons, description: `Breakfast, night ${night + 1} of ${of}, ${persons} ${persons === 1 ? 'guest' : 'guests'}` }
}

export const BREAKFAST_CODE = 'BKF'
