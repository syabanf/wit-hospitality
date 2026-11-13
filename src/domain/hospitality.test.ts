import { describe, expect, it } from 'vitest'
import type { Employee } from './hr'
import {
  addedPaidSetups,
  assertHost,
  assertMayEnter,
  cleanWindow,
  defaultLateCheckoutFee,
  defaultServiceWindow,
  EMPTY_PREFERENCES,
  hostCandidates,
  lateCheckoutCharge,
  preferencesFor,
  validatePreferences,
  validateServiceWindow,
  windowOf,
} from './hospitality'
import { itemProblem, type MenuItem } from './serviceOrder'

const employee = (id: string, villaId: string, status: Employee['status'] = 'active') => ({ id, name: id, status, allocations: [{ villaId, percent: 100 }] }) as unknown as Employee

describe('villa host', () => {
  const staff = [employee('emp-a', 'vil-1'), employee('emp-b', 'vil-2'), employee('emp-c', 'vil-1', 'inactive')]

  it('lists the active employees allocated to the villa', () => {
    expect(hostCandidates(staff, 'vil-1').map((e) => e.id)).toEqual(['emp-a'])
  })

  it('refuses a host from another villa and any host on a hotel room', () => {
    expect(() => assertHost('emp-a', 'villa', 'vil-1', staff)).not.toThrow()
    expect(() => assertHost(null, 'room', 'vil-1', staff)).not.toThrow()
    expect(() => assertHost('emp-b', 'villa', 'vil-1', staff)).toThrow(expect.objectContaining({ code: 'HOST_NOT_ALLOCATED' }))
    expect(() => assertHost('emp-c', 'villa', 'vil-1', staff)).toThrow(expect.objectContaining({ code: 'HOST_NOT_ALLOCATED' }))
    expect(() => assertHost('emp-a', 'room', 'vil-1', staff)).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }))
  })
})

describe('guest preferences', () => {
  const full = { breakfastTime: '08:00', dietary: ' Vegan ', setups: ['baby_cot', 'bbq'] as const, arrivalTime: '15:00', notes: 'Quiet room' }

  it('keeps the full set for a villa and only arrival and notes for a room', () => {
    expect(preferencesFor('villa', { ...full, setups: [...full.setups] })).toEqual({ ...full, dietary: 'Vegan', setups: ['bbq', 'baby_cot'] })
    expect(preferencesFor('room', { ...full, setups: [...full.setups] })).toEqual({ ...EMPTY_PREFERENCES, arrivalTime: '15:00', notes: 'Quiet room' })
  })

  it('checks the times and the setups', () => {
    expect(validatePreferences(EMPTY_PREFERENCES)).toEqual({})
    expect(validatePreferences({ ...EMPTY_PREFERENCES, breakfastTime: '8am', arrivalTime: '25:00' })).toMatchObject({ breakfastTime: expect.any(String), arrivalTime: expect.any(String) })
  })

  it('opens a request only for paid setups the guest added', () => {
    expect(addedPaidSetups({ setups: ['bbq'] }, { setups: ['bbq', 'private_chef', 'baby_cot'] })).toEqual(['private_chef'])
    expect(addedPaidSetups({ setups: [] }, { setups: ['baby_cot'] })).toEqual([])
  })
})

describe('service window', () => {
  it('defaults by kind and keeps times only for a window', () => {
    expect(defaultServiceWindow('room')).toEqual({ mode: 'scheduled', from: '', to: '' })
    expect(defaultServiceWindow('villa')).toEqual({ mode: 'window', from: '10:00', to: '12:00' })
    expect(windowOf({}, 'villa').mode).toBe('window')
    expect(cleanWindow({ mode: 'dnd', from: '10:00', to: '12:00' })).toEqual({ mode: 'dnd', from: '', to: '' })
  })

  it('needs a window that ends after it starts', () => {
    expect(validateServiceWindow({ mode: 'window', from: '12:00', to: '10:00' })).toHaveProperty('to')
    expect(validateServiceWindow({ mode: 'dnd', from: '', to: '' })).toEqual({})
  })

  it('refuses entry to a do-not-disturb stay unless a supervisor gives a reason', () => {
    const dnd = { mode: 'dnd' as const, from: '', to: '' }
    expect(() => assertMayEnter(dnd, { supervisor: true, reason: '' })).toThrow(expect.objectContaining({ code: 'TASK_DND', message: 'The guest asked not to be disturbed.' }))
    expect(() => assertMayEnter(dnd, { supervisor: false, reason: 'Water leak' })).toThrow(expect.objectContaining({ code: 'TASK_DND' }))
    expect(() => assertMayEnter(dnd, { supervisor: true, reason: 'Water leak' })).not.toThrow()
    expect(() => assertMayEnter(defaultServiceWindow('villa'), { supervisor: false, reason: '' })).not.toThrow()
  })
})

describe('late check-out', () => {
  const base = { fee: 500_000, until: '16:00', checkOutTime: '12:00', nextArrival: null }

  it('defaults the fee by operation', () => {
    expect([defaultLateCheckoutFee('hotel'), defaultLateCheckoutFee('villa'), defaultLateCheckoutFee('mixed')]).toEqual([500_000, 0, 500_000])
  })

  it('charges rooms the fee and gives villas it free with no arrival that day', () => {
    expect(lateCheckoutCharge({ ...base, kind: 'room', operation: 'hotel' })).toBe(500_000)
    expect(lateCheckoutCharge({ ...base, kind: 'villa', operation: 'villa' })).toBe(0)
    expect(lateCheckoutCharge({ ...base, kind: 'villa', operation: 'villa', nextArrival: '18:00' })).toBe(500_000)
    expect(lateCheckoutCharge({ ...base, kind: 'villa', operation: 'mixed', nextArrival: '18:00' })).toBe(0)
  })

  it('refuses when the next guest arrives first, or the time is not late', () => {
    expect(() => lateCheckoutCharge({ ...base, kind: 'villa', operation: 'villa', nextArrival: '14:00' })).toThrow(expect.objectContaining({ code: 'LATE_CHECKOUT_TAKEN' }))
    expect(() => lateCheckoutCharge({ ...base, kind: 'room', operation: 'hotel', until: '11:00' })).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }))
  })
})

describe('menu items on request', () => {
  const breakfast = { id: 'mi-1', villaId: 'v', category: 'breakfast', name: 'Breakfast', description: '', photo: null, price: 1, unit: 'item', availableFrom: 7 * 60, availableTo: 10 * 60, leadMinutes: 0, active: true, partnerId: null, costPrice: 0, villaOnRequest: true } as MenuItem

  it('lets a villa stay order outside the hours and keeps a room stay to them', () => {
    expect(itemProblem(breakfast, '2026-10-06', 15 * 60, '2026-10-05', 0, 'villa')).toBeNull()
    expect(itemProblem(breakfast, '2026-10-06', 15 * 60, '2026-10-05', 0, 'room')?.code).toBe('ITEM_UNAVAILABLE')
    expect(itemProblem({ ...breakfast, villaOnRequest: false }, '2026-10-06', 15 * 60, '2026-10-05', 0, 'villa')?.code).toBe('ITEM_UNAVAILABLE')
  })
})
