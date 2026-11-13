import type { IsoDate } from '@/lib/dates'
import { findById, RuleError } from './errors'
import { defaultRatePlan, validateRatePlan, type RatePlanInput } from './ratePlan'

export interface Location {
  id: string
  name: string
  /** Regency and island, shown under the name. */
  area: string
}

/** A picture on a villa or unit: an uploaded image file and its caption. The first photo is the cover. */
export interface Photo {
  fileId: string
  caption: string
}
export const MAX_PHOTOS = 20

export type CancellationPolicy = 'flexible' | 'moderate' | 'strict' | 'non_refundable'
export const CANCELLATION_POLICIES: readonly CancellationPolicy[] = ['flexible', 'moderate', 'strict', 'non_refundable']
export const CANCELLATION_LABEL: Record<CancellationPolicy, string> = { flexible: 'Flexible', moderate: 'Moderate', strict: 'Strict', non_refundable: 'Non-refundable' }
/** The policy in guest words, for the villa page and the website. */
export const CANCELLATION_TEXT: Record<CancellationPolicy, string> = {
  flexible: 'Full refund up to 1 day before arrival.',
  moderate: 'Full refund up to 5 days before arrival.',
  strict: '50 percent refund up to 14 days before arrival.',
  non_refundable: 'No refund once the booking is confirmed.',
}

export type DepositKind = 'none' | 'percent' | 'fixed'
export const DEPOSIT_KINDS: readonly DepositKind[] = ['none', 'percent', 'fixed']
export const DEPOSIT_LABEL: Record<DepositKind, string> = { none: 'No deposit', percent: 'Percent of the stay', fixed: 'Fixed amount' }

/** What guests and the desk need to know about a villa beyond its name: where, when, the rules and the bank. */
export interface VillaProfile {
  address: string
  /** Both or neither. */
  lat: number | null
  lng: number | null
  phone: string
  email: string
  /** "HH:MM" in the villa's local time. */
  checkInTime: string
  checkOutTime: string
  /** NIB or Pondok Wisata permit. */
  licenseNo: string
  bankName: string
  bankAccountNo: string
  bankAccountName: string
  houseRules: string
  cancellationPolicy: CancellationPolicy
  depositKind: DepositKind
  /** Percent 1 to 100, rupiah above 0, or 0 when there is no deposit. */
  depositValue: number
  photos: readonly Photo[]
}

/** How a property runs: a hotel of rooms, villas rented as units, or both. */
export type Operation = 'villa' | 'hotel' | 'mixed'
export const OPERATIONS: readonly Operation[] = ['hotel', 'villa', 'mixed']
export const OPERATION_LABEL: Record<Operation, string> = { villa: 'Villa', hotel: 'Hotel', mixed: 'Hotel and villas' }
export const OPERATION_TEXT: Record<Operation, string> = {
  hotel: 'Rooms on floors, sold by room type. Housekeeping serves every room in house each day.',
  villa: 'Villas or units rented one by one, and the whole villa when you allow it.',
  mixed: 'Hotel rooms and villas on one property; each room type says which it holds.',
}

/** A room type holds hotel rooms or villas. */
export type UnitKind = 'room' | 'villa'
const UNIT_KINDS: readonly UnitKind[] = ['room', 'villa']
export const UNIT_KIND_LABEL: Record<UnitKind, string> = { room: 'Hotel rooms', villa: 'Villas' }
/** The heading of a kind's share in a split revenue figure. */
export const KIND_PLURAL: Record<UnitKind, string> = { room: 'Rooms', villa: 'Villas' }

export const MAX_STAYOVER_EVERY = 7
/** Days between stayover cleans when the property does not say: a hotel and a mixed property daily, a villa never. */
export const defaultStayoverEvery = (operation: Operation) => (operation === 'villa' ? 0 : 1)
/** A hotel takes no security deposit at check-in by default; villas and mixed properties do. */
export const defaultDepositOnCheckIn = (operation: Operation) => operation !== 'hotel'
/** Nights a new room type asks at least: one for hotel rooms, two for villas. */
export const defaultMinStay = (kind: UnitKind) => (kind === 'villa' ? 2 : 1)
export const MAX_MIN_STAY = 30

/** The kind a room type gets when nothing picks one: rooms in a hotel, villas otherwise. */
export const defaultKind = (operation: Operation): UnitKind => (operation === 'hotel' ? 'room' : 'villa')

/** How the property operates, on the villa record. */
const VILLA_OPERATION_DEFAULTS = { operation: 'villa', stayoverEvery: 0, wholeRental: false, wholeNightlyRate: 0, depositOnCheckIn: true, lateCheckoutFee: 0 } as const satisfies VillaOperation

