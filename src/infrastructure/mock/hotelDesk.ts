import type { PropertyPort } from '@/application/ports'
import { can, ROLE_LABEL, type AuditAction, type User } from '@/domain/access'
import type { Booking } from '@/domain/booking'
import { findById, RuleError } from '@/domain/errors'
import { unitKindOf, type Unit } from '@/domain/property'
import { packagesFrom, validateRatePackages, type RatePackage, type RatePackageInput } from '@/domain/ratePackage'
import { SectionHotelOnly, sectionFrom, validateSection, type Section } from '@/domain/section'
import type { MockState } from './state'

/** The mock API's shared helpers the hotel desk tables need. */
export interface HotelDeskContext {
  s: MockState
  later: <T>(value: () => T) => Promise<T>
  copy: <T>(v: T) => T
  user: () => User
  refuse: (errors: Record<string, string | undefined>) => void
  newId: (prefix: string, text: string) => string
  log: (action: AuditAction, entity: string, entityId: string, summary: string, before?: Record<string, unknown> | null, after?: Record<string, unknown> | null) => void
}

const state = (x: Section) => ({ name: x.name, unitIds: x.unitIds.join(', ') })

/** Sections on the property port, as the API's /sections routes run them. */
export function createSectionPort({ s, later, copy, user, refuse, newId, log }: HotelDeskContext): Pick<PropertyPort, 'sections' | 'saveSection' | 'removeSection'> {
  const assertEditor = () => {
    const me = user()
    if (!can(s.permissions, me.role, 'property', 'edit')) throw new RuleError('FORBIDDEN', `${ROLE_LABEL[me.role]} cannot edit sections.`)
  }
  return {
    sections: () => later(() => copy(s.sections)),
    saveSection: (id, input) =>
      later(() => {
        assertEditor()
        const current = id ? findById(s.sections, id, 'section') : null
        const villa = s.catalog().villa(current?.villaId ?? input.villaId)
        const others = s.sections.filter((x) => x.villaId === villa.id && x.id !== id)
        try {
          refuse(validateSection(input, villa, s.units, (unitId) => unitKindOf(s.catalog(), unitId), others, current))
        } catch (e) {
          if (e instanceof SectionHotelOnly) throw new RuleError(e.code, e.message)
          throw e
        }
        const form = sectionFrom(input)
        if (current) {
          const before = state(current)
          Object.assign(current, { name: form.name, unitIds: form.unitIds })
          log('update', 'section', current.id, `Changed section ${current.name} of ${villa.name}: ${current.unitIds.length} rooms`, before, state(current))
          return copy(current)
        }
        const section: Section = { id: newId('sec', form.name), ...form }
        s.sections.push(section)
        log('create', 'section', section.id, `Added section ${section.name} to ${villa.name}: ${section.unitIds.length} rooms`, null, state(section))
        return copy(section)
      }),
    removeSection: (id) =>
      later(() => {
        assertEditor()
        const section = findById(s.sections, id, 'section')
        s.sections = s.sections.filter((x) => x.id !== id)
        s.sectionAssignments = s.sectionAssignments.filter((a) => a.sectionId !== id)
        log('delete', 'section', id, `Removed section ${section.name} from ${s.catalog().villa(section.villaId).name}`, state(section))
      }),
  }
}

/** The plan's packages after a save: the form's when it sent them, else the ones it has. */
export function savedPackages(s: MockState, groupId: string, input: readonly RatePackageInput[] | undefined, refuse: HotelDeskContext['refuse']): RatePackage[] {
  if (!input) return [...(s.ratePlans.find((p) => p.groupId === groupId)?.packages ?? [])]
  const group = findById(s.groups, groupId, 'room type')
  refuse(validateRatePackages(input, group.kind, (id) => s.cityLedgerAccounts.some((a) => a.id === id && a.kind === 'company')))
  return packagesFrom(input)
}

/**
 * The package a new stay sells on, in the contract's order: PACKAGE_NOT_ALLOWED on a channel stay
 * or a villa, PACKAGE_UNKNOWN, PACKAGE_ACCOUNT when a corporate rate is not billed to its account.
 */
export function packageFor(s: MockState, unit: Unit, source: Booking['source'], packageId: string | null | undefined, billedTo: string | undefined): RatePackage | null {
  if (!packageId) return null
  if (source !== 'direct' || unitKindOf(s.catalog(), unit.id) !== 'room') throw new RuleError('PACKAGE_NOT_ALLOWED', 'A rate package is for a direct stay in a hotel room.')
  const group = unit.groupId ? s.groups.find((g) => g.id === unit.groupId) : undefined
  const pkg = s.ratePlans.find((p) => p.groupId === unit.groupId)?.packages?.find((k) => k.id === packageId)
  if (!pkg) throw new RuleError('PACKAGE_UNKNOWN', `${group?.name ?? unit.code} has no such rate package.`)
  if (pkg.accountId && pkg.accountId !== billedTo) throw new RuleError('PACKAGE_ACCOUNT', `${pkg.name} is a company rate; bill the stay to its city ledger account.`)
  return { ...pkg }
}
