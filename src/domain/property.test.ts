import { describe, expect, it } from 'vitest'
import { assertCapacity, buildCatalog, capacityLabel, extraBedsUsed, fitsParty, interchangeableWith, isOverdue, mapLink, typeCapacity, unitsIn, validateStatusChange, validateUnit, validateUnitSetup, validateVilla, validateVillaProfile, type Unit, type UnitGroup, type Villa, unitSetupDefaults, VILLA_PROFILE_DEFAULTS } from './property'

const villas: Villa[] = [{ id: 'v1', locationId: 'l1', code: 'SK', name: 'Saka', description: '', facilities: [], ...VILLA_PROFILE_DEFAULTS }]
const groups: UnitGroup[] = [
  { id: 'g1', villaId: 'v1', name: 'Std', interchangeable: true, operatorAssigns: false },
  { id: 'g2', villaId: 'v2', name: 'Other villa', interchangeable: true, operatorAssigns: false },
]
const units: Unit[] = [
  { id: 'u1', villaId: 'v1', groupId: 'g1', code: 'SK-01', name: 'Saka 1', bedrooms: 1, nightlyRate: 1_000_000, status: 'active', amenities: [], ...unitSetupDefaults(1), statusReason: '', statusUntil: null },
  { id: 'u2', villaId: 'v1', groupId: 'g1', code: 'SK-02', name: 'Saka 2', bedrooms: 1, nightlyRate: 1_000_000, status: 'inactive', amenities: [], ...unitSetupDefaults(1), statusReason: '', statusUntil: null },
]

