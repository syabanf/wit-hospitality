import type { Booking } from '@/domain/booking'
import type { Catalog } from '@/domain/property'
import type { MenuItem } from '@/domain/serviceOrder'
import { averageAfterReceipt, onHand, type AmenityKit, type MinibarLink, type StockCount, type StockItem, type StockLine, type StockMovement, type StockReceipt } from '@/domain/stock'
import { addDays, type IsoDate } from '@/lib/dates'

const item = (code: string, name: string, kind: StockItem['kind'], unit: StockItem['unit'], reorderLevel: number, averageCost: number, par = 0): StockItem => ({
  id: `stk-${code.toLowerCase()}`,
  code,
  name,
  kind,
  unit,
  reorderLevel,
  par,
  averageCost,
  active: true,
})

/** Twelve minibar lines, ten amenities and two linen items, stocked by every open villa. */
export const STOCK_ITEMS: readonly StockItem[] = [
  item('MB-BINTANG-L', 'Bintang large', 'minibar', 'bottle', 6, 32_000, 2),
  item('MB-BINTANG-S', 'Bintang small', 'minibar', 'can', 8, 22_000, 4),
  item('MB-WATER', 'Mineral water 1.5 L', 'minibar', 'bottle', 8, 7_000, 2),
  item('MB-SPARKLING', 'Sparkling water', 'minibar', 'bottle', 6, 15_000, 2),
  item('MB-COLA', 'Coca-Cola', 'minibar', 'can', 6, 8_000, 2),
  item('MB-SPRITE', 'Sprite', 'minibar', 'can', 6, 8_000, 2),
  item('MB-JUICE', 'Orange juice', 'minibar', 'bottle', 6, 12_000, 2),
  item('MB-CHIPS', 'Potato chips', 'minibar', 'pack', 6, 15_000, 2),
  item('MB-CASHEW', 'Roasted cashews', 'minibar', 'pack', 4, 22_000, 1),
  item('MB-CHOC', 'Dark chocolate', 'minibar', 'piece', 6, 14_000, 2),
  item('MB-WINE', 'Red wine, half bottle', 'minibar', 'bottle', 3, 160_000, 1),
  item('MB-ARAK', 'Arak Bali', 'minibar', 'bottle', 3, 45_000, 1),
  item('AM-SOAP', 'Bar soap', 'amenity', 'piece', 20, 3_500),
  item('AM-SHAMPOO', 'Shampoo 30 ml', 'amenity', 'bottle', 20, 4_000),
  item('AM-COND', 'Conditioner 30 ml', 'amenity', 'bottle', 20, 4_000),
  item('AM-GEL', 'Shower gel 30 ml', 'amenity', 'bottle', 20, 4_000),
  item('AM-LOTION', 'Body lotion 30 ml', 'amenity', 'bottle', 15, 3_500),
  item('AM-DENTAL', 'Dental kit', 'amenity', 'set', 15, 5_000),
  item('AM-SLIPPERS', 'Bath slippers', 'amenity', 'pair', 12, 12_000),
  item('AM-WATER', 'Welcome water 600 ml', 'amenity', 'bottle', 24, 3_000),
  item('AM-COFFEE', 'Kintamani coffee sachet', 'amenity', 'pack', 20, 6_000),
  item('AM-TEA', 'Tea bags', 'amenity', 'pack', 20, 2_000),
  item('LN-TOWEL', 'Bath towel', 'linen', 'piece', 10, 85_000),
  item('LN-SHEET', 'Bed sheet set', 'linen', 'set', 6, 250_000),
]

const id = (code: string) => `stk-${code.toLowerCase()}`
const lines = (pairs: ReadonlyArray<[string, number]>): StockLine[] => pairs.map(([code, quantity]) => ({ itemId: id(code), quantity }))
const ONE_BED: ReadonlyArray<[string, number]> = [['AM-SOAP', 2], ['AM-SHAMPOO', 2], ['AM-COND', 2], ['AM-GEL', 2], ['AM-LOTION', 1], ['AM-DENTAL', 2], ['AM-SLIPPERS', 2], ['AM-WATER', 2], ['AM-COFFEE', 2], ['AM-TEA', 2]]

/** The turnover kit per room type; the two-bedroom cliff villas get twice the bathroom set. */
export const AMENITY_KITS: readonly AmenityKit[] = [
  { groupId: 'grp-saka-standard', lines: lines(ONE_BED) },
  { groupId: 'grp-tirta-pool', lines: lines(ONE_BED) },
  { groupId: 'grp-tirta-garden', lines: lines(ONE_BED.filter(([code]) => code !== 'AM-LOTION')) },
  { groupId: 'grp-lumbung-loft', lines: lines(ONE_BED) },
  { groupId: 'grp-karang-cliff', lines: lines(ONE_BED.map(([code, q]) => [code, code === 'AM-COFFEE' || code === 'AM-TEA' ? q : q * 2])) },
]

