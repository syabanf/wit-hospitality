import { beforeEach, describe, expect, it } from 'vitest'
import { fixedClock } from '@/infrastructure/clock'
import { createMockPorts } from '@/infrastructure/mock'
import { createServices, type Services } from './services'

const TODAY = '2026-10-05'
let s: Services
const signIn = (who: string) => s.access.login({ email: `${who}@balivillas.id`, password: 'villa123' })
const onHand = async (villaId: string, code: string) => (await s.stock.overview()).stores.find((x) => x.villa.id === villaId)?.levels.find((l) => l.item.code === code)?.onHand ?? 0
const itemId = async (code: string) => (await s.stock.overview()).items.find((i) => i.code === code)?.id ?? ''

beforeEach(() => {
  s = createServices(createMockPorts(fixedClock(TODAY), 0))
})

describe('stock', () => {
  it('seeds a store per open villa, kits per room type, minibar links and one low item', async () => {
    const o = await s.stock.overview()
    expect(o.items.filter((i) => i.kind === 'minibar')).toHaveLength(12)
    expect(o.items.filter((i) => i.kind === 'amenity')).toHaveLength(10)
    expect(o.stores.filter((x) => x.levels.length > 0).map((x) => x.villa.id).sort()).toEqual(['vil-karang', 'vil-lumbung', 'vil-saka', 'vil-tirta'])
    expect(o.low.map((l) => `${l.villaId} ${l.item.code}`)).toEqual(['vil-lumbung AM-SLIPPERS'])
    expect(o.kits.every((k) => k.lines.length > 0 || k.group.villaId === 'vil-pandawa')).toBe(true)
    expect(o.links.filter((l) => l.stockItemId).length).toBe(o.links.length)
    expect(new Set(o.movements.map((m) => m.kind))).toEqual(new Set(['receipt', 'issue', 'transfer', 'write_off', 'adjustment']))
    expect((await s.dashboard.attention()).lowStock).toHaveLength(1)
  })

  it('books a purchase in, moves the average cost and submits the cash-out with the receipt rule', async () => {
    await signIn('kadek')
    const wine = await itemId('MB-WINE')
    const before = await onHand('vil-karang', 'MB-WINE')
    const input = { villaId: 'vil-karang', supplier: 'Bintang Supermarket', lines: [{ itemId: wine, quantity: 10, unitCost: 200_000 }], method: 'cash' as const, reference: 'BS/77', attachments: [], receivedOn: TODAY }
    await expect(s.stock.receive(input)).rejects.toMatchObject({ code: 'PROOF_REQUIRED' })
    const receipt = await s.stock.receive({ ...input, lines: [{ itemId: wine, quantity: 4, unitCost: 200_000 }] })
    expect(await onHand('vil-karang', 'MB-WINE')).toBe(before + 4)
    const o = await s.stock.overview()
    const row = o.receipts.find((r) => r.id === receipt.id)
    expect(row?.entry).toMatchObject({ status: 'submitted', kind: 'cash_out', amount: 800_000, categoryId: 'cat-minibar', origin: 'stock', accountId: 'cb-uluwatu' })
    expect(o.items.find((i) => i.id === wine)?.averageCost).toBeGreaterThan(160_000)
  })

  it('refuses to issue, transfer or write off more than the store holds', async () => {
    await signIn('kadek')
    const towel = await itemId('LN-TOWEL')
    const held = await onHand('vil-karang', 'LN-TOWEL')
    const base = { villaId: 'vil-karang', unitId: null, toVillaId: null, reason: 'Torn', lines: [{ itemId: towel, quantity: held + 1 }] }
    await expect(s.stock.move({ ...base, kind: 'write_off' })).rejects.toMatchObject({ code: 'STOCK_SHORT' })
    await expect(s.stock.move({ ...base, kind: 'issue', unitId: 'unit-kr-01' })).rejects.toMatchObject({ code: 'STOCK_SHORT' })
    const moved = await s.stock.move({ ...base, kind: 'transfer', toVillaId: 'vil-tirta', lines: [{ itemId: towel, quantity: 2 }] })
    expect(moved.map((m) => m.quantity).sort()).toEqual([-2, 2])
    expect(await onHand('vil-karang', 'LN-TOWEL')).toBe(held - 2)
  })

  it('posts a count variance as adjustments in the counter’s name', async () => {
    await signIn('kadek')
    const sheet = await s.stock.countSheet('vil-tirta')
    const [first, second] = sheet
    if (!first || !second) throw new Error('empty sheet')
    const count = await s.stock.count({ villaId: 'vil-tirta', countedBy: 'Made Sutama', note: '', lines: [{ itemId: first.item.id, counted: first.onHand - 3 }, { itemId: second.item.id, counted: second.onHand }] })
    const o = await s.stock.overview()
    expect(o.counts.find((c) => c.id === count.id)).toMatchObject({ changed: 1, variance: -3 * first.item.averageCost })
    expect(o.movements.find((m) => m.countId === count.id)).toMatchObject({ kind: 'adjustment', quantity: -3, by: 'Made Sutama' })
  })

  it('issues the kit when a turnover is released and warns, without blocking, when the store is short', async () => {
    await signIn('kadek')
    const turnover = async (unitId: string) => {
      const state = (await s.maintenance.housekeeping()).rows.find((r) => r.place.unit.id === unitId)?.state
      if (state === 'ready') await s.maintenance.setHousekeeping(unitId, 'dirty')
      if (state !== 'cleaning' && state !== 'inspected') await s.maintenance.setHousekeeping(unitId, 'cleaning')
      if (state !== 'inspected') await s.maintenance.inspect(unitId, [{ item: 'bed', ok: true }], false)
      return s.maintenance.setHousekeeping(unitId, 'ready')
    }
    const soap = await onHand('vil-karang', 'AM-SOAP')
    const ready = await turnover('unit-kr-02')
    expect(ready.note).toBe('')
    expect(await onHand('vil-karang', 'AM-SOAP')).toBe(soap - 4)

    // A Lumbung loft takes two pairs of slippers; drain the store to one and the release still goes through.
    const slippers = await itemId('AM-SLIPPERS')
    await s.stock.move({ kind: 'write_off', villaId: 'vil-lumbung', unitId: null, toVillaId: null, reason: 'Wet in storage', lines: [{ itemId: slippers, quantity: (await onHand('vil-lumbung', 'AM-SLIPPERS')) - 1 }] })
    const released = await turnover('unit-lb-01')
    expect(released.state).toBe('ready')
    expect(released.note).toBe('Amenity kit short: Bath slippers 1')
    expect(await onHand('vil-lumbung', 'AM-SLIPPERS')).toBe(0)
  })

  it('bills a minibar check through room service and restocks from the store', async () => {
    await signIn('wayan')
    const options = await s.orders.formOptions()
    const stay = options.stays.find((b) => b.status === 'checked_in' && b.place.villa.id === 'vil-saka')
    if (!stay) throw new Error('no Saka guest')
    const sheet = await s.stock.minibarSheet(stay.id)
    const beer = sheet.lines.find((l) => l.stock?.code === 'MB-BINTANG-L')
    if (!beer) throw new Error('no beer')
    const before = await onHand('vil-saka', 'MB-BINTANG-L')
    const order = await s.stock.minibarCheck({ bookingId: stay.id, restock: true, note: '', lines: [{ menuItemId: beer.menuItem.id, quantity: 2 }] })
    expect(order).toMatchObject({ status: 'delivered', placedBy: 'staff' })
    expect(await onHand('vil-saka', 'MB-BINTANG-L')).toBe(before - 2)
    const bill = await s.orders.forStay(stay.id)
    expect(bill.orders.find((o) => o.id === order.id)?.payState).toBe('unpaid')
    expect(bill.outstanding).toBeGreaterThanOrEqual(2 * beer.menuItem.price)
    await expect(s.stock.minibarCheck({ bookingId: stay.id, restock: true, note: '', lines: [{ menuItemId: beer.menuItem.id, quantity: 50 }] })).rejects.toMatchObject({ code: 'STOCK_SHORT' })
    expect((await s.orders.forStay(stay.id)).orders.length).toBe(bill.orders.length)

    await signIn('kadek')
    const sales = await s.reports.run('minibar-sales', { from: TODAY, to: TODAY, villaId: 'vil-saka' })
    expect(sales.rows.find((r) => r.item === 'Bintang large')).toMatchObject({ quantity: 2 })
  })

  it('takes a delivered minibar order out of the villa store', async () => {
    await signIn('kadek')
    const board = await s.orders.board()
    const open = board.list.find((o) => o.status === 'preparing' && o.lines.some((l) => l.category === 'minibar'))
    if (!open) throw new Error('no minibar order')
    const before = await onHand(open.villaId, 'MB-BINTANG-L')
    await s.orders.transition(open.id, 'delivered')
    expect(await onHand(open.villaId, 'MB-BINTANG-L')).toBe(before - 2)
    expect((await s.stock.overview()).movements.find((m) => m.orderId === open.id)?.kind).toBe('minibar_sale')
  })

  it('runs the stock reports', async () => {
    for (const slug of ['stock-on-hand', 'stock-movements', 'amenity-consumption']) {
      const r = await s.reports.run(slug, { from: '2026-09-05', to: TODAY })
      expect(r.rows.length, slug).toBeGreaterThan(0)
    }
    const onHandReport = await s.reports.run('stock-on-hand', { to: TODAY, villaId: 'vil-lumbung' })
    expect(onHandReport.rows.find((r) => r.kind === 'Guest amenity')?.low).toBe(1)
    const use = await s.reports.run('amenity-consumption', { from: '2026-09-05', to: TODAY, villaId: 'vil-saka' })
    expect(Number(use.rows[0]?.nights)).toBeGreaterThan(0)
  })
})
