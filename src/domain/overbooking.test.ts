import { describe, expect, it } from 'vitest'
import { typeAvailability, type Holding } from './booking'
import { overbookedNights, overbookLimit, validateOverbook, validateWalk } from './overbooking'
import { buildCatalog, type Unit } from './property'

const unit = (id: string, groupId: string): Unit => ({ id, villaId: 'v', groupId, code: id.toUpperCase(), name: id, bedrooms: 1, nightlyRate: 1_000_000, status: 'active', amenities: [] }) as unknown as Unit
const catalog = buildCatalog(
  [{ id: 'l', name: 'L' } as never],
  [{ id: 'v', locationId: 'l', code: 'V', name: 'V' } as never],
  [unit('a1', 'type'), unit('a2', 'type'), unit('b1', 'single')],
  [
    { id: 'type', villaId: 'v', name: 'Type', interchangeable: true, operatorAssigns: true },
    { id: 'single', villaId: 'v', name: 'Single', interchangeable: false, operatorAssigns: false },
  ],
)
const held = (id: string, checkIn: string, checkOut: string, unitId = 'a1', unitAssigned = false): Holding => ({ id, code: id, unitId, unitAssigned, status: 'confirmed', checkIn, checkOut })

describe('overbooking', () => {
  it('sells a room type past its rooms only up to the policy', () => {
    const stays = [held('x', '2026-11-20', '2026-11-22', 'a1', true), held('y', '2026-11-20', '2026-11-21')]
    expect(typeAvailability(catalog, 'type', '2026-11-20', '2026-11-21', stays, [])).toMatchObject({ free: 0, sellable: 0 })
    expect(typeAvailability(catalog, 'type', '2026-11-20', '2026-11-21', stays, [], undefined, 1)).toMatchObject({ free: 0, sellable: 1 })
    const over = [...stays, held('z', '2026-11-20', '2026-11-21')]
    expect(typeAvailability(catalog, 'type', '2026-11-20', '2026-11-21', over, [], undefined, 1).sellable).toBe(0)
  })

  it('finds the nights a type holds more stays than open rooms', () => {
    const stays = [held('x', '2026-11-20', '2026-11-22', 'a1', true), held('y', '2026-11-20', '2026-11-23'), held('z', '2026-11-21', '2026-11-22')]
    expect(overbookedNights(catalog, 'type', '2026-11-19', '2026-11-24', stays, []).map((n) => [n.date, n.held, n.rooms, n.over])).toEqual([['2026-11-21', 3, 2, 1]])
    // A blocked room counts against the night too.
    const blocks = [{ id: 'k', unitId: 'a2', from: '2026-11-20', to: '2026-11-21', reason: 'maintenance' as const, note: '' }]
    expect(overbookedNights(catalog, 'type', '2026-11-20', '2026-11-21', stays, blocks).map((n) => n.over)).toEqual([1])
    // Rooms sold one by one never report overbooked.
    expect(overbookedNights(catalog, 'single', '2026-11-20', '2026-11-22', [held('s', '2026-11-20', '2026-11-22', 'b1', true)], [])).toEqual([])
  })

  it('reads and checks the policy', () => {
    expect(overbookLimit([{ groupId: 'type', limit: 2 }], 'type')).toBe(2)
    expect(overbookLimit([], 'type')).toBe(0)
    expect(validateOverbook(0)).toBeNull()
    expect(validateOverbook(6)).toMatch(/0 to 5/)
    expect(validateOverbook(1.5)).not.toBeNull()
  })

  it('asks a walk for its destination, cost and reason', () => {
    expect(validateWalk({ destination: 'group_villa', unitId: null, property: '', cost: -1, method: 'cash', compensation: '', reason: '' })).toEqual({ unitId: 'Pick the unit the guest moves to.', cost: 'Enter the cost in whole rupiah, or zero.', reason: 'Say why the guest is walked.' })
    expect(validateWalk({ destination: 'outside', unitId: null, property: 'X', cost: 0, method: 'cash', compensation: '', reason: 'Overbooked' })).toEqual({ property: 'Name the property the guest goes to.' })
  })
})
