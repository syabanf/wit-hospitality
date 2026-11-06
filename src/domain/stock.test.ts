import { describe, expect, it } from 'vitest'
import { assertCanTake, averageAfterReceipt, isLow, kitIssue, lineVariance, onHand, sortMovements, storeLevels, validateCount, validateMinibarCheck, validateMove, validateReceipt, validateStockItem, varianceValue, type StockItem, type StockMovement } from './stock'

const item = (id: string, extra: Partial<StockItem> = {}): StockItem => ({ id, code: id.toUpperCase(), name: id, kind: 'amenity', unit: 'piece', reorderLevel: 5, par: 0, averageCost: 1_000, active: true, ...extra })
const move = (n: number, villaId: string, itemId: string, quantity: number, on = '2026-10-01', extra: Partial<StockMovement> = {}): StockMovement => ({
  id: `m${n}`,
  number: `SM-${n}`,
  villaId,
  itemId,
  kind: quantity > 0 ? 'receipt' : 'issue',
  quantity,
  unitCost: 1_000,
  on,
  by: 'Kadek',
  unitId: null,
  bookingId: null,
  orderId: null,
  receiptId: null,
  countId: null,
  transferId: null,
  otherVillaId: null,
  reason: '',
  ...extra,
})

describe('stock', () => {
  const movements = [move(1, 'v1', 'soap', 20), move(2, 'v1', 'soap', -4, '2026-10-03'), move(3, 'v2', 'soap', 3), move(4, 'v1', 'water', 10, '2026-10-02')]

  it('computes on hand per villa store from the movements, up to a day', () => {
    expect(onHand(movements, 'v1', 'soap')).toBe(16)
    expect(onHand(movements, 'v1', 'soap', '2026-10-02')).toBe(20)
    expect(onHand(movements, 'v2', 'soap')).toBe(3)
    expect(onHand(movements, 'v2', 'water')).toBe(0)
  })

  it('lists only items a store carries and flags those at or under the reorder level', () => {
    const levels = storeLevels([item('soap'), item('water', { reorderLevel: 0 }), item('towel')], movements, 'v2')
    expect(levels.map((l) => l.item.id)).toEqual(['soap'])
    expect(levels[0]).toMatchObject({ onHand: 3, value: 3_000, low: true })
    expect(isLow(item('x', { reorderLevel: 0 }), 0)).toBe(false)
    expect(isLow(item('x'), 6)).toBe(false)
  })

  it('moves the average cost on a receipt', () => {
    expect(averageAfterReceipt(10_000, 10, 10, 12_000)).toBe(11_000)
    expect(averageAfterReceipt(10_000, 0, 5, 9_000)).toBe(9_000)
    expect(averageAfterReceipt(10_000, -2, 4, 8_000)).toBe(8_000)
  })

  it('refuses to issue more than the store holds', () => {
    expect(() => assertCanTake(item('soap'), 3, 4, 'Villa Saka')).toThrow(expect.objectContaining({ code: 'STOCK_SHORT' }))
    expect(() => assertCanTake(item('soap'), 3, 3, 'Villa Saka')).not.toThrow()
  })

  it('issues what a kit can and reports the shortfall', () => {
    const held: Record<string, number> = { soap: 1, water: 6 }
    const { issue, short } = kitIssue({ lines: [{ itemId: 'soap', quantity: 2 }, { itemId: 'water', quantity: 2 }, { itemId: 'slippers', quantity: 2 }] }, (id) => held[id] ?? 0)
    expect(issue).toEqual([{ itemId: 'soap', quantity: 1 }, { itemId: 'water', quantity: 2 }])
    expect(short).toEqual([{ itemId: 'soap', quantity: 1 }, { itemId: 'slippers', quantity: 2 }])
  })

  it('values a count variance at the cost the line was counted at', () => {
    const lines = [{ itemId: 'soap', expected: 10, counted: 8, unitCost: 1_500 }, { itemId: 'water', expected: 4, counted: 5, unitCost: 3_000 }]
    expect(lines.map(lineVariance)).toEqual([-2, 1])
    expect(varianceValue({ lines })).toBe(-3_000 + 3_000)
  })

  it('validates items, receipts, moves, counts and minibar checks', () => {
    expect(validateStockItem({ code: 'AM-SOAP', name: 'Soap', kind: 'amenity', unit: 'piece', reorderLevel: 10, par: 0, active: true }, [item('x', { code: 'AM-SOAP' })]).code).toMatch(/already/)
    expect(validateStockItem({ code: 'AM-SOAP', name: 'Soap', kind: 'amenity', unit: 'piece', reorderLevel: 10, par: 2, active: true }, []).par).toBeDefined()
    const receipt = { villaId: 'v1', supplier: 'Toko Bali', lines: [{ itemId: 'soap', quantity: 10, unitCost: 1_500 }], method: 'cash' as const, reference: '', attachments: [], receivedOn: '2026-10-01' }
    expect(validateReceipt(receipt)).toEqual({})
    expect(validateReceipt({ ...receipt, lines: [{ itemId: 'soap', quantity: 1, unitCost: 0 }] }).lines).toBeDefined()
    expect(validateReceipt({ ...receipt, lines: [...receipt.lines, ...receipt.lines] }).lines).toBeDefined()
    const base = { villaId: 'v1', unitId: null, toVillaId: null, lines: [{ itemId: 'soap', quantity: 2 }], reason: '' }
    expect(validateMove({ ...base, kind: 'issue' }).unitId).toBeDefined()
    expect(validateMove({ ...base, kind: 'transfer', toVillaId: 'v1' }).toVillaId).toBeDefined()
    expect(validateMove({ ...base, kind: 'write_off' }).reason).toBeDefined()
    expect(validateMove({ ...base, kind: 'write_off', reason: 'Damaged in the rain' })).toEqual({})
    expect(validateCount({ villaId: 'v1', countedBy: '', lines: [{ itemId: 'soap', counted: 3 }], note: '' }).countedBy).toBeDefined()
    expect(validateMinibarCheck({ bookingId: 'b1', lines: [{ menuItemId: 'mi', quantity: 0 }], restock: true, note: '' }).lines).toBeDefined()
    expect(validateMinibarCheck({ bookingId: 'b1', lines: [{ menuItemId: 'mi', quantity: 2 }], restock: true, note: '' })).toEqual({})
  })

  it('sorts movements newest first', () => {
    expect(sortMovements(movements).map((m) => m.id)).toEqual(['m2', 'm4', 'm3', 'm1'])
  })
})