export interface VillaOperation {
  operation: Operation
  /** Days between stayover cleans for a guest in house, 0 to 7; 0 means none. */
  stayoverEvery: number
  /** The villa may be rented whole; never in a hotel. */
  wholeRental: boolean
  /** Rupiah a night for the whole villa; 0 sums its villas' own prices. */
  wholeNightlyRate: number
  /** The check-in form asks a security deposit; in a mixed property only for its villas. */
  depositOnCheckIn: boolean
  /** Rupiah a late check-out costs; a mixed property charges it on rooms only. */
  lateCheckoutFee: number
}

/** A new villa record's profile and operation, before anyone fills it in. */
export const VILLA_PROFILE_DEFAULTS: VillaProfile & VillaOperation = {
  ...VILLA_OPERATION_DEFAULTS,
  address: '',
  lat: null,
  lng: null,
  phone: '',
  email: '',
  checkInTime: '14:00',
  checkOutTime: '12:00',
  licenseNo: '',
  bankName: '',
  bankAccountNo: '',
  bankAccountName: '',
  houseRules: '',
  cancellationPolicy: 'moderate',
  depositKind: 'none',
  depositValue: 0,
  photos: [],
}

export interface Villa extends VillaProfile, VillaOperation {
  id: string
  locationId: string
  code: string
  name: string
  description: string
  /** Shared facilities, from VILLA_FACILITIES or free text. */
  facilities: readonly string[]
}

/** Google Maps at the villa's pin, or null without one. */
export const mapLink = (v: Pick<VillaProfile, 'lat' | 'lng'>) => (v.lat === null || v.lng === null ? null : `https://www.google.com/maps/search/?api=1&query=${v.lat},${v.lng}`)

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

export type UnitStatus = 'active' | 'cleaning' | 'maintenance' | 'inactive'
export const UNIT_STATUSES: readonly UnitStatus[] = ['active', 'cleaning', 'maintenance', 'inactive']
export const UNIT_STATUS_LABEL: Record<UnitStatus, string> = { active: 'Active', cleaning: 'Cleaning', maintenance: 'Maintenance', inactive: 'Inactive' }

/** Units with the same design. When `interchangeable`, a booking may move between them. */
export interface UnitGroup {
  id: string
  villaId: string
  name: string
  interchangeable: boolean
  /** Guests book the room type; the operator assigns the unit. Implies interchangeable. */
  operatorAssigns: boolean
  /** Hotel rooms or villas; a hotel has only rooms, a villa property only villas. */
  kind: UnitKind
}

export type BedType = 'king' | 'queen' | 'double' | 'twin' | 'single' | 'sofa_bed' | 'bunk'
export const BED_TYPES: readonly BedType[] = ['king', 'queen', 'double', 'twin', 'single', 'sofa_bed', 'bunk']
export const BED_LABEL: Record<BedType, string> = { king: 'King', queen: 'Queen', double: 'Double', twin: 'Twin', single: 'Single', sofa_bed: 'Sofa bed', bunk: 'Bunk' }
export interface Bed {
  type: BedType
  count: number
}
/** "1 king, 2 single". */
export const bedsLabel = (beds: readonly Bed[]) => beds.map((b) => `${b.count} ${BED_LABEL[b.type].toLowerCase()}`).join(', ')

export type UnitView = '' | 'garden' | 'pool' | 'ocean' | 'rice_field' | 'jungle' | 'mountain' | 'city'
export const UNIT_VIEWS: readonly UnitView[] = ['', 'garden', 'pool', 'ocean', 'rice_field', 'jungle', 'mountain', 'city']
export const VIEW_LABEL: Record<UnitView, string> = { '': 'Not set', garden: 'Garden', pool: 'Pool', ocean: 'Ocean', rice_field: 'Rice field', jungle: 'Jungle', mountain: 'Mountain', city: 'City' }
export const MAX_EXTRA_BEDS = 4

/** Who and what a unit sleeps, its size, view and photos. */
export interface UnitSetup {
  maxAdults: number
  maxChildren: number
  beds: readonly Bed[]
  sizeSqm: number | null
  view: UnitView
  extraBeds: number
  /** Rupiah a night per extra bed; 0 without extra beds. */
  extraBedRate: number
  photos: readonly Photo[]
  /** The floor a hotel room is on, for example "2" or "G"; empty for villas. */
  floor: string
}
export const MAX_FLOOR = 10
const FLOOR_ERROR = `A floor is at most ${MAX_FLOOR} characters, for example 2 or G.`

