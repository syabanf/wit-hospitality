import { describe, expect, it } from 'vitest'
import { roomOccupancy, repriceFrom } from './rack'
import { breakfastLine, breakfastPersons, packageNight, packagesFrom, validateRatePackages } from './ratePackage'
import { floorLabel, sectionHandover, SectionHotelOnly, validateSection } from './section'

const night = { date: '2026-11-11', rate: 1_850_000, source: { kind: 'plan' as const, name: 'Weekday' } }

describe('rate packages', () => {
  it('prices a plan night through the package, half up, and leaves other nights alone', () => {
    expect(packageNight(null, night)).toEqual(night)
    expect(packageNight({ name: 'With breakfast', rate: 'plan', value: 0 }, night)).toMatchObject({ rate: 1_850_000, source: { name: 'Weekday, With breakfast' } })
    expect(packageNight({ name: 'Corporate', rate: 'fixed', value: 1_400_000 }, night)).toMatchObject({ rate: 1_400_000, source: { name: 'Corporate' } })
    expect(packageNight({ name: 'Long stay', rate: 'percent', value: 15 }, night).rate).toBe(1_572_500)
    expect(packageNight({ name: 'Odd', rate: 'percent', value: 15 }, { ...night, rate: 1_000_010 }).rate).toBe(850_009)
    const villa = { date: '2026-11-11', rate: 3_000_000, source: { kind: 'villa' as const } }
    expect(packageNight({ name: 'Corporate', rate: 'fixed', value: 1 }, villa)).toEqual(villa)
  })

  it('checks packages with the contract messages and names new ones', () => {
    const company = (id: string) => id === 'cl-nusa'
    const base = { name: 'With breakfast', rate: 'plan' as const, value: 0, breakfast: 150_000, accountId: null }
    expect(validateRatePackages([base], 'room', company)).toEqual({})
    expect(validateRatePackages([base], 'villa', company).packages).toBe('Packages are for hotel room types; a villa sells at its own price.')
    expect(validateRatePackages([{ ...base, breakfast: 0 }], 'room', company)['packages.0.breakfast']).toBe('Add breakfast or a rate; without either this is Room only.')
    expect(validateRatePackages([base, { ...base, name: 'with BREAKFAST' }], 'room', company)['packages.1.name']).toBe('with BREAKFAST is listed twice.')
    expect(validateRatePackages([{ ...base, rate: 'fixed', value: 0 }], 'room', company)['packages.0.value']).toBe('Enter the nightly price in whole rupiah.')
    expect(validateRatePackages([{ ...base, accountId: 'cl-agent' }], 'room', company)['packages.0.accountId']).toBe('Pick a company account from the city ledger.')
    expect(packagesFrom([{ ...base, name: ' Corp ', rate: 'fixed', value: 1 }, { ...base, name: 'Corp', id: 'pkg-corp' }, { ...base, name: 'Corp!' }]).map((p) => p.id)).toEqual(['pkg-corp-2', 'pkg-corp', 'pkg-corp-3'])
  })

  it('charges breakfast per person per night', () => {
    expect(breakfastPersons({ arrival: { adults: 2, children: 1 }, partySize: { adults: 1, children: 0 } })).toBe(3)
    expect(breakfastPersons({ arrival: null })).toBe(1)
    expect(breakfastLine({ breakfast: 150_000 }, 2, 0, 3)).toEqual({ amount: 300_000, description: 'Breakfast, night 1 of 3, 2 guests' })
    expect(breakfastLine({ breakfast: 0 }, 2, 0, 3)).toBeNull()
  })
})

