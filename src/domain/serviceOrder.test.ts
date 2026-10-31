import { describe, expect, it } from 'vitest'
import { orderFlow } from './flow'
import { availableAt, folio, itemProblem, orderableStay, orderLate, orderTokenFor, orderTotals, partnerCosts, payState, revenueSplit, validateMenuItem, validateOrder, type MenuItem, type OrderLine, type ServiceOrder } from './serviceOrder'

const line = (fields: Partial<OrderLine>): OrderLine => ({ itemId: 'mi-x', name: 'Item', category: 'food', unit: 'item', price: 100_000, quantity: 1, costPrice: 0, partnerId: null, comp: false, ...fields })
const order = (fields: Partial<ServiceOrder>): ServiceOrder => ({
  id: 'so-1',
  number: 'SO-701',
  bookingId: 'bk-1',
  unitId: 'unit-sk-01',
  villaId: 'vil-saka',
  lines: [],
  note: '',
  requestedOn: '2026-10-05',
  requestedAt: 12 * 60,
  priority: 'normal',
  status: 'delivered',
  assignee: '',
  placedBy: 'staff',
  createdOn: '2026-10-05',
  deliveredOn: '2026-10-05',
  deliveredAt: 12 * 60 + 10,
  discountPct: 0,
  discountReason: '',
  compReason: '',
  paymentId: null,
  costTransactionIds: [],
  history: [],
  ...fields,
})
const item = (fields: Partial<MenuItem>): MenuItem => ({ id: 'mi-x', villaId: 'vil-saka', category: 'food', name: 'Nasi goreng', description: '', photo: null, price: 75_000, unit: 'item', availableFrom: 10 * 60, availableTo: 22 * 60, leadMinutes: 30, active: true, partnerId: null, costPrice: 0, ...fields })

