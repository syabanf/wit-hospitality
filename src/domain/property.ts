import { findById } from './errors'

export interface Location {
  id: string
  name: string
  /** Regency and island, shown under the name. */
  area: string
}

export interface Villa {
  id: string
  locationId: string
  code: string
  name: string
  description: string
  /** Shared facilities, from VILLA_FACILITIES or free text. */
  facilities: readonly string[]
}

export const VILLA_FACILITIES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'pool', label: 'Shared pool' },
  { id: 'wifi', label: 'Wi-Fi' },
  { id: 'parking', label: 'Parking' },
  { id: 'breakfast', label: 'Breakfast' },
  { id: 'restaurant', label: 'Restaurant or café' },
  { id: 'spa', label: 'Spa' },
  { id: 'gym', label: 'Gym' },
  { id: 'kids', label: 'Kids club' },
  { id: 'shuttle', label: 'Airport shuttle' },
  { id: 'security', label: '24-hour security' },
  { id: 'laundry', label: 'Laundry service' },
  { id: 'garden', label: 'Garden' },
]

export const UNIT_AMENITIES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'ac', label: 'Air conditioning' },
  { id: 'private-pool', label: 'Private pool' },
  { id: 'kitchen', label: 'Kitchen' },
  { id: 'bathtub', label: 'Bathtub' },
  { id: 'balcony', label: 'Balcony or terrace' },
  { id: 'tv', label: 'Smart TV' },
  { id: 'safe', label: 'Safe' },
  { id: 'minibar', label: 'Minibar' },
  { id: 'workspace', label: 'Workspace' },
  { id: 'outdoor-shower', label: 'Outdoor shower' },
]

export const facilityLabel = (id: string) => VILLA_FACILITIES.find((f) => f.id === id)?.label ?? id
export const amenityLabel = (id: string) => UNIT_AMENITIES.find((a) => a.id === id)?.label ?? id

export type UnitStatus = 'active' | 'maintenance' | 'inactive'
export const UNIT_STATUSES: readonly UnitStatus[] = ['active', 'maintenance', 'inactive']
export const UNIT_STATUS_LABEL: Record<UnitStatus, string> = { active: 'Active', maintenance: 'Maintenance', inactive: 'Inactive' }

/** Units with the same design. When `interchangeable`, a booking may move between them. */
export interface UnitGroup {
  id: string
  villaId: string
  name: string
  interchangeable: boolean
}

export interface Unit {
  id: string
  villaId: string
  groupId: string | null
  code: string
  name: string
  bedrooms: number
  nightlyRate: number
  status: UnitStatus
  /** In-room amenities, from UNIT_AMENITIES or free text. */
  amenities: readonly string[]
}

export interface UnitPlace {
  unit: Unit
  villa: Villa
  location: Location
  group: UnitGroup | null
}

/** A unit belongs to one villa and one location; the catalog resolves that chain once. */
export interface Catalog {
  locations: readonly Location[]
  villas: readonly Villa[]
  units: readonly Unit[]
  groups: readonly UnitGroup[]
  location(id: string): Location
  villa(id: string): Villa
  unit(id: string): Unit
  group(id: string): UnitGroup
  place(unitId: string): UnitPlace
  unitByCode(code: string): Unit
}

export function buildCatalog(locations: readonly Location[], villas: readonly Villa[], units: readonly Unit[], groups: readonly UnitGroup[]): Catalog {
  const location = (id: string) => findById(locations, id, 'location')
  const villa = (id: string) => findById(villas, id, 'villa')
  const unit = (id: string) => findById(units, id, 'unit')
  const group = (id: string) => findById(groups, id, 'unit group')
  return {
    locations,
    villas,
    units,
    groups,
    location,
    villa,
    unit,
    group,
    place(unitId) {
      const u = unit(unitId)
      const v = villa(u.villaId)
      return { unit: u, villa: v, location: location(v.locationId), group: u.groupId ? group(u.groupId) : null }
    },
    unitByCode(code) {
      const found = units.find((u) => u.code === code)
      if (!found) throw new Error(`Unknown unit code "${code}"`)
      return found
    },
  }
}

export interface LocationInput {
  name: string
  area: string
}
export interface VillaInput {
  locationId: string
  code: string
  name: string
  description: string
  facilities: readonly string[]
}
export interface GroupInput {
  villaId: string
  name: string
  interchangeable: boolean
}
export interface UnitInput {
  villaId: string
  groupId: string | null
  code: string
  name: string
  bedrooms: number
  nightlyRate: number
  status: UnitStatus
  amenities: readonly string[]
}

/** A room in the property wizard: the group is named by its index in the wizard, not by an id yet. */
export interface WizardRoom {
  code: string
  name: string
  bedrooms: number
  nightlyRate: number
  groupIndex: number | null
  amenities: readonly string[]
}

/** Everything the New property wizard saves in one go. */
export interface PropertyInput {
  villa: VillaInput
  groups: ReadonlyArray<{ name: string; interchangeable: boolean }>
  rooms: readonly WizardRoom[]
}

