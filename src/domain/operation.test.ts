import { describe, expect, it } from 'vitest'
import { wholeVillaTaken, validateWholeVilla } from './group'
import { stayoverDue } from './housekeeping'
import { minStayRestriction } from './restriction'
import {
  asksDeposit,
  buildCatalog,
  defaultDepositOnCheckIn,
  defaultMinStay,
  placeTerms,
  roomNumbers,
  kindError,
  propertyTerms,
  splitEvenly,
  splitParty,
  stayoverEveryOf,
  unitSetupDefaults,
  validateGroup,
  validateOperation,
  validateProperty,
  validateUnit,
  VILLA_PROFILE_DEFAULTS,
  wholeCapacity,
  wholeRentalProblem,
  wholeVillaUnits,
  wizardTypes,
  type Operation,
  type Unit,
  type UnitGroup,
  type Villa,
} from './property'

const villa = (id: string, operation: Operation, extra: Partial<Villa> = {}): Villa => ({ id, locationId: 'l1', code: id.toUpperCase(), name: `Place ${id}`, description: '', facilities: [], ...VILLA_PROFILE_DEFAULTS, operation, ...extra })
const unit = (id: string, villaId: string, groupId: string | null, status: Unit['status'] = 'active'): Unit => ({ id, villaId, groupId, code: id.toUpperCase(), name: id, bedrooms: 1, nightlyRate: 1_000_000, status, amenities: [], ...unitSetupDefaults(1), statusReason: '', statusUntil: null })
const group = (id: string, villaId: string, kind: UnitGroup['kind']): UnitGroup => ({ id, villaId, name: id, interchangeable: true, operatorAssigns: false, kind })

describe('property operation', () => {
  it('validates the stayover schedule, whole rental and its price', () => {
    expect(validateOperation({ operation: 'villa', stayoverEvery: 0, wholeRental: true, wholeNightlyRate: 0, depositOnCheckIn: true })).toEqual({})
    expect(validateOperation({ operation: 'hotel', stayoverEvery: 8, wholeRental: true, wholeNightlyRate: -1, depositOnCheckIn: false })).toEqual({
      stayoverEvery: 'From 0 to 7 days; 0 means no stayover clean.',
      wholeRental: 'A hotel is not rented whole.',
      wholeNightlyRate: 'Enter the whole villa price in whole rupiah, or 0.',
    })
  })

  it('keeps rooms in a hotel and villas in a villa property; a mixed property takes either', () => {
    expect(kindError('hotel', 'villa')).toBe('A Hotel only has rooms.')
    expect(kindError('villa', 'room')).toBe('A Villa only has villas.')
    expect(kindError('mixed', 'room')).toBeNull()
    expect(validateGroup({ villaId: 'v', name: 'Deluxe', interchangeable: true, operatorAssigns: true, kind: 'villa' }, 'hotel')).toEqual({ kind: 'A Hotel only has rooms.' })
  })

  it('caps the floor at ten characters', () => {
    const input = { villaId: 'v1', groupId: null, code: 'HT-01', name: 'Room 1', bedrooms: 1, nightlyRate: 900_000, status: 'active' as const, amenities: [], ...unitSetupDefaults(1) }
    expect(validateUnit({ ...input, floor: 'Penthouse 12' }, [], []).floor).toMatch(/at most 10/)
    expect(validateUnit({ ...input, floor: 'G' }, [], []).floor).toBeUndefined()
  })

  it('sells a hotel wizard type by type, and checks each mixed type’s kind', () => {
    const rooms = [{ code: 'HT-01', name: 'Room 1', bedrooms: 1, nightlyRate: 900_000, groupIndex: 0, amenities: [], floor: '2' }]
    const hotel = { villa: { ...villa('ht', 'hotel'), code: 'HT' }, groups: [{ name: 'Deluxe', interchangeable: true }], rooms }
    expect(wizardTypes(hotel)[0]).toMatchObject({ kind: 'room', operatorAssigns: true })
    expect(wizardTypes({ ...hotel, villa: { ...hotel.villa, operation: 'villa' } })[0]).toMatchObject({ kind: 'villa', operatorAssigns: false })
    expect(validateProperty({ ...hotel, groups: [{ name: 'Deluxe', interchangeable: true, kind: 'villa' }] }, [], [])).toMatchObject({ 'groups.0.kind': 'A Hotel only has rooms.' })
  })

  it('names the place and its units by operation', () => {
    expect(propertyTerms(villa('a', 'hotel'))).toMatchObject({ place: 'Hotel', unit: 'Room', units: 'Rooms' })
    expect(propertyTerms(villa('a', 'hotel')).code('SK-01')).toBe('Room SK-01')
    expect(propertyTerms(villa('a', 'villa'))).toMatchObject({ place: 'Villa', unit: 'Villa', units: 'Villas' })
    expect(propertyTerms(villa('a', 'mixed'))).toMatchObject({ place: 'Property', unit: 'Room or villa', units: 'Rooms and villas' })
    expect(propertyTerms(villa('a', 'mixed')).code('MX-03')).toBe('MX-03')
  })
})

