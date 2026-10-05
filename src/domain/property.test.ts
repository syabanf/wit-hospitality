import { describe, expect, it } from 'vitest'
import { buildCatalog, interchangeableWith, unitsIn, validateUnit, validateVilla, type Unit, type UnitGroup, type Villa } from './property'

const villas: Villa[] = [{ id: 'v1', locationId: 'l1', code: 'SK', name: 'Saka', description: '', facilities: [] }]
const groups: UnitGroup[] = [
  { id: 'g1', villaId: 'v1', name: 'Std', interchangeable: true },
  { id: 'g2', villaId: 'v2', name: 'Other villa', interchangeable: true },
]
const units: Unit[] = [
  { id: 'u1', villaId: 'v1', groupId: 'g1', code: 'SK-01', name: 'Saka 1', bedrooms: 1, nightlyRate: 1_000_000, status: 'active', amenities: [] },
  { id: 'u2', villaId: 'v1', groupId: 'g1', code: 'SK-02', name: 'Saka 2', bedrooms: 1, nightlyRate: 1_000_000, status: 'inactive', amenities: [] },
]

describe('property rules', () => {
  it('refuses a duplicate or malformed code and a group from another villa', () => {
    const base = { villaId: 'v1', groupId: 'g1', code: 'SK-01', name: 'Saka 9', bedrooms: 1, nightlyRate: 1_000_000, status: 'active' as const, amenities: [] }
    expect(validateUnit(base, units, groups).code).toMatch(/already used/)
    expect(validateUnit({ ...base, code: 'sk9' }, units, groups).code).toMatch(/two digits/)
    expect(validateUnit({ ...base, code: 'SK-09', groupId: 'g2' }, units, groups).groupId).toMatch(/another villa/)
    expect(validateUnit({ ...base, code: 'SK-01' }, units, groups, 'u1')).toEqual({})
    expect(validateVilla({ locationId: 'l1', code: 'SK', name: 'Dup', description: '', facilities: [] }, villas).code).toMatch(/already used/)
  })

  it('narrows units to a scope and keeps inactive units out of swaps', () => {
    const catalog = buildCatalog([{ id: 'l1', name: 'Canggu', area: 'Badung' }], villas, units, groups.slice(0, 1))
    expect(unitsIn(catalog, { locationId: 'l1' })).toHaveLength(2)
    expect(unitsIn(catalog, { unitId: 'u2' }).map((u) => u.code)).toEqual(['SK-02'])
    expect(interchangeableWith(catalog, 'u1')).toEqual([])
  })
})
