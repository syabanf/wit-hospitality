import { describe, expect, it } from 'vitest'
import { settlementLines, validateSettle } from './payment'

describe('check-out bill', () => {
  it('lists the room balance, each unpaid order and departure charges, dropping empty parts', () => {
    const lines = settlementLines(2_000_000, [{ number: 'SO-1', items: '2 × Nasi goreng ayam', amount: 150_000 }, { number: 'SO-2', items: 'free', amount: 0 }], 0)
    expect(lines.map((l) => [l.kind, l.amount])).toEqual([['room', 2_000_000], ['orders', 150_000]])
    expect(settlementLines(0, [], 50_000).map((l) => l.kind)).toEqual(['charges'])
  })

  it('asks for a bank reference and keeps departure charges alone off the gateway', () => {
    const room = settlementLines(1_000_000, [], 0)
    expect(validateSettle({ method: 'bank_transfer', reference: '' }, room).reference).toBeDefined()
    expect(validateSettle({ method: 'qris', reference: '' }, room)).toEqual({})
    expect(validateSettle({ method: 'qris', reference: '' }, settlementLines(0, [], 50_000)).method).toBeDefined()
    expect(validateSettle({ method: 'cash', reference: '' }, [])).toEqual({})
  })
})
