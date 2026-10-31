import { beforeEach, describe, expect, it } from 'vitest'
import { fixedClock } from '@/infrastructure/clock'
import { createMockPorts } from '@/infrastructure/mock'
import type { CheckOutDetails } from '@/domain/booking'
import { addDays } from '@/lib/dates'
import { createServices, type Services } from './services'

const TODAY = '2026-10-05'
let s: Services
const signIn = (who: string) => s.access.login({ email: `${who}@balivillas.id`, password: 'villa123' })
const details = (extraCharges = 0): CheckOutDetails => ({ depositReturned: 0, extraCharges, roomInspected: true, keysReturned: true, notes: 'Minibar' })

beforeEach(async () => {
  s = createServices(createMockPorts(fixedClock(TODAY), 0))
  await signIn('kadek')
})

/** An in-house stay with a delivered, unpaid order on it; a direct stay also gets a higher rate so the room has a balance. */
async function owing(code: string, item: string) {
  const options = await s.orders.formOptions()
  const stay = options.stays.find((b) => b.code === code)
  const menuItem = options.menu.find((i) => i.villaId === stay?.place.villa.id && i.name === item)
  if (!stay || !menuItem) throw new Error(`${code} or ${item} missing`)
  if (stay.source === 'direct') await s.booking.setPrice(stay.id, { rateOverride: 5_000_000, discount: null, reason: 'Upgraded to the pool suite' })
  const order = await s.orders.place({ bookingId: stay.id, lines: [{ itemId: menuItem.id, quantity: 2 }], note: '', requestedOn: addDays(TODAY, 1), requestedAt: 12 * 60, priority: 'normal', discountPct: 0, discountReason: '', compReason: '' })
  for (const to of ['confirmed', 'preparing', 'delivered'] as const) await s.orders.transition(order.id, to)
  return { stay, order: await s.orders.detail(order.id) }
}

describe('settle and check out', () => {
  it('takes the room balance, room service and departure charges in cash, books each in its category, and closes the stay', async () => {
    const { stay, order } = await owing('BK-1296', 'Nasi goreng ayam')
    const due = await s.booking.settlement(stay.id)
    expect(due.roomDue).toBeGreaterThan(0)
    expect(due.orders.map((o) => o.number)).toEqual([order.order.number])
    await expect(s.booking.checkOut(stay.id, details())).rejects.toMatchObject({ code: 'SERVICE_UNPAID' })

    const { booking, link } = await s.booking.settleAndCheckOut(stay.id, { details: details(150_000), method: 'cash', reference: '', attachments: [] })
    expect(link).toBeNull()
    expect(booking.status).toBe('checked_out')
    const after = await s.booking.detail(stay.id)
    expect(after.invoice.outstanding).toBe(0)
    expect(after.invoice.roomService.outstanding).toBe(0)
    expect(after.housekeeping).toBe('dirty')
    const entries = after.transactions.filter((t) => t.status === 'submitted' && t.kind === 'cash_in')
    expect(entries.find((t) => t.categoryId === 'cat-room')?.amount).toBe(due.roomDue)
    expect(entries.find((t) => t.categoryId === 'cat-svc-fnb')?.amount).toBe(order.order.totals.charge)
    expect(entries.find((t) => t.categoryId === 'cat-extra')?.amount).toBe(150_000)
    expect((await s.orders.detail(order.order.id)).order.payState).toBe('paid')
  })

  it('changes nothing when a step fails halfway', async () => {
    const { stay } = await owing('BK-1296', 'Nasi goreng ayam')
    const before = await s.booking.detail(stay.id)
    const bad = { id: 'x', name: 'notes.txt', type: 'text/plain', size: 10, url: 'data:text/plain;base64,eA==', uploadedBy: 'Kadek', uploadedAt: `${TODAY}T10:00:00` }
    await expect(s.booking.settleAndCheckOut(stay.id, { details: details(), method: 'cash', reference: '', attachments: [bad] })).rejects.toMatchObject({ code: 'ATTACHMENT_TYPE' })
    const after = await s.booking.detail(stay.id)
    expect(after.booking.status).toBe('checked_in')
    expect(after.invoice.payments).toHaveLength(before.invoice.payments.length)
    expect(after.transactions).toHaveLength(before.transactions.length)
    expect((await s.booking.settlement(stay.id)).orders).toHaveLength(1)
  })

  it('sends one link for the whole bill and checks out when the guest pays it', async () => {
    const { stay, order } = await owing('BK-1296', 'Nasi goreng ayam')
    const due = await s.booking.settlement(stay.id)
    const fees = (t: { categoryId: string; amount: number }[]) => t.filter((x) => x.categoryId === 'cat-fees').reduce((sum, x) => sum + x.amount, 0)
    const feesBefore = fees((await s.booking.detail(stay.id)).transactions)
    const { booking, link } = await s.booking.settleAndCheckOut(stay.id, { details: details(100_000), method: 'qris', reference: '', attachments: [] })
    expect(booking.status).toBe('checked_in')
    expect(link?.amount).toBe(due.roomDue + order.order.totals.charge + 100_000)
    await expect(s.booking.checkOut(stay.id, details())).rejects.toMatchObject({ code: 'SETTLEMENT_PENDING' })
    const page = await s.payments.checkout(link?.token ?? '')
    expect(page.lines?.map((l) => l.kind)).toEqual(['room', 'orders', 'charges'])
    expect(page.total).toBe(link?.amount)

    await s.payments.settle(link?.token ?? '', 'paid')
    const after = await s.booking.detail(stay.id)
    expect(after.booking.status).toBe('checked_out')
    expect(after.invoice.outstanding).toBe(0)
    expect((await s.orders.detail(order.order.id)).order.payState).toBe('paid')
    expect(fees(after.transactions) - feesBefore).toBe(link?.gatewayFee)
    expect(after.transactions.find((t) => t.categoryId === 'cat-extra')?.accountId).toBe('bank-bca')
  })

  it('settles only room service on an Airbnb stay, whose room Airbnb pays out', async () => {
    const { stay, order } = await owing('BK-1305', 'Bintang large')
    const due = await s.booking.settlement(stay.id)
    expect(due.roomDue).toBe(0)
    await s.booking.settleAndCheckOut(stay.id, { details: details(), method: 'bank_transfer', reference: 'TRF-1305', attachments: [] })
    const after = await s.booking.detail(stay.id)
    expect(after.booking.status).toBe('checked_out')
    const cashIns = after.transactions.filter((t) => t.status === 'submitted' && t.kind === 'cash_in')
    expect(cashIns.some((t) => t.categoryId === 'cat-room')).toBe(false)
    expect(cashIns.reduce((sum, t) => sum + t.amount, 0)).toBe(order.order.totals.charge)
  })

  it('asks for the bank reference on a transfer', async () => {
    const { stay } = await owing('BK-1296', 'Nasi goreng ayam')
    await expect(s.booking.settleAndCheckOut(stay.id, { details: details(), method: 'bank_transfer', reference: '', attachments: [] })).rejects.toMatchObject({ errors: { reference: expect.any(String) } })
    await expect(s.booking.settleAndCheckOut(stay.id, { details: details(), method: 'qris', reference: '', attachments: [] })).resolves.toMatchObject({ link: expect.anything() })
  })
})