/** Two adults and one child a bedroom: what the API gives units saved before capacity existed. */
export const unitSetupDefaults = (bedrooms: number): UnitSetup => ({ maxAdults: Math.max(1, bedrooms * 2), maxChildren: Math.max(0, bedrooms), beds: [], sizeSqm: null, view: '', extraBeds: 0, extraBedRate: 0, photos: [], floor: '' })

export interface Unit extends UnitSetup {
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
  /** Why the unit has its current status and when it should be back; set by a status change only. */
  statusReason: string
  statusUntil: IsoDate | null
  /** The villa's default host or butler, an employee allocated to it; villas only. */
  hostId?: string | null
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
export interface VillaInput extends VillaProfile, VillaOperation {
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
  operatorAssigns: boolean
  kind: UnitKind
}
export interface UnitInput extends UnitSetup {
  villaId: string
  groupId: string | null
  code: string
  name: string
  bedrooms: number
  nightlyRate: number
  status: UnitStatus
  amenities: readonly string[]
  /** Sent with a status change: the reason is required for maintenance or inactive. */
  statusReason?: string
  statusUntil?: IsoDate | null
  hostId?: string | null
}

/** A room in the property wizard: the group is named by its index in the wizard, not by an id yet. */
export interface WizardRoom {
  code: string
  name: string
  bedrooms: number
  nightlyRate: number
  /** Null sells the room on its own: the wizard gives it a room type of its own. */
  groupIndex: number | null
  amenities: readonly string[]
  /** Capacity; left out, it follows unitSetupDefaults(bedrooms). */
  maxAdults?: number
  maxChildren?: number
  /** The rate plan of the room's own type, when it has no shared one. */
  plan?: RatePlanInput
  /** A hotel room's floor. */
  floor?: string
  beds?: readonly Bed[]
  extraBeds?: number
  extraBedRate?: number
}

/** The setup a wizard room saves with. */
export const wizardRoomSetup = (r: WizardRoom): UnitSetup => ({ ...unitSetupDefaults(r.bedrooms), floor: (r.floor ?? '').trim(), ...(r.beds ? { beds: r.beds } : {}), ...(r.extraBeds === undefined ? {} : { extraBeds: r.extraBeds, extraBedRate: r.extraBedRate ?? 0 }), ...(r.maxAdults === undefined ? {} : { maxAdults: r.maxAdults }), ...(r.maxChildren === undefined ? {} : { maxChildren: r.maxChildren }) })

export interface WizardGroup {
  name: string
  interchangeable: boolean
  operatorAssigns?: boolean
  plan?: RatePlanInput
  /** Left out, the property's default kind: rooms in a hotel, villas otherwise. */
  kind?: UnitKind
  /** Nights a stay needs at least; left out, the kind's default. */
  minStay?: number
}

/** Everything the New property wizard saves in one go. */
export interface PropertyInput {
  villa: VillaInput
  groups: readonly WizardGroup[]
  rooms: readonly WizardRoom[]
}

/** A room type the wizard creates, with the rooms in it and the plan that prices them. `key` is `g0` for a shared type, `r2` for a room's own. */
export interface WizardType {
  key: string
  name: string
  interchangeable: boolean
  operatorAssigns: boolean
  kind: UnitKind
  minStay: number
  plan: RatePlanInput
  rooms: number[]
}

/**
 * The room types a property gets: each shared type, then one of its own for every room without one, so
 * every type carries a rate plan. A plan left out starts from the first room's base price.
 */
export function wizardTypes(input: PropertyInput): WizardType[] {
  const firstRate = input.rooms[0]?.nightlyRate ?? 0
  const own = defaultKind(input.villa.operation)
  const shared = input.groups.map((g, i): WizardType => {
    const rooms = input.rooms.flatMap((r, j) => (r.groupIndex === i ? [j] : []))
    const base = input.rooms[rooms[0] ?? -1]?.nightlyRate ?? firstRate
    return { key: `g${i}`, name: g.name.trim(), interchangeable: g.interchangeable, operatorAssigns: (g.operatorAssigns ?? (g.kind ?? own) === 'room') && g.interchangeable, kind: g.kind ?? own, minStay: g.minStay ?? defaultMinStay(g.kind ?? own), plan: g.plan ?? defaultRatePlan(base), rooms }
  })
  const single = input.rooms.flatMap((r, j): WizardType[] =>
    r.groupIndex === null ? [{ key: `r${j}`, name: r.name.trim(), interchangeable: false, operatorAssigns: false, kind: own, minStay: defaultMinStay(own), plan: r.plan ?? defaultRatePlan(r.nightlyRate), rooms: [j] }] : [],
  )
  return [...shared, ...single]
}

/** Field errors keyed `villa.code`, `groups.0.name`, `rooms.2.code`, `plans.g0.weekdayRate`, or `rooms` when the list is empty. */
export function validateProperty(input: PropertyInput, villas: readonly Villa[], units: readonly Unit[]): Record<string, string> {
  const errors: Record<string, string> = {}
  for (const [k, v] of Object.entries(validateVilla(input.villa, villas))) if (v) errors[`villa.${k}`] = v
  input.groups.forEach((g, i) => {
    if (g.name.trim().length < 2) errors[`groups.${i}.name`] = 'Enter the room type name.'
    const kind = kindError(input.villa.operation, g.kind ?? defaultKind(input.villa.operation))
    if (kind) errors[`groups.${i}.kind`] = kind
    if (g.minStay !== undefined && (!Number.isInteger(g.minStay) || g.minStay < 1 || g.minStay > MAX_MIN_STAY)) errors[`groups.${i}.minStay`] = `From 1 to ${MAX_MIN_STAY} nights.`
  })
  if (input.rooms.length === 0) errors.rooms = 'Add at least one room.'
  const seen = new Set<string>()
  input.rooms.forEach((r, i) => {
    if (!UNIT_CODE.test(r.code)) errors[`rooms.${i}.code`] = 'A code is the property code, a dash and two to four digits, for example SK-09 or HT-201.'
    else if (input.villa.code && !r.code.startsWith(`${input.villa.code}-`)) errors[`rooms.${i}.code`] = `Code must start with ${input.villa.code}-.`
    else if (seen.has(r.code)) errors[`rooms.${i}.code`] = `${r.code} is listed twice.`
    else if (units.some((u) => u.code === r.code)) errors[`rooms.${i}.code`] = `${r.code} is already used.`
    seen.add(r.code)
    if (r.name.trim().length < 2) errors[`rooms.${i}.name`] = 'Enter the room name.'
    if (!Number.isInteger(r.bedrooms) || r.bedrooms < 1) errors[`rooms.${i}.bedrooms`] = 'At least one bedroom.'
    if (!Number.isInteger(r.nightlyRate) || r.nightlyRate <= 0) errors[`rooms.${i}.nightlyRate`] = 'Enter the nightly rate.'
    if (r.groupIndex !== null && !input.groups[r.groupIndex]) errors[`rooms.${i}.groupIndex`] = 'Pick a room type from the list.'
    if ((r.floor ?? '').trim().length > MAX_FLOOR) errors[`rooms.${i}.floor`] = FLOOR_ERROR
    for (const [k, v] of Object.entries(validateUnitSetup(wizardRoomSetup(r)))) if (v) errors[`rooms.${i}.${k}`] = v
  })
  for (const t of wizardTypes(input)) for (const [k, v] of Object.entries(validateRatePlan(t.plan))) errors[`plans.${t.key}.${k}`] = v
  return errors
}

type Errors<T> = Partial<Record<keyof T, string>>
const CODE = /^[A-Z]{2,4}$/
/** The villa code, a dash and a number: SK-01 for a villa, SK-201 for a hotel room on floor 2. */
const UNIT_CODE = /^[A-Z]{2,4}-\d{2,4}$/

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
  return { ...errors, ...validateVillaProfile(input), ...validateOperation(input) }
}

