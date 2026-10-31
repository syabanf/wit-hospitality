import { beforeEach, describe, expect, it } from 'vitest'
import { fixedClock } from '@/infrastructure/clock'
import { createMockPorts } from '@/infrastructure/mock'
import { orderTokenFor } from '@/domain/serviceOrder'
import { addDays } from '@/lib/dates'
import { createServices, type Services } from './services'

const TODAY = '2026-10-05'
const TOMORROW = addDays(TODAY, 1)
let s: Services
const signIn = (who: string) => s.access.login({ email: `${who}@balivillas.id`, password: 'villa123' })

beforeEach(() => {
  s = createServices(createMockPorts(fixedClock(TODAY), 0))
})

/** A Saka guest in house today and that villa's menu, as the villa manager sees them. */
async function sakaStay() {
  const options = await s.orders.formOptions()
  const stay = options.stays.find((b) => b.status === 'checked_in' && b.place.villa.id === 'vil-saka' && b.checkOut > TOMORROW)
  if (!stay) throw new Error('no Saka guest in house')
  const item = (name: string) => {
    const found = options.menu.find((i) => i.villaId === 'vil-saka' && i.name === name)
    if (!found) throw new Error(name)
    return found
  }
  return { stay, item }
}
const order = (bookingId: string, lines: Array<{ itemId: string; quantity: number; comp?: boolean }>, extra: Partial<Parameters<Services['orders']['place']>[0]> = {}) =>
  s.orders.place({ bookingId, lines, note: '', requestedOn: TOMORROW, requestedAt: 12 * 60, priority: 'normal', discountPct: 0, discountReason: '', compReason: '', ...extra })