/** Menu slug to stock code, for every minibar line on the card. */
const MINIBAR_STOCK: Record<string, string> = {
  bintang: 'MB-BINTANG-L',
  'bintang-small': 'MB-BINTANG-S',
  water: 'MB-WATER',
  sparkling: 'MB-SPARKLING',
  cola: 'MB-COLA',
  sprite: 'MB-SPRITE',
  juice: 'MB-JUICE',
  chips: 'MB-CHIPS',
  cashews: 'MB-CASHEW',
  chocolate: 'MB-CHOC',
  wine: 'MB-WINE',
  arak: 'MB-ARAK',
}

/** Villas with a store; Pandawa is closed for renovation and keeps none. */
const STORES = ['vil-saka', 'vil-tirta', 'vil-lumbung', 'vil-karang'] as const
const KEEPER = 'Wayan Sudiarta'
const MANAGER = 'Kadek Ariani'
/** The one item the seed leaves under its reorder level, so the alert shows. */
const LOW = { villaId: 'vil-lumbung', itemId: id('AM-SLIPPERS'), left: 5 }

interface SeedInput {
  today: IsoDate
  catalog: Catalog
  bookings: readonly Booking[]
  menu: readonly MenuItem[]
  /** Books the posted cash-out of a recent purchase and returns its id. */
  purchaseEntry: (r: Pick<StockReceipt, 'villaId' | 'receivedOn' | 'method' | 'reference' | 'supplier'> & { amount: number; minibar: boolean }) => string
}

/**
 * Thirty days of stock per open villa: opening stock sized so every store ends comfortable but one,
 * a kit issued on each check-out, minibar restocks, a transfer, a write-off, a count and a recent purchase.
 */