export function validateOperation(o: VillaOperation): Partial<Record<keyof VillaOperation, string>> {
  const errors: Partial<Record<keyof VillaOperation, string>> = {}
  if (!OPERATIONS.includes(o.operation)) errors.operation = 'Pick how the property operates.'
  if (!Number.isInteger(o.stayoverEvery) || o.stayoverEvery < 0 || o.stayoverEvery > MAX_STAYOVER_EVERY) errors.stayoverEvery = `From 0 to ${MAX_STAYOVER_EVERY} days; 0 means no stayover clean.`
  if (o.operation === 'hotel' && o.wholeRental) errors.wholeRental = 'A hotel is not rented whole.'
  if (!Number.isInteger(o.wholeNightlyRate) || o.wholeNightlyRate < 0) errors.wholeNightlyRate = 'Enter the whole villa price in whole rupiah, or 0.'
  if (!Number.isInteger(o.lateCheckoutFee) || o.lateCheckoutFee < 0) errors.lateCheckoutFee = 'Enter the late check-out fee in whole rupiah, or 0.'
  return errors
}

/** GROUP_KIND: a hotel holds only rooms and a villa property only villas; a mixed property holds either. */
export function kindError(operation: Operation, kind: UnitKind): string | null {
  if (kind !== 'room' && kind !== 'villa') return 'Pick rooms or villas.'
  if (operation === 'hotel' && kind !== 'room') return 'A Hotel only has rooms.'
  if (operation === 'villa' && kind !== 'villa') return 'A Villa only has villas.'
  return null
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
export const MAX_HOUSE_RULES = 4000

export function validateVillaProfile(p: VillaProfile): Errors<VillaProfile> {
  const errors: Errors<VillaProfile> = {}
  if ((p.lat === null) !== (p.lng === null)) errors.lat = 'Enter both latitude and longitude, or neither.'
  else if (p.lat !== null && p.lng !== null) {
    if (!Number.isFinite(p.lat) || p.lat < -90 || p.lat > 90) errors.lat = 'Latitude runs from -90 to 90.'
    if (!Number.isFinite(p.lng) || p.lng < -180 || p.lng > 180) errors.lng = 'Longitude runs from -180 to 180.'
  }
  if (p.email.trim() && !EMAIL.test(p.email.trim())) errors.email = 'Enter a valid email, or leave it empty.'
  if (!TIME.test(p.checkInTime)) errors.checkInTime = 'Enter the time as HH:MM.'
  if (!TIME.test(p.checkOutTime)) errors.checkOutTime = 'Enter the time as HH:MM.'
  else if (TIME.test(p.checkInTime) && p.checkOutTime >= p.checkInTime) errors.checkOutTime = 'Check-out must be earlier than check-in.'
  if (p.bankAccountNo && !/^\d+$/.test(p.bankAccountNo)) errors.bankAccountNo = 'Digits only.'
  if (p.houseRules.length > MAX_HOUSE_RULES) errors.houseRules = `Keep the house rules under ${MAX_HOUSE_RULES} characters.`
  if (!CANCELLATION_POLICIES.includes(p.cancellationPolicy)) errors.cancellationPolicy = 'Pick a cancellation policy.'
  if (p.depositKind === 'none' && p.depositValue !== 0) errors.depositValue = 'No deposit means 0.'
  if (p.depositKind === 'percent' && (!Number.isInteger(p.depositValue) || p.depositValue < 1 || p.depositValue > 100)) errors.depositValue = 'Enter a percent from 1 to 100.'
  if (p.depositKind === 'fixed' && (!Number.isInteger(p.depositValue) || p.depositValue <= 0)) errors.depositValue = 'Enter the deposit in whole rupiah.'
  return errors
}

export function validateUnitSetup(u: UnitSetup): Errors<UnitSetup> {
  const errors: Errors<UnitSetup> = {}
  if (!Number.isInteger(u.maxAdults) || u.maxAdults < 1) errors.maxAdults = 'At least one adult.'
  if (!Number.isInteger(u.maxChildren) || u.maxChildren < 0) errors.maxChildren = 'Zero or more children.'
  const types = new Set<BedType>()
  for (const b of u.beds) {
    if (!BED_TYPES.includes(b.type)) errors.beds = 'Pick a bed type from the list.'
    else if (types.has(b.type)) errors.beds = `${BED_LABEL[b.type]} is listed twice; add to its count instead.`
    else if (!Number.isInteger(b.count) || b.count < 1) errors.beds = 'Each bed row needs at least one bed.'
    types.add(b.type)
  }
  if (u.sizeSqm !== null && (!Number.isInteger(u.sizeSqm) || u.sizeSqm <= 0)) errors.sizeSqm = 'Enter the size in whole square metres, or leave it empty.'
  if (!UNIT_VIEWS.includes(u.view)) errors.view = 'Pick a view from the list.'
  if (!Number.isInteger(u.extraBeds) || u.extraBeds < 0 || u.extraBeds > MAX_EXTRA_BEDS) errors.extraBeds = `From 0 to ${MAX_EXTRA_BEDS} extra beds.`
  else if (u.extraBeds > 0 && (!Number.isInteger(u.extraBedRate) || u.extraBedRate <= 0)) errors.extraBedRate = 'Enter the extra bed price a night.'
  else if (u.extraBeds === 0 && u.extraBedRate !== 0) errors.extraBedRate = 'No extra beds means no extra bed price.'
  return errors
}

/** With the villa's operation, also the kind rule. */
export function validateGroup(input: GroupInput, operation?: Operation): Errors<GroupInput> {
  const errors: Errors<GroupInput> = {}
  if (!input.villaId) errors.villaId = 'Pick the villa.'
  if (input.name.trim().length < 2) errors.name = 'Enter the group name.'
  if (input.operatorAssigns && !input.interchangeable) errors.operatorAssigns = 'Only identical, interchangeable rooms can be sold as a room type.'
  const kind = operation ? kindError(operation, input.kind) : null
  if (kind) errors.kind = kind
  return errors
}

export function validateUnit(input: UnitInput, units: readonly Unit[], groups: readonly UnitGroup[], excludeId?: string): Errors<UnitInput> {
  const errors: Errors<UnitInput> = {}
  if (!input.villaId) errors.villaId = 'Pick the villa.'
  if (!UNIT_CODE.test(input.code)) errors.code = 'A code is the property code, a dash and two to four digits, for example SK-09 or HT-201.'
  else if (units.some((u) => u.code === input.code && u.id !== excludeId)) errors.code = `${input.code} is already used.`
  if (input.name.trim().length < 2) errors.name = 'Enter the unit name.'
  if (!Number.isInteger(input.bedrooms) || input.bedrooms < 1) errors.bedrooms = 'At least one bedroom.'
  if (!Number.isInteger(input.nightlyRate) || input.nightlyRate <= 0) errors.nightlyRate = 'Enter the nightly rate in whole rupiah.'
  if (input.groupId && groups.find((g) => g.id === input.groupId)?.villaId !== input.villaId) errors.groupId = 'The group belongs to another villa.'
  if ((input.floor ?? '').trim().length > MAX_FLOOR) errors.floor = FLOOR_ERROR
  return { ...errors, ...validateUnitSetup(input) }
}

/** What a unit sleeps, or the smallest of a room type's units. */
export type Capacity = Pick<UnitSetup, 'maxAdults' | 'maxChildren' | 'extraBeds'>
export interface Party {
  adults: number
  children: number
}

/** "4 + 2": adults and children, then any extra beds. */
export const capacityLabel = (c: Capacity) => `${c.maxAdults} + ${c.maxChildren}${c.extraBeds ? `, +${c.extraBeds} extra` : ''}`
/** Every guest the unit can take, extra beds included. */
export const sleeps = (c: Capacity) => c.maxAdults + c.maxChildren + c.extraBeds

/** A party fits when the adults fit the adult places plus extra beds, and everyone fits all places plus extra beds. */
export const fitsParty = (c: Capacity, p: Party) => p.adults <= c.maxAdults + c.extraBeds && p.adults + p.children <= c.maxAdults + c.maxChildren + c.extraBeds

/** Extra beds the party needs, for display only. */
export const extraBedsUsed = (c: Capacity, p: Party) => Math.max(0, p.adults + p.children - c.maxAdults - c.maxChildren)

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
export const capacityMessage = (name: string, c: Capacity) =>
  `${name} sleeps ${count(c.maxAdults, 'adult', 'adults')} and ${count(c.maxChildren, 'child', 'children')}${c.extraBeds > 0 ? `, plus ${count(c.extraBeds, 'extra bed', 'extra beds')}` : ''}.`

/** A room type sold by type promises only what its smallest unit sleeps. */
export function typeCapacity(units: readonly Capacity[]): Capacity | null {
  if (units.length === 0) return null
  const pick = units.reduce((min, u) => (sleeps(u) < sleeps(min) || (sleeps(u) === sleeps(min) && u.maxAdults < min.maxAdults) ? u : min))
  return { maxAdults: pick.maxAdults, maxChildren: pick.maxChildren, extraBeds: pick.extraBeds }
}

/** Refuses UNIT_CAPACITY when the party is known and does not fit. */
export function assertCapacity(name: string, c: Capacity, party: Party | null | undefined) {
  if (party && !fitsParty(c, party)) throw new RuleError('UNIT_CAPACITY', capacityMessage(name, c))
}

/** UNIT_CAPACITY for a known party: the room, or while none is assigned the smallest open room of the type. */
export function assertStayFits(catalog: Pick<Catalog, 'units' | 'unit' | 'group'>, unitId: string | null, groupId: string | null, party: Party | null | undefined) {
  if (!party) return
  if (unitId) return assertCapacity(catalog.unit(unitId).name, catalog.unit(unitId), party)
  const capacity = groupId ? typeCapacity(catalog.units.filter((u) => u.groupId === groupId && u.status !== 'inactive')) : null
  if (groupId && capacity) assertCapacity(catalog.group(groupId).name, capacity, party)
}

/** One status change on a unit, from a person, Housekeeping or Maintenance. */
export interface StatusChange {
  id: string
  unitId: string
  /** Empty on the first row of a unit created out of service. */
  from: UnitStatus | ''
  to: UnitStatus
  reason: string
  until: IsoDate | null
  by: string
  /** RFC 3339. */
  at: string
}

export interface StatusChangeInput {
  status: UnitStatus
  statusReason: string
  statusUntil: IsoDate | null
}

export interface StatusHistoryFilter {
  unitId?: string
  villaId?: string
  from?: IsoDate
  to?: IsoDate
}

/** Out of service: the unit cannot sell and needs a reason. */
export const outOfService = (status: UnitStatus) => status === 'maintenance' || status === 'inactive'

export function validateStatusChange(input: StatusChangeInput, today: IsoDate): Partial<Record<keyof StatusChangeInput, string>> {
  const errors: Partial<Record<keyof StatusChangeInput, string>> = {}
  if (!UNIT_STATUSES.includes(input.status)) errors.status = 'Pick a status.'
  if (outOfService(input.status) && input.statusReason.trim().length < 3) errors.statusReason = 'Say why the unit is out of service.'
  if (input.statusUntil !== null) {
    if (!outOfService(input.status)) errors.statusUntil = 'Only maintenance or inactive units take a return date.'
    else if (!/^\d{4}-\d{2}-\d{2}$/.test(input.statusUntil)) errors.statusUntil = 'Enter a date.'
    else if (input.statusUntil < today) errors.statusUntil = 'The return date cannot be in the past.'
  }
  return errors
}

/** Still out of service after the day it was due back. */
export const isOverdue = (u: Pick<Unit, 'status' | 'statusUntil'>, today: IsoDate) => outOfService(u.status) && u.statusUntil !== null && u.statusUntil < today

/** Narrows to a location, a villa or one unit. Empty means everything. */
export interface Scope {
  locationId?: string
  villaId?: string
  unitId?: string
  /** Only hotel rooms or only villas, on top of the place. */
  kind?: UnitKind
}

export function unitsIn(catalog: Catalog, scope: Scope): Unit[] {
  return catalog.units.filter((u) => {
    if (scope.kind && unitKindOf(catalog, u.id) !== scope.kind) return false
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

/** The kind of a unit: its room type's, else rooms in a hotel and villas elsewhere. */
const unitKind = (operation: Operation, group: Pick<UnitGroup, 'kind'> | null): UnitKind => group?.kind ?? defaultKind(operation)

/** Days between a unit's stayover cleans: the property's schedule, which in a mixed property serves only its rooms. */
const stayoverEveryFor = (villa: Pick<VillaOperation, 'operation' | 'stayoverEvery'>, kind: UnitKind) => (villa.operation === 'mixed' && kind !== 'room' ? 0 : villa.stayoverEvery)

/** The kind of a unit in the catalog: hotel rules for rooms, villa rules for villas. */
export function unitKindOf(catalog: Pick<Catalog, 'place'>, unitId: string): UnitKind {
  const { villa, group } = catalog.place(unitId)
  return unitKind(villa.operation, group)
}

/** The kinds a list of units holds, rooms first; a split figure needs both. */
export const kindsIn = (catalog: Pick<Catalog, 'place'>, unitIds: readonly string[]): UnitKind[] => UNIT_KINDS.filter((k) => unitIds.some((id) => unitKindOf(catalog, id) === k))

/** The words for one unit: a hotel room reads "Room SK-01", a villa by its code. */
export interface UnitTerms {
  unit: string
  units: string
  code: (code: string) => string
}
export const unitTerms = (kind: UnitKind): UnitTerms => (kind === 'room' ? { unit: 'Room', units: 'Rooms', code: (c) => `Room ${c}` } : { unit: 'Villa', units: 'Villas', code: (c) => c })

/** The words a property's screens use for the place and its units. */
export interface PropertyTerms extends UnitTerms {
  /** "Hotel", "Villa" or "Property". */
  place: string
  /** The heading over its unit groups: "Room types" in a hotel or a mixed property, "Unit groups" in a villa. */
  groups: string
}

export function propertyTerms(villa: Pick<VillaOperation, 'operation'> | null | undefined): PropertyTerms {
  if (villa?.operation === 'hotel') return { place: 'Hotel', groups: 'Room types', ...unitTerms('room') }
  if (villa?.operation === 'mixed') return { place: 'Property', groups: 'Room types', unit: 'Room or villa', units: 'Rooms and villas', code: (c) => c }
  return { place: 'Villa', groups: 'Unit groups', ...unitTerms('villa') }
}

/** The words for a unit in its place: the kind's noun, even inside a mixed property. */
export const placeTerms = (place: Pick<UnitPlace, 'villa' | 'group'>): UnitTerms => unitTerms(unitKind(place.villa.operation, place.group))

/** Whether the check-in form asks this unit's guest a security deposit. */
export const asksDeposit = (place: Pick<UnitPlace, 'villa' | 'group'>) => place.villa.depositOnCheckIn && (place.villa.operation !== 'mixed' || unitKind(place.villa.operation, place.group) === 'villa')

/** The villa-kind units a whole villa rental books: every one that is not inactive. */
export function wholeVillaUnits(catalog: Pick<Catalog, 'units' | 'groups'>, villa: Pick<Villa, 'id' | 'operation'>): Unit[] {
  return catalog.units.filter((u) => u.villaId === villa.id && u.status !== 'inactive' && unitKind(villa.operation, catalog.groups.find((g) => g.id === u.groupId) ?? null) === 'villa')
}

/** What the whole villa sleeps: every unit's places added up. */
export const wholeCapacity = (units: readonly Capacity[]): Capacity =>
  units.reduce((sum, u) => ({ maxAdults: sum.maxAdults + u.maxAdults, maxChildren: sum.maxChildren + u.maxChildren, extraBeds: sum.extraBeds + u.extraBeds }), { maxAdults: 0, maxChildren: 0, extraBeds: 0 })

/** Why the villa cannot be rented whole (WHOLE_VILLA_NOT_ALLOWED), or null when it can. */
export const wholeRentalProblem = (villa: Pick<Villa, 'name' | 'operation' | 'wholeRental'>) =>
  villa.operation === 'hotel' ? 'A hotel is not rented whole.' : villa.wholeRental ? null : `${villa.name} is not rented whole. Allow it in the villa's operation first.`

/** A whole villa price over its stays: even shares, the remainder on the first. */
export function splitEvenly(total: number, parts: number): number[] {
  if (parts <= 0) return []
  const share = Math.floor(total / parts)
  return Array.from({ length: parts }, (_, i) => (i === 0 ? total - share * (parts - 1) : share))
}

/**
 * The party over the units of a whole villa: adults one at a time across the units with room, then children
 * across the units that already have adults, then anywhere left. A unit nobody sleeps in gets null.
 */
export function splitParty(units: readonly Capacity[], party: Party): Array<Party | null> {
  const parts: Party[] = units.map(() => ({ adults: 0, children: 0 }))
  const place = (who: keyof Party, count: number, may: (p: Party) => boolean) => {
    let left = count
    for (let moved = true; left > 0 && moved; ) {
      moved = false
      units.forEach((u, i) => {
        const next = { ...parts[i]!, [who]: parts[i]![who] + 1 }
        if (left > 0 && may(parts[i]!) && fitsParty(u, next)) {
          parts[i] = next
          left--
          moved = true
        }
      })
    }
    return left
  }
  place('adults', party.adults, () => true)
  place('children', place('children', party.children, (p) => p.adults > 0), () => true)
  return parts.map((p) => (p.adults + p.children > 0 ? p : null))
}

/** The stayover schedule of one unit, read off its property and room type. */
export function stayoverEveryOf(catalog: Pick<Catalog, 'place'>, unitId: string) {
  const { villa, group } = catalog.place(unitId)
  return stayoverEveryFor(villa, unitKind(villa.operation, group))
}

/** The rules a unit kind brings, as the wizard shows them (Amendment 1 of the operation contract). */
export const KIND_RULES: Record<UnitKind, ReadonlyArray<readonly [string, string]>> = {
  room: [
    ['Sold', 'A room of a room type; the guest books the type and the front desk assigns the room number'],
    ['Rate', 'Per room type, from its rate plan'],
    ['Minimum stay', '1 night'],
    ['Deposit at check-in', 'Not asked'],
    ['Cleaning', 'Stayover on schedule, plus a departure clean'],
    ['Check-in', 'Front desk, room key card'],
    ['Reports', 'Occupancy, ADR and RevPAR per room night'],
  ],
  villa: [
    ['Sold', 'The whole private villa, by name'],
    ['Rate', "Per villa, its own nightly rate or Airbnb listing"],
    ['Minimum stay', '2 nights'],
    ['Deposit at check-in', 'Asked'],
    ['Cleaning', 'Departure clean only, unless a stayover schedule is set'],
    ['Check-in', 'Key or access code handover, house rules explained'],
    ['Reports', 'Occupancy, ADR and RevPAR per villa night'],
  ],
}
/** The kinds an operation may hold. */
export const OPERATION_KINDS: Record<Operation, readonly UnitKind[]> = { hotel: ['room'], villa: ['villa'], mixed: ['room', 'villa'] }

/** Floor 2 from 201: SK-201, SK-202, and so on. */
export const roomNumbers = (villaCode: string, start: number, count: number) => Array.from({ length: Math.max(0, count) }, (_, i) => `${villaCode}-${String(start + i).padStart(2, '0')}`)