/** Field errors keyed `villa.code`, `groups.0.name`, `rooms.2.code`, or `rooms` when the list is empty. */
export function validateProperty(input: PropertyInput, villas: readonly Villa[], units: readonly Unit[]): Record<string, string> {
  const errors: Record<string, string> = {}
  for (const [k, v] of Object.entries(validateVilla(input.villa, villas))) if (v) errors[`villa.${k}`] = v
  input.groups.forEach((g, i) => {
    if (g.name.trim().length < 2) errors[`groups.${i}.name`] = 'Enter the room type name.'
  })
  if (input.rooms.length === 0) errors.rooms = 'Add at least one room.'
  const seen = new Set<string>()
  input.rooms.forEach((r, i) => {
    if (!UNIT_CODE.test(r.code)) errors[`rooms.${i}.code`] = 'Code is the villa code, a dash and two digits.'
    else if (input.villa.code && !r.code.startsWith(`${input.villa.code}-`)) errors[`rooms.${i}.code`] = `Code must start with ${input.villa.code}-.`
    else if (seen.has(r.code)) errors[`rooms.${i}.code`] = `${r.code} is listed twice.`
    else if (units.some((u) => u.code === r.code)) errors[`rooms.${i}.code`] = `${r.code} is already used.`
    seen.add(r.code)
    if (r.name.trim().length < 2) errors[`rooms.${i}.name`] = 'Enter the room name.'
    if (!Number.isInteger(r.bedrooms) || r.bedrooms < 1) errors[`rooms.${i}.bedrooms`] = 'At least one bedroom.'
    if (!Number.isInteger(r.nightlyRate) || r.nightlyRate <= 0) errors[`rooms.${i}.nightlyRate`] = 'Enter the nightly rate.'
    if (r.groupIndex !== null && !input.groups[r.groupIndex]) errors[`rooms.${i}.groupIndex`] = 'Pick a room type from the list.'
  })
  return errors
}

type Errors<T> = Partial<Record<keyof T, string>>
const CODE = /^[A-Z]{2,4}$/
const UNIT_CODE = /^[A-Z]{2,4}-\d{2}$/

export function validateLocation(input: LocationInput): Errors<LocationInput> {
  const errors: Errors<LocationInput> = {}
  if (input.name.trim().length < 2) errors.name = 'Enter the location name.'
  if (input.area.trim().length < 2) errors.area = 'Enter the regency and island, for example "Badung, Bali".'
  return errors
}

export function validateVilla(input: VillaInput, villas: readonly Villa[], excludeId?: string): Errors<VillaInput> {
  const errors: Errors<VillaInput> = {}
  if (!input.locationId) errors.locationId = 'Pick the location.'
  if (!CODE.test(input.code)) errors.code = 'A villa code is two to four capital letters, for example SK.'
  else if (villas.some((v) => v.code === input.code && v.id !== excludeId)) errors.code = `${input.code} is already used.`
  if (input.name.trim().length < 2) errors.name = 'Enter the villa name.'
  return errors
}

export function validateGroup(input: GroupInput): Errors<GroupInput> {
  const errors: Errors<GroupInput> = {}
  if (!input.villaId) errors.villaId = 'Pick the villa.'
  if (input.name.trim().length < 2) errors.name = 'Enter the group name.'
  return errors
}

export function validateUnit(input: UnitInput, units: readonly Unit[], groups: readonly UnitGroup[], excludeId?: string): Errors<UnitInput> {
  const errors: Errors<UnitInput> = {}
  if (!input.villaId) errors.villaId = 'Pick the villa.'
  if (!UNIT_CODE.test(input.code)) errors.code = 'A unit code is the villa code, a dash and two digits, for example SK-09.'
  else if (units.some((u) => u.code === input.code && u.id !== excludeId)) errors.code = `${input.code} is already used.`
  if (input.name.trim().length < 2) errors.name = 'Enter the unit name.'
  if (!Number.isInteger(input.bedrooms) || input.bedrooms < 1) errors.bedrooms = 'At least one bedroom.'
  if (!Number.isInteger(input.nightlyRate) || input.nightlyRate <= 0) errors.nightlyRate = 'Enter the nightly rate in whole rupiah.'
  if (input.groupId && groups.find((g) => g.id === input.groupId)?.villaId !== input.villaId) errors.groupId = 'The group belongs to another villa.'
  return errors
}

/** Narrows to a location, a villa or one unit. Empty means everything. */
export interface Scope {
  locationId?: string
  villaId?: string
  unitId?: string
}

export function unitsIn(catalog: Catalog, scope: Scope): Unit[] {
  return catalog.units.filter((u) => {
    if (scope.unitId) return u.id === scope.unitId
    if (scope.villaId) return u.villaId === scope.villaId
    if (scope.locationId) return catalog.villa(u.villaId).locationId === scope.locationId
    return true
  })
}

/** Active units a stay in `unitId` may move to: the same group, and the group allows it. */
export function interchangeableWith(catalog: Catalog, unitId: string): Unit[] {
  const { unit, group } = catalog.place(unitId)
  if (!group?.interchangeable) return []
  return catalog.units.filter((u) => u.groupId === group.id && u.id !== unit.id && u.status === 'active')
}