export function seedStock({ today, catalog, bookings, menu, purchaseEntry }: SeedInput) {
  const day = (offset: number) => addDays(today, offset)
  const items = STOCK_ITEMS.map((i) => ({ ...i }))
  const movements: StockMovement[] = []
  const receipts: StockReceipt[] = []
  const counts: StockCount[] = []
  const add = (fields: Pick<StockMovement, 'villaId' | 'itemId' | 'kind' | 'quantity' | 'on'> & Partial<StockMovement>) => {
    const n = movements.length + 1
    const cost = items.find((i) => i.id === fields.itemId)?.averageCost ?? 0
    movements.push({ id: `sm-${n}`, number: `SM-${1000 + n}`, unitCost: cost, by: KEEPER, unitId: null, bookingId: null, orderId: null, receiptId: null, countId: null, transferId: null, otherVillaId: null, reason: '', ...fields })
  }
  const kitOf = (unitId: string) => AMENITY_KITS.find((k) => k.groupId === catalog.unit(unitId).groupId)

  // What the month takes out of each store, so the opening stock can cover it.
  const turnovers = bookings.filter((b) => b.status === 'checked_out' && b.unitAssigned && b.checkOut >= day(-28) && b.checkOut < today && kitOf(b.unitId))
  const restocks = turnovers.filter((_, i) => i % 3 === 0)
  const used = new Map<string, number>()
  const take = (villaId: string, l: StockLine) => used.set(`${villaId}|${l.itemId}`, (used.get(`${villaId}|${l.itemId}`) ?? 0) + l.quantity)
  for (const b of turnovers) for (const l of kitOf(b.unitId)?.lines ?? []) take(catalog.unit(b.unitId).villaId, l)
  const restockLines = () => lines([['MB-BINTANG-L', 1], ['MB-WATER', 2], ['MB-CHIPS', 1], ['MB-COLA', 1]])
  for (const b of restocks) for (const l of restockLines()) take(catalog.unit(b.unitId).villaId, l)
  take('vil-saka', { itemId: id('LN-TOWEL'), quantity: 12 })
  take('vil-karang', { itemId: id('LN-SHEET'), quantity: 2 })

  for (const villaId of STORES) {
    const units = catalog.units.filter((u) => u.villaId === villaId).length
    const receiptLines = items
      .filter((i) => i.kind !== 'linen' || villaId !== 'vil-tirta')
      .map((i) => {
        const left = villaId === LOW.villaId && i.id === LOW.itemId ? LOW.left : i.reorderLevel * 2 + units * (i.kind === 'linen' ? 2 : 1)
        return { itemId: i.id, quantity: (used.get(`${villaId}|${i.id}`) ?? 0) + left, unitCost: i.averageCost }
      })
    const r: StockReceipt = { id: `srx-${receipts.length + 1}`, number: `SR-${300 + receipts.length + 1}`, villaId, supplier: 'Opening stock', lines: receiptLines, method: 'bank_transfer', reference: 'OPENING', attachments: [], receivedOn: day(-30), transactionId: null, createdBy: MANAGER, createdOn: day(-30) }
    receipts.push(r)
    for (const l of r.lines) add({ villaId, itemId: l.itemId, kind: 'receipt', quantity: l.quantity, unitCost: l.unitCost, on: r.receivedOn, by: MANAGER, receiptId: r.id, reason: 'Opening stock' })
  }

  for (const b of turnovers) {
    const unit = catalog.unit(b.unitId)
    for (const l of kitOf(b.unitId)?.lines ?? []) add({ villaId: unit.villaId, itemId: l.itemId, kind: 'issue', quantity: -l.quantity, on: b.checkOut, unitId: unit.id, bookingId: b.id, reason: `Amenity kit, ${unit.code} ready` })
  }
  for (const b of restocks) {
    const unit = catalog.unit(b.unitId)
    for (const l of restockLines()) add({ villaId: unit.villaId, itemId: l.itemId, kind: 'issue', quantity: -l.quantity, on: b.checkOut, unitId: unit.id, bookingId: b.id, reason: `Minibar restock, ${unit.code}` })
  }
  // Twelve towels went to Tirta, which keeps no linen of its own; two sheets at Karang were past saving.
  const towel = id('LN-TOWEL')
  add({ villaId: 'vil-saka', itemId: towel, kind: 'transfer', quantity: -12, on: day(-12), by: MANAGER, transferId: 'stf-1', otherVillaId: 'vil-tirta', reason: 'Tirta laundry backlog' })
  add({ villaId: 'vil-tirta', itemId: towel, kind: 'transfer', quantity: 12, on: day(-12), by: MANAGER, transferId: 'stf-1', otherVillaId: 'vil-saka', reason: 'Tirta laundry backlog' })
  add({ villaId: 'vil-karang', itemId: id('LN-SHEET'), kind: 'write_off', quantity: -2, on: day(-6), by: MANAGER, reason: 'Stained beyond cleaning' })

  // Last week's Saka count found one chocolate bar missing and a spare can of Sprite.
  const counted: ReadonlyArray<[string, number]> = [['MB-CHOC', -1], ['MB-SPRITE', 1]]
  const countLines = items.filter((i) => i.kind === 'minibar').map((i) => {
    const expected = onHand(movements, 'vil-saka', i.id, day(-4))
    return { itemId: i.id, expected, counted: expected + (counted.find(([code]) => id(code) === i.id)?.[1] ?? 0), unitCost: i.averageCost }
  })
  const count: StockCount = { id: 'scx-1', number: 'SC-101', villaId: 'vil-saka', countedBy: KEEPER, countedOn: day(-4), lines: countLines, note: 'Monthly minibar store count' }
  counts.push(count)
  for (const l of countLines) if (l.counted !== l.expected) add({ villaId: 'vil-saka', itemId: l.itemId, kind: 'adjustment', quantity: l.counted - l.expected, on: count.countedOn, by: KEEPER, countId: count.id, reason: `Count ${count.number} by ${KEEPER}` })

  // A top-up two days ago, bought dearer than the opening stock, so the average cost moved.
  const purchase = lines([['MB-BINTANG-L', 24], ['MB-WATER', 24]]).map((l) => ({ ...l, unitCost: l.itemId === id('MB-WATER') ? 7_500 : 34_000 }))
  const recent: StockReceipt = { id: `srx-${receipts.length + 1}`, number: `SR-${300 + receipts.length + 1}`, villaId: 'vil-saka', supplier: 'Pepito Market Canggu', lines: purchase, method: 'cash', reference: 'PPT/2210/118', attachments: [], receivedOn: day(-2), transactionId: null, createdBy: MANAGER, createdOn: day(-2) }
  recent.transactionId = purchaseEntry({ ...recent, amount: purchase.reduce((s, l) => s + l.quantity * l.unitCost, 0), minibar: true })
  receipts.push(recent)
  for (const l of purchase) {
    const i = items.find((x) => x.id === l.itemId)
    const held = movements.filter((m) => m.itemId === l.itemId).reduce((s, m) => s + m.quantity, 0)
    if (i) i.averageCost = averageAfterReceipt(i.averageCost, held, l.quantity, l.unitCost)
    add({ villaId: recent.villaId, itemId: l.itemId, kind: 'receipt', quantity: l.quantity, unitCost: l.unitCost, on: recent.receivedOn, by: MANAGER, receiptId: recent.id, reason: recent.supplier })
  }

  const links: MinibarLink[] = menu.filter((m) => m.category === 'minibar').flatMap((m) => {
    const code = MINIBAR_STOCK[m.id.replace(/^mi-[a-z]+-/, '')]
    return code ? [{ menuItemId: m.id, stockItemId: id(code) }] : []
  })

  return { items, movements, receipts, counts, kits: AMENITY_KITS.map((k) => ({ ...k, lines: k.lines.map((l) => ({ ...l })) })), links, next: { stockMovement: movements.length + 1, stockReceipt: receipts.length + 1, stockCount: counts.length + 1, stockTransfer: 2 } }
}