describe('room service orders', () => {
  it('charges menu price less free items and the discount, and keeps the partner cost apart', () => {
    const o = order({ lines: [line({ price: 300_000, quantity: 2, costPrice: 180_000, partnerId: 'ptn-spa', category: 'spa' }), line({ price: 450_000, comp: true, category: 'extras' })], discountPct: 10 })
    expect(orderTotals(o)).toEqual({ gross: 1_050_000, comp: 450_000, discount: 60_000, charge: 540_000, cost: 360_000, margin: 180_000 })
    expect(partnerCosts(o)).toMatchObject([{ partnerId: 'ptn-spa', amount: 360_000 }])
  })

  it('splits the charge across income categories without losing a rupiah', () => {
    const o = order({ lines: [line({ price: 120_000, quantity: 2, category: 'breakfast' }), line({ price: 45_000, quantity: 3.5, category: 'laundry' }), line({ price: 35_000, category: 'food' })], discountPct: 15 })
    const split = revenueSplit(o)
    expect(split.reduce((s, x) => s + x.amount, 0)).toBe(orderTotals(o).charge)
    expect(split.map((x) => x.categoryId).sort()).toEqual(['cat-svc-fnb', 'cat-svc-laundry'])
  })

  it('bills delivered orders only and settles them with their payment', () => {
    const open = order({ status: 'preparing', lines: [line({})] })
    const unpaid = order({ id: 'so-2', lines: [line({ price: 90_000 })] })
    const paid = order({ id: 'so-3', lines: [line({ price: 50_000 })], paymentId: 'pay-1' })
    const free = order({ id: 'so-4', lines: [line({ comp: true })] })
    const payments = [{ id: 'pay-1', status: 'paid' as const }]
    expect([open, unpaid, paid, free].map((o) => payState(o, payments))).toEqual(['not_due', 'unpaid', 'paid', 'free'])
    expect(folio([open, unpaid, paid, free], payments)).toMatchObject({ charged: 140_000, paid: 50_000, outstanding: 90_000 })
  })

  it('serves items inside their hours, overnight windows included, and asks for notice', () => {
    expect(availableAt({ availableFrom: 22 * 60, availableTo: 2 * 60 }, 60)).toBe(true)
    expect(availableAt({ availableFrom: 22 * 60, availableTo: 2 * 60 }, 12 * 60)).toBe(false)
    expect(itemProblem(item({}), '2026-10-05', 8 * 60, '2026-10-05', 7 * 60)?.code).toBe('ITEM_UNAVAILABLE')
    expect(itemProblem(item({}), '2026-10-05', 12 * 60, '2026-10-05', 11 * 60 + 50)?.code).toBe('ITEM_LEAD_TIME')
    expect(itemProblem(item({}), '2026-10-06', 12 * 60, '2026-10-05', 11 * 60 + 50)).toBeNull()
    expect(itemProblem(item({ active: false }), '2026-10-06', 12 * 60, '2026-10-05', 0)?.code).toBe('ITEM_UNAVAILABLE')
  })

  it('takes orders for guests in house or arriving within three days', () => {
    expect(orderableStay({ status: 'checked_in', checkIn: '2026-10-01' }, '2026-10-05')).toBe(true)
    expect(orderableStay({ status: 'confirmed', checkIn: '2026-10-08' }, '2026-10-05')).toBe(true)
    expect(orderableStay({ status: 'confirmed', checkIn: '2026-10-12' }, '2026-10-05')).toBe(false)
    expect(orderableStay({ status: 'checked_out', checkIn: '2026-10-01' }, '2026-10-05')).toBe(false)
  })

  it('flags an open order half an hour past its time', () => {
    const o = order({ status: 'confirmed', requestedAt: 12 * 60 })
    expect(orderLate(o, '2026-10-05', 12 * 60 + 30)).toBe(false)
    expect(orderLate(o, '2026-10-05', 12 * 60 + 31)).toBe(true)
    expect(orderLate({ ...o, status: 'delivered' }, '2026-10-05', 23 * 60)).toBe(false)
  })

  it('validates orders and menu items', () => {
    expect(validateOrder({ lines: [], requestedOn: '2026-10-05', requestedAt: 600 }).lines).toBeDefined()
    expect(validateOrder({ lines: [{ itemId: 'a', quantity: 2.55 }], requestedOn: '2026-10-05', requestedAt: 600 }).lines).toBeDefined()
    expect(validateOrder({ lines: [{ itemId: 'a', quantity: 3.5 }], requestedOn: '2026-10-05', requestedAt: 600 })).toEqual({})
    expect(validateOrder({ lines: [{ itemId: 'a', quantity: 1, comp: true }], requestedOn: '2026-10-05', requestedAt: 600, compReason: '' }).compReason).toBeDefined()
    expect(validateMenuItem({ ...item({ costPrice: 100_000 }), partnerId: null }).partnerId).toBeDefined()
  })

  it('prints one stable, room-specific token per QR card', () => {
    expect(orderTokenFor('SK-01')).toBe(orderTokenFor('SK-01'))
    expect(orderTokenFor('SK-01')).not.toBe(orderTokenFor('SK-02'))
    expect(orderTokenFor('SK-01')).toMatch(/^sk-01-[a-z0-9]+$/)
  })

  it('walks an order from ordered to income posted', () => {
    const at = (o: Parameters<typeof orderFlow>[0], entry: Parameters<typeof orderFlow>[1] = null) => orderFlow(o, entry).find((s) => s.state === 'current' || s.state === 'blocked')?.id ?? 'done'
    const base = { bookingId: 'bk-1', bookingCode: 'BK-1' }
    expect(at({ ...base, status: 'new', payState: 'not_due' })).toBe('placed')
    expect(at({ ...base, status: 'delivered', payState: 'unpaid' })).toBe('paid')
    expect(at({ ...base, status: 'delivered', payState: 'paid' }, { id: 'tx-1', status: 'submitted' })).toBe('posted')
    expect(at({ ...base, status: 'delivered', payState: 'paid' }, { id: 'tx-1', status: 'posted' })).toBe('done')
    expect(at({ ...base, status: 'cancelled', payState: 'not_due' })).toBe('cancelled')
  })
})
