import { beforeEach, describe, expect, it } from 'vitest'
import { fixedClock } from '@/infrastructure/clock'
import { createMockPorts } from '@/infrastructure/mock'
import type { CheckOutDetails } from '@/domain/booking'
import { createServices, ValidationError, type Services } from './services'

const TODAY = '2026-10-05'
let s: Services
const signIn = (who: string) => s.access.login({ email: `${who}@balivillas.id`, password: 'villa123' })
const details = (extraCharges = 0): CheckOutDetails => ({ depositReturned: 0, extraCharges, roomInspected: true, keysReturned: true, notes: '' })
const stay = async (code: string) => {
  const b = (await s.booking.list()).list.find((x) => x.code === code)
  if (!b) throw new Error(`${code} missing`)
  return b
}
const bill = (d: Awaited<ReturnType<Services['booking']['settlement']>>) => d.roomDue + d.orders.reduce((sum, o) => sum + o.amount, 0) + d.charges

beforeEach(async () => {
  s = createServices(createMockPorts(fixedClock(TODAY), 0))
  await signIn('kadek')
})

describe('guest folio', () => {
  it('is what check-out reads: every stay in house settles exactly the folio balance', async () => {
    const inHouse = (await s.booking.list()).list.filter((b) => b.status === 'checked_in')
    for (const b of inHouse) {
      const [{ folio }, due] = await Promise.all([s.booking.folio(b.id), s.booking.settlement(b.id)])
      expect(bill(due), b.code).toBe(due.owed)
      if (due.waiting.length === 0) expect(due.owed, b.code).toBe(folio.balance)
    }
    const seeded = await s.booking.settlement((await stay('BK-1303')).id)
    expect(seeded).toMatchObject({ roomDue: 0, charges: 250_000 })
    const minibar = await s.booking.folio((await stay('BK-1294')).id)
    expect(minibar.folio.lines.some((l) => l.kind === 'charge')).toBe(true)
    expect(minibar.folio.lines.find((l) => l.kind === 'channel')?.credit).toBe(minibar.booking.total)
  })

  it('posts a charge, refuses a plain check-out until it is paid, then books it beside the departure charges', async () => {
    const b = await stay('BK-1296')
    await s.booking.postCharge(b.id, { code: 'MINI', description: '3 × Bintang', amount: 120_000 })
    expect((await s.booking.folio(b.id)).folio.balance).toBe(120_000)
    await expect(s.booking.checkOut(b.id, details())).rejects.toMatchObject({ code: 'FOLIO_UNSETTLED' })

    const due = await s.booking.settlement(b.id)
    expect(due).toMatchObject({ roomDue: 0, charges: 120_000, owed: 120_000 })
    await s.booking.settleAndCheckOut(b.id, { details: details(50_000), method: 'cash', reference: '', attachments: [] })
    const after = await s.booking.detail(b.id)
    expect(after.booking.status).toBe('checked_out')
    const extra = after.transactions.filter((t) => t.categoryId === 'cat-extra' && t.status === 'submitted').map((t) => t.amount).sort()
    expect(extra).toEqual([120_000, 50_000])
    expect(after.folio.balance).toBe(0)
    await expect(s.booking.postCharge(b.id, { code: 'DMG', description: 'Towel', amount: 50_000 })).rejects.toMatchObject({ code: 'BOOKING_INVALID_STATE' })
  })

  it('needs someone who may approve bookings for an allowance past the discount limit', async () => {
    const b = await stay('BK-1306')
    await signIn('dian')
    await expect(s.booking.postAllowance(b.id, { amount: 100_000, reason: 'Glass was cracked already' })).rejects.toMatchObject({ code: 'ALLOWANCE_LIMIT' })
    await expect(s.booking.postAllowance(b.id, { amount: 30_000, reason: 'Goodwill' })).resolves.toMatchObject({ approvedBy: null })
    await signIn('kadek')
    await expect(s.booking.postAllowance(b.id, { amount: 400_000, reason: 'Too much' })).rejects.toBeInstanceOf(ValidationError)
    await expect(s.booking.postAllowance(b.id, { amount: 100_000, reason: 'Glass was cracked already' })).resolves.toMatchObject({ approvedBy: 'Kadek Ariani' })
    expect((await s.booking.settlement(b.id)).charges).toBe(220_000)
  })

  it('puts the folio charges on the check-out link and holds new postings until the guest pays', async () => {
    const b = await stay('BK-1294')
    const due = await s.booking.settlement(b.id)
    expect(due.orders).toHaveLength(1)
    const { link } = await s.booking.settleAndCheckOut(b.id, { details: details(), method: 'qris', reference: '', attachments: [] })
    expect(link?.amount).toBe(due.owed)
    const page = await s.payments.checkout(link?.token ?? '')
    expect(page.lines?.map((l) => l.kind)).toEqual(['orders', 'charges'])
    await expect(s.booking.postCharge(b.id, { code: 'XTRA', description: 'Laundry bag', amount: 20_000 })).rejects.toMatchObject({ code: 'SETTLEMENT_PENDING' })

    await s.payments.settle(link?.token ?? '', 'paid')
    const after = await s.booking.detail(b.id)
    expect(after.booking.status).toBe('checked_out')
    expect(after.folio.balance).toBe(0)
    expect(after.transactions.find((t) => t.categoryId === 'cat-extra')).toMatchObject({ amount: due.charges, accountId: 'bank-bca' })
  })
})