describe('room rack and moves', () => {
  const stay = (status: 'confirmed' | 'checked_in' | 'checked_out', checkIn: string, checkOut: string) => ({ id: `${status}-${checkIn}`, status, checkIn, checkOut, checkedOutOn: status === 'checked_out' ? checkOut : null, unitId: 'u', unitAssigned: true })

  it('reads occupancy from the stays, with a forecast after today', () => {
    expect(roomOccupancy('u', '2026-11-11', '2026-11-11', []).occupancy).toBe('vacant')
    expect(roomOccupancy('u', '2026-11-11', '2026-11-11', [stay('checked_in', '2026-11-09', '2026-11-13')]).occupancy).toBe('in_house')
    const turn = roomOccupancy('u', '2026-11-11', '2026-11-11', [stay('checked_in', '2026-11-09', '2026-11-11'), stay('confirmed', '2026-11-11', '2026-11-12')])
    expect([turn.occupancy, turn.next?.checkIn]).toEqual(['due_out', '2026-11-11'])
    expect(roomOccupancy('u', '2026-11-11', '2026-11-11', [stay('checked_out', '2026-11-08', '2026-11-11')]).occupancy).toBe('departed')
    expect(roomOccupancy('u', '2026-11-11', '2026-11-11', [stay('confirmed', '2026-11-10', '2026-11-12')]).occupancy).toBe('arriving')
    expect(roomOccupancy('u', '2026-11-14', '2026-11-11', [stay('confirmed', '2026-11-12', '2026-11-16')]).occupancy).toBe('in_house')
    expect(roomOccupancy('u', '2026-11-16', '2026-11-11', [stay('confirmed', '2026-11-12', '2026-11-16')]).occupancy).toBe('due_out')
  })

  it('reprices from the first night neither posted nor past', () => {
    expect(repriceFrom({ checkIn: '2026-11-14', nightsPosted: [] }, '2026-11-11')).toBe(0)
    expect(repriceFrom({ checkIn: '2026-11-09', nightsPosted: ['2026-11-09'] }, '2026-11-11')).toBe(2)
  })
})

describe('sections', () => {
  const villa = { id: 'v', name: 'Villa Saka', operation: 'hotel' as const }
  const units = [{ id: 'r1', code: 'SK-01', villaId: 'v' }, { id: 'r2', code: 'SK-02', villaId: 'v' }, { id: 'x', code: 'TR-01', villaId: 'w' }]
  const kind = () => 'room' as const

  it('refuses a villa property and checks the name and rooms', () => {
    expect(() => validateSection({ villaId: 'v', name: 'A', unitIds: [] }, { ...villa, operation: 'villa' }, units, kind, [], null)).toThrow(SectionHotelOnly)
    const ground = { id: 's1', villaId: 'v', name: 'Ground floor', unitIds: ['r1'] }
    expect(validateSection({ villaId: 'v', name: 'G', unitIds: [] }, villa, units, kind, [], null)).toEqual({ name: 'Name the section.', unitIds: 'Pick at least one room.' })
    expect(validateSection({ villaId: 'v', name: 'Upstairs', unitIds: ['x'] }, villa, units, kind, [], null).unitIds).toBe('Pick rooms of this property.')
    expect(validateSection({ villaId: 'v', name: 'Upstairs', unitIds: ['r1'] }, villa, units, kind, [ground], null).unitIds).toBe('SK-01 is already in Ground floor.')
    expect(validateSection({ villaId: 'w', name: 'Ground', unitIds: ['r1'] }, villa, units, kind, [], ground).villaId).toBe('A section stays with its property.')
  })

  it('hands pending tasks of the day to the attendant, and back when cleared', () => {
    const tasks = [
      { id: 'a', unitId: 'r1', date: 'd', status: 'pending', attendantId: null },
      { id: 'b', unitId: 'r1', date: 'd', status: 'done', attendantId: null },
      { id: 'c', unitId: 'r2', date: 'd', status: 'pending', attendantId: 'e1' },
      { id: 'd', unitId: 'r9', date: 'd', status: 'pending', attendantId: null },
    ]
    const section = { unitIds: ['r1', 'r2'] }
    expect(sectionHandover(tasks, section, 'd', 'e1', null).map((t) => t.id)).toEqual(['a'])
    expect(sectionHandover(tasks, section, 'd', null, 'e1').map((t) => t.id)).toEqual(['c'])
    expect(floorLabel('G')).toBe('Ground floor')
    expect(floorLabel('')).toBe('No floor')
    expect(floorLabel('2')).toBe('Floor 2')
  })
})