describe('property rules', () => {
  it('refuses a duplicate or malformed code and a group from another villa', () => {
    const base = { villaId: 'v1', groupId: 'g1', code: 'SK-01', name: 'Saka 9', bedrooms: 1, nightlyRate: 1_000_000, status: 'active' as const, amenities: [], ...unitSetupDefaults(1), statusReason: '', statusUntil: null }
    expect(validateUnit(base, units, groups).code).toMatch(/already used/)
    expect(validateUnit({ ...base, code: 'sk9' }, units, groups).code).toMatch(/two digits/)
    expect(validateUnit({ ...base, code: 'SK-09', groupId: 'g2' }, units, groups).groupId).toMatch(/another villa/)
    expect(validateUnit({ ...base, code: 'SK-01' }, units, groups, 'u1')).toEqual({})
    expect(validateVilla({ locationId: 'l1', code: 'SK', name: 'Dup', description: '', facilities: [], ...VILLA_PROFILE_DEFAULTS }, villas).code).toMatch(/already used/)
  })

  it('narrows units to a scope and keeps inactive units out of swaps', () => {
    const catalog = buildCatalog([{ id: 'l1', name: 'Canggu', area: 'Badung' }], villas, units, groups.slice(0, 1))
    expect(unitsIn(catalog, { locationId: 'l1' })).toHaveLength(2)
    expect(unitsIn(catalog, { unitId: 'u2' }).map((u) => u.code)).toEqual(['SK-02'])
    expect(interchangeableWith(catalog, 'u1')).toEqual([])
  })

  it('checks the villa profile: pin, email, times, bank number, rules length and deposit', () => {
    const ok = { ...VILLA_PROFILE_DEFAULTS, lat: -8.65, lng: 115.13, email: 'saka@balivillas.id', bankAccountNo: '7710452281' }
    expect(validateVillaProfile(ok)).toEqual({})
    expect(validateVillaProfile({ ...ok, lng: null }).lat).toMatch(/both/)
    expect(validateVillaProfile({ ...ok, lat: 95 }).lat).toMatch(/-90 to 90/)
    expect(validateVillaProfile({ ...ok, lng: -181 }).lng).toMatch(/-180 to 180/)
    expect(validateVillaProfile({ ...ok, email: 'saka@' }).email).toBeTruthy()
    expect(validateVillaProfile({ ...ok, email: '' }).email).toBeUndefined()
    expect(validateVillaProfile({ ...ok, checkInTime: '2pm' }).checkInTime).toMatch(/HH:MM/)
    expect(validateVillaProfile({ ...ok, checkInTime: '12:00', checkOutTime: '12:00' }).checkOutTime).toMatch(/earlier/)
    expect(validateVillaProfile({ ...ok, bankAccountNo: '7710-452' }).bankAccountNo).toBeTruthy()
    expect(validateVillaProfile({ ...ok, houseRules: 'x'.repeat(4001) }).houseRules).toBeTruthy()
    expect(validateVillaProfile({ ...ok, depositKind: 'percent', depositValue: 0 }).depositValue).toMatch(/1 to 100/)
    expect(validateVillaProfile({ ...ok, depositKind: 'percent', depositValue: 101 }).depositValue).toMatch(/1 to 100/)
    expect(validateVillaProfile({ ...ok, depositKind: 'fixed', depositValue: 500_000 })).toEqual({})
    expect(validateVillaProfile({ ...ok, depositKind: 'none', depositValue: 10 }).depositValue).toBeTruthy()
    expect(mapLink(ok)).toBe('https://www.google.com/maps/search/?api=1&query=-8.65,115.13')
    expect(mapLink(VILLA_PROFILE_DEFAULTS)).toBeNull()
  })

  it('checks the unit setup: capacity, one row per bed type, size, view and extra beds', () => {
    const ok = { ...unitSetupDefaults(2), beds: [{ type: 'king' as const, count: 1 }, { type: 'twin' as const, count: 1 }], sizeSqm: 120, view: 'ocean' as const, extraBeds: 2, extraBedRate: 450_000 }
    expect(unitSetupDefaults(2)).toMatchObject({ maxAdults: 4, maxChildren: 2 })
    expect(validateUnitSetup(ok)).toEqual({})
    expect(validateUnitSetup({ ...ok, maxAdults: 0 }).maxAdults).toBeTruthy()
    expect(validateUnitSetup({ ...ok, maxChildren: -1 }).maxChildren).toBeTruthy()
    expect(validateUnitSetup({ ...ok, beds: [{ type: 'king', count: 1 }, { type: 'king', count: 2 }] }).beds).toMatch(/twice/)
    expect(validateUnitSetup({ ...ok, beds: [{ type: 'single', count: 0 }] }).beds).toMatch(/at least one/)
    expect(validateUnitSetup({ ...ok, sizeSqm: 0 }).sizeSqm).toBeTruthy()
    expect(validateUnitSetup({ ...ok, extraBeds: 5 }).extraBeds).toBeTruthy()
    expect(validateUnitSetup({ ...ok, extraBedRate: 0 }).extraBedRate).toMatch(/price/)
    expect(validateUnitSetup({ ...ok, extraBeds: 0, extraBedRate: 100 }).extraBedRate).toBeTruthy()
  })

  it('fits a party by adults and by heads, extra beds included, and refuses UNIT_CAPACITY', () => {
    const villa = { maxAdults: 4, maxChildren: 2, extraBeds: 1 }
    expect(capacityLabel(villa)).toBe('4 + 2, +1 extra')
    expect(capacityLabel({ ...villa, extraBeds: 0 })).toBe('4 + 2')
    expect(fitsParty(villa, { adults: 5, children: 2 })).toBe(true)
    expect(fitsParty(villa, { adults: 6, children: 0 })).toBe(false)
    expect(fitsParty(villa, { adults: 4, children: 4 })).toBe(false)
    expect(extraBedsUsed(villa, { adults: 4, children: 3 })).toBe(1)
    expect(extraBedsUsed(villa, { adults: 2, children: 0 })).toBe(0)
    expect(() => assertCapacity('Karang 1', villa, { adults: 6, children: 0 })).toThrow('Karang 1 sleeps 4 adults and 2 children, plus 1 extra bed.')
    expect(() => assertCapacity('Karang 1', villa, null)).not.toThrow()
    expect(typeCapacity([villa, { maxAdults: 2, maxChildren: 1, extraBeds: 0 }])).toEqual({ maxAdults: 2, maxChildren: 1, extraBeds: 0 })
    expect(typeCapacity([])).toBeNull()
  })

  it('asks a reason for an out-of-service status, a return date not in the past, and flags overdue units', () => {
    expect(validateStatusChange({ status: 'maintenance', statusReason: '', statusUntil: null }, '2026-10-05').statusReason).toBe('Say why the unit is out of service.')
    expect(validateStatusChange({ status: 'inactive', statusReason: 'Renovation', statusUntil: '2026-10-04' }, '2026-10-05').statusUntil).toMatch(/past/)
    expect(validateStatusChange({ status: 'active', statusReason: '', statusUntil: '2026-10-09' }, '2026-10-05').statusUntil).toMatch(/Only/)
    expect(validateStatusChange({ status: 'cleaning', statusReason: '', statusUntil: null }, '2026-10-05')).toEqual({})
    expect(validateStatusChange({ status: 'maintenance', statusReason: 'Pool pump', statusUntil: '2026-10-05' }, '2026-10-05')).toEqual({})
    expect(isOverdue({ status: 'maintenance', statusUntil: '2026-10-04' }, '2026-10-05')).toBe(true)
    expect(isOverdue({ status: 'maintenance', statusUntil: '2026-10-05' }, '2026-10-05')).toBe(false)
    expect(isOverdue({ status: 'active', statusUntil: '2026-10-01' }, '2026-10-05')).toBe(false)
  })
})