describe('room service', () => {
  it('seeds a menu for every villa and orders on the stays in house', async () => {
    const menu = await s.orders.menu()
    expect(new Set(menu.items.map((i) => i.villaId)).size).toBe(5)
    expect(menu.items.find((i) => i.name === 'Balinese massage, 60 minutes')?.partner?.name).toBe('Taksu Mobile Spa')
    const board = await s.orders.board()
    expect(board.list.length).toBeGreaterThanOrEqual(6)
    expect(board.list.some((o) => o.payState === 'paid')).toBe(true)
    expect(board.unpaidCount).toBeGreaterThan(0)
  })

  it('bills a delivered order to the stay, refuses check-out until it is paid, and books the income per category', async () => {
    await signIn('kadek')
    const { stay, item } = await sakaStay()
    const before = (await s.booking.detail(stay.id)).booking.paidAmount
    const placed = await order(stay.id, [{ itemId: item('Nasi goreng ayam').id, quantity: 2 }, { itemId: item('Wash and fold').id, quantity: 2.5 }])
    expect(placed.totals.charge).toBe(2 * 75_000 + 112_500)
    for (const to of ['confirmed', 'preparing', 'delivered'] as const) await s.orders.transition(placed.id, to)
    const bill = await s.orders.forStay(stay.id)
    expect(bill.outstanding).toBeGreaterThanOrEqual(placed.totals.charge)

    await expect(s.booking.checkOut(stay.id, { depositReturned: 0, extraCharges: 0, roomInspected: true, keysReturned: true, notes: '' })).rejects.toMatchObject({ code: 'SERVICE_UNPAID' })

    const unpaid = bill.orders.filter((o) => o.payState === 'unpaid').map((o) => o.id)
    const { payment } = await s.orders.pay({ bookingId: stay.id, orderIds: unpaid, method: 'cash', reference: '' })
    expect(payment?.amount).toBe(bill.outstanding)
    expect(payment?.extraTransactionIds?.length).toBeGreaterThanOrEqual(1)
    expect((await s.orders.forStay(stay.id)).outstanding).toBe(0)
    // The stay's own balance is untouched: room service settles apart from the room.
    expect((await s.booking.detail(stay.id)).booking.paidAmount).toBe(before)
    const invoice = await s.payments.invoice(stay.id)
    expect(invoice.lines.some((l) => l.label === `Room service ${placed.number}`)).toBe(true)
    expect(invoice.roomService.outstanding).toBe(0)

    // Finance posts the cash-ins; the income report and the room service report carry them.
    const detail = await s.orders.detail(placed.id)
    expect(detail.revenue.map((t) => t.categoryId).sort()).toEqual(['cat-svc-fnb', 'cat-svc-laundry'])
    await signIn('rama')
    for (const t of detail.revenue) await s.finance.transition(t.id, 'approved')
    await signIn('ida')
    for (const t of detail.revenue) await s.finance.transition(t.id, 'posted')
    const income = await s.reports.run('income', { from: TODAY, to: TODAY })
    expect(income.rows.find((r) => r.category === 'Laundry service')?.amount).toBeGreaterThanOrEqual(112_500)
    const revenue = await s.reports.run('rs-revenue', { from: TODAY, to: TODAY, villaId: 'vil-saka' })
    expect(revenue.rows.some((r) => r.category === 'Laundry')).toBe(true)
    expect((await s.orders.detail(placed.id)).steps.every((x) => x.state === 'done')).toBe(true)
  })

  it('books the partner’s share as a cash-out on delivery, so the margin shows', async () => {
    await signIn('kadek')
    const { stay, item } = await sakaStay()
    const spa = await order(stay.id, [{ itemId: item('Balinese massage, 60 minutes').id, quantity: 2 }], { requestedAt: 15 * 60 })
    expect(spa.totals).toMatchObject({ charge: 600_000, cost: 360_000, margin: 240_000 })
    await s.orders.transition(spa.id, 'confirmed')
    const delivered = await s.orders.transition(spa.id, 'delivered')
    const detail = await s.orders.detail(delivered.id)
    expect(detail.costs).toHaveLength(1)
    expect(detail.costs[0]).toMatchObject({ kind: 'cash_out', categoryId: 'cat-svc-partner', amount: 360_000, status: 'submitted', origin: 'room_service' })
    const payables = await s.reports.run('rs-partners', { from: TODAY, to: TODAY })
    expect(payables.rows.find((r) => r.partner === 'Taksu Mobile Spa')?.waiting).toBeGreaterThanOrEqual(360_000)
  })

  it('lets the guest order from the room QR code and pay by QRIS', async () => {
    await signIn('kadek')
    const { stay, item } = await sakaStay()
    const token = orderTokenFor(stay.unitCode)
    const menu = await s.orders.guestMenu(token)
    expect(menu.stay?.bookingCode).toBe(stay.code)
    expect(menu.items.every((i) => i.villaId === 'vil-saka')).toBe(true)
    const after = await s.orders.guestPlace(token, { lines: [{ itemId: item('Balinese breakfast').id, quantity: 2 }], note: 'Coffee black', requestedOn: TOMORROW, requestedAt: 8 * 60 })
    const placed = after.orders.find((o) => o.lines.some((l) => l.name === 'Balinese breakfast') && o.status === 'new')
    expect(placed).toBeDefined()
    const board = await s.orders.board()
    const mine = board.list.find((o) => o.number === placed?.number)
    expect(mine?.placedBy).toBe('guest')
    for (const to of ['confirmed', 'delivered'] as const) await s.orders.transition(mine?.id ?? '', to)

    const link = await s.orders.guestPay(token)
    expect(link.method).toBe('qris')
    const checkout = await s.payments.checkout(link.token)
    expect(checkout.orderNumbers).toContain(placed?.number)
    await s.payments.settle(link.token, 'paid')
    const paid = await s.orders.guestMenu(token)
    expect(paid.outstanding).toBe(0)
    const detail = await s.orders.detail(mine?.id ?? '')
    expect(detail.payment?.status).toBe('paid')
    expect(detail.revenue.some((t) => t.categoryId === 'cat-svc-fnb' && t.origin === 'payment')).toBe(true)
  })

  it('refuses orders for stays not in house and items outside their hours', async () => {
    await signIn('kadek')
    const { stay, item } = await sakaStay()
    await expect(order(stay.id, [{ itemId: item('Balinese breakfast').id, quantity: 1 }], { requestedAt: 15 * 60 })).rejects.toMatchObject({ code: 'ITEM_UNAVAILABLE' })
    const later = (await s.booking.list()).list.find((b) => b.status === 'confirmed' && b.checkIn > addDays(TODAY, 5) && b.place.villa.id === 'vil-saka')
    if (!later) throw new Error('no later Saka arrival')
    await expect(order(later.id, [{ itemId: item('Nasi goreng ayam').id, quantity: 1 }])).rejects.toMatchObject({ code: 'ORDER_NO_STAY' })
  })

  it('gives items free only with permission, and caps discounts for staff', async () => {
    await signIn('wayan')
    const { stay, item } = await sakaStay()
    const coconut = item('Fresh young coconut').id
    await expect(order(stay.id, [{ itemId: coconut, quantity: 1, comp: true }], { compReason: 'Welcome drink' })).rejects.toMatchObject({ code: 'COMP_FORBIDDEN' })
    await expect(order(stay.id, [{ itemId: coconut, quantity: 1 }], { discountPct: 25, discountReason: 'Complaint' })).rejects.toMatchObject({ code: 'DISCOUNT_LIMIT' })
    await signIn('kadek')
    const free = await order(stay.id, [{ itemId: coconut, quantity: 1, comp: true }], { compReason: 'Welcome drink' })
    expect(free.totals.charge).toBe(0)
  })

  it('keeps the menu for those who may edit it', async () => {
    await signIn('wayan')
    const { item } = await sakaStay()
    const bintang = item('Bintang large')
    await expect(s.orders.saveItem(bintang.id, { ...bintang, price: 60_000 })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await signIn('kadek')
    const saved = await s.orders.saveItem(bintang.id, { ...bintang, price: 60_000 })
    expect(saved.price).toBe(60_000)
  })

  it('reports top items and delivery times', async () => {
    const items = await s.reports.run('rs-items', { from: addDays(TODAY, -3), to: TODAY })
    expect(items.rows.length).toBeGreaterThan(0)
    const delivery = await s.reports.run('rs-delivery', { from: addDays(TODAY, -3), to: TOMORROW })
    expect(delivery.rows.reduce((n, r) => n + Number(r.delivered), 0)).toBeGreaterThan(0)
  })
})