describe('room and villa foundations', () => {
  const mixed = villa('mx', 'mixed', { depositOnCheckIn: true })
  const room = group('rooms', 'mx', 'room')
  const villas = group('villas', 'mx', 'villa')

  it('asks the deposit of villa guests only in a mixed property, and follows the property elsewhere', () => {
    expect(asksDeposit({ villa: mixed, group: room })).toBe(false)
    expect(asksDeposit({ villa: mixed, group: villas })).toBe(true)
    expect(asksDeposit({ villa: villa('h', 'hotel', { depositOnCheckIn: false }), group: null })).toBe(false)
    expect(defaultDepositOnCheckIn('hotel')).toBe(false)
    expect(defaultDepositOnCheckIn('mixed')).toBe(true)
  })

  it('names a unit by its kind and numbers hotel rooms by floor', () => {
    expect(placeTerms({ villa: mixed, group: room }).code('MX-201')).toBe('Room MX-201')
    expect(placeTerms({ villa: mixed, group: villas }).unit).toBe('Villa')
    expect(roomNumbers('HT', 201, 3)).toEqual(['HT-201', 'HT-202', 'HT-203'])
  })

  it('starts villas at two nights and hotel rooms at one, as a stay restriction only when above one', () => {
    expect([defaultMinStay('room'), defaultMinStay('villa')]).toEqual([1, 2])
    expect(minStayRestriction('g1', 1)).toBeNull()
    expect(minStayRestriction('g1', 2)).toMatchObject({ rule: 'min_stay', nights: 2, yearly: true, from: '01-01', to: '12-31' })
  })
})

describe('stayover schedule', () => {
  it('cleans every n days after arrival, never on the arrival day or with 0', () => {
    expect(stayoverDue(1, '2026-10-01', '2026-10-01')).toBe(false)
    expect(stayoverDue(1, '2026-10-01', '2026-10-02')).toBe(true)
    expect([2, 3, 4, 5].map((d) => stayoverDue(2, '2026-10-01', `2026-10-0${d}`))).toEqual([false, true, false, true])
    expect(stayoverDue(0, '2026-10-01', '2026-10-03')).toBe(false)
  })

  it('serves only the rooms of a mixed property', () => {
    const mixed = villa('mx', 'mixed', { stayoverEvery: 1 })
    const cat = buildCatalog([{ id: 'l1', name: 'L', area: '' }], [mixed], [unit('r1', 'mx', 'rooms'), unit('v1', 'mx', 'villas'), unit('loose', 'mx', null)], [group('rooms', 'mx', 'room'), group('villas', 'mx', 'villa')])
    expect(['r1', 'v1', 'loose'].map((id) => stayoverEveryOf(cat, id))).toEqual([1, 0, 0])
  })
})

describe('whole villa rental', () => {
  const karang = villa('kr', 'mixed', { wholeRental: true })
  const units = [unit('a', 'kr', 'villas'), unit('b', 'kr', 'villas'), unit('c', 'kr', 'villas', 'inactive'), unit('r', 'kr', 'rooms')]
  const cat = buildCatalog([{ id: 'l1', name: 'L', area: '' }], [karang], units, [group('villas', 'kr', 'villa'), group('rooms', 'kr', 'room')])

  it('books every villa-kind unit that is not inactive, and only where allowed', () => {
    expect(wholeVillaUnits(cat, karang).map((u) => u.id)).toEqual(['a', 'b'])
    expect(wholeRentalProblem(karang)).toBeNull()
    expect(wholeRentalProblem({ ...karang, wholeRental: false })).toMatch(/not rented whole/)
    expect(wholeRentalProblem({ ...karang, operation: 'hotel' })).toBe('A hotel is not rented whole.')
  })

  it('splits the price evenly with the remainder on the first stay', () => {
    expect(splitEvenly(9_000_000, 3)).toEqual([3_000_000, 3_000_000, 3_000_000])
    expect(splitEvenly(10_000_001, 3)).toEqual([3_333_335, 3_333_333, 3_333_333])
    expect(splitEvenly(5, 0)).toEqual([])
  })

  it('adds up the capacity and spreads the party over the villas', () => {
    const caps = [{ maxAdults: 2, maxChildren: 1, extraBeds: 0 }, { maxAdults: 4, maxChildren: 2, extraBeds: 1 }]
    expect(wholeCapacity(caps)).toEqual({ maxAdults: 6, maxChildren: 3, extraBeds: 1 })
    expect(splitParty(caps, { adults: 5, children: 2 })).toEqual([{ adults: 2, children: 1 }, { adults: 3, children: 1 }])
    expect(splitParty(caps, { adults: 1, children: 1 })).toEqual([{ adults: 1, children: 1 }, null])
  })

  it('names the villas taken by a stay, a block or maintenance', () => {
    const stays = [{ id: 'bk', code: 'BK-1', unitId: 'a', unitAssigned: true, status: 'confirmed' as const, checkIn: '2026-11-02', checkOut: '2026-11-04' }]
    expect(wholeVillaTaken(wholeVillaUnits(cat, karang), '2026-11-01', '2026-11-03', stays, [])).toEqual(['A'])
    expect(wholeVillaTaken(wholeVillaUnits(cat, karang), '2026-11-04', '2026-11-06', stays, [])).toEqual([])
    expect(wholeVillaTaken([{ ...units[1]!, status: 'maintenance' }], '2026-11-04', '2026-11-06', [], [])).toEqual(['B'])
  })

  it('needs a lead guest, an adult and, on Airbnb, the price sold', () => {
    const base = { villaId: 'kr', guestId: 'g-1', newGuest: null, checkIn: '2026-11-01', checkOut: '2026-11-03', adults: 2, children: 0, source: 'direct' as const }
    expect(validateWholeVilla(base)).toEqual({})
    expect(validateWholeVilla({ ...base, guestId: null, adults: 0 })).toMatchObject({ guestId: expect.any(String), adults: 'At least one adult.' })
    expect(validateWholeVilla({ ...base, source: 'airbnb' })).toEqual({ 'price.nightly': 'Enter the nightly price Airbnb sold.' })
    expect(validateWholeVilla({ ...base, price: { nightly: 8_000_000, reason: '' } })).toEqual({ 'price.reason': 'Say why the whole villa gets this price.' })
  })
})
