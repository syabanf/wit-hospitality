import type { Action, Module, User } from '@/domain/access'
import { overlapNights } from '@/domain/booking'
import { findById, RuleError } from '@/domain/errors'
import type { Transaction } from '@/domain/finance'
import type { Catalog, Scope } from '@/domain/property'
import { lineAmount } from '@/domain/serviceOrder'
import {
  lineVariance,
  MOVEMENT_KIND_LABEL,
  movementValue,
  receiptStatus,
  receiptTotal,
  sortMovements,
  STOCK_KIND_LABEL,
  STOCK_KINDS,
  storeLevels,
  validateCount,
  validateKit,
  validateMinibarCheck,
  validateMove,
  validateReceipt,
  validateStockItem,
  varianceValue,
  type CountInput,
  type MinibarCheckInput,
  type MoveInput,
  type ReceiptCorrection,
  type ReceiptInput,
  type StockItem,
  type StockItemInput,
  type StockLine,
  type StockMovement,
  type StoreLevel,
} from '@/domain/stock'
import { addDays, type IsoDate } from '@/lib/dates'
import type { Ports } from './ports'
import type { ReportRow } from './views'

export interface StockMovementView extends StockMovement {
  itemName: string
  itemCode: string
  villaName: string
  unitCode: string
  otherVillaName: string
  value: number
}

export interface StoreView {
  villa: Catalog['villas'][number]
  levels: StoreLevel[]
  value: number
  low: StoreLevel[]
}

/** A store item at or under its reorder level, for the bell and the villa page. */
export interface LowStockRow {
  villaId: string
  villaName: string
  item: StockItem
  onHand: number
}

interface Deps {
  ports: Ports
  today: () => IsoDate
  catalog: () => Promise<Catalog>
  allow: (module: Module, action: Action) => Promise<User>
  access: () => Promise<{ user: User; can: (module: Module, action: Action) => boolean }>
  check: (errors: Record<string, string | undefined>) => void
}

/** Villa stores, as the signed-in user may see them: stock levels, movements, receipts, counts, kits and minibar links. */
export function createStockServices({ ports, today, catalog, allow, access, check }: Deps) {
  async function world() {
    const [cat, items, movements, receipts, counts, kits, links, menu, transactions] = await Promise.all([catalog(), ports.stock.items(), ports.stock.movements(), ports.stock.receipts(), ports.stock.counts(), ports.stock.kits(), ports.stock.minibarLinks(), ports.orders.menu(), ports.finance.transactions()])
    const villaIds = new Set(cat.villas.map((v) => v.id))
    const villaName = (id: string | null) => (id ? (cat.villas.find((v) => v.id === id)?.name ?? '') : '')
    const item = (id: string) => findById(items, id, 'stock item')
    const describe = (m: StockMovement): StockMovementView => ({ ...m, itemName: item(m.itemId).name, itemCode: item(m.itemId).code, villaName: villaName(m.villaId), unitCode: m.unitId ? (cat.units.find((u) => u.id === m.unitId)?.code ?? '') : '', otherVillaName: villaName(m.otherVillaId), value: movementValue(m) })
    const mine = movements.filter((m) => villaIds.has(m.villaId))
    const stores: StoreView[] = cat.villas.map((villa) => {
      const levels = storeLevels(items, mine, villa.id)
      return { villa, levels, value: levels.reduce((s, l) => s + l.value, 0), low: levels.filter((l) => l.low) }
    })
    const entry = (id: string | null): Transaction | null => (id ? (transactions.find((t) => t.id === id) ?? null) : null)
    return { cat, items, movements: mine, describe, stores, receipts: receipts.filter((r) => villaIds.has(r.villaId)), counts: counts.filter((c) => villaIds.has(c.villaId)), kits, links, menu: menu.filter((m) => villaIds.has(m.villaId) && m.category === 'minibar'), entry, villaName, item }
  }

  const lowOf = (w: Awaited<ReturnType<typeof world>>): LowStockRow[] => w.stores.flatMap((s) => s.low.map((l) => ({ villaId: s.villa.id, villaName: s.villa.name, item: l.item, onHand: l.onHand })))

  return {
    async overview() {
      const [w, a] = await Promise.all([world(), access()])
      return {
        catalog: w.cat,
        items: w.items,
        stores: w.stores,
        low: lowOf(w),
        movements: sortMovements(w.movements).map(w.describe),
        receipts: [...w.receipts]
          .sort((x, y) => y.receivedOn.localeCompare(x.receivedOn) || y.number.localeCompare(x.number))
          .map((r) => {
            const entry = w.entry(r.transactionId)
            const status = receiptStatus(r, entry)
            // A rejected purchase goes back to its author, or to someone who approves maintenance.
            const mayFix = status === 'rejected' && (entry?.createdById === a.user.id || a.can('maintenance', 'approve')) && a.can('maintenance', 'submit')
            return { ...r, villaName: w.villaName(r.villaId), total: receiptTotal(r), entry, status, mayFix }
          }),
        counts: [...w.counts].sort((a, b) => b.countedOn.localeCompare(a.countedOn)).map((c) => ({ ...c, villaName: w.villaName(c.villaId), variance: varianceValue(c), changed: c.lines.filter((l) => lineVariance(l) !== 0).length })),
        kits: w.cat.groups.map((g) => ({ group: g, villaName: w.villaName(g.villaId), lines: w.kits.find((k) => k.groupId === g.id)?.lines ?? [] })),
        links: w.menu.map((m) => ({ menuItem: m, villaName: w.villaName(m.villaId), stockItemId: w.links.find((k) => k.menuItemId === m.id)?.stockItemId ?? null })),
        today: today(),
      }
    },
    /** Low items across the villas the user may see. */
    async lowStock() {
      return lowOf(await world())
    },
    /** One villa's store, for its page. */
    async villaStore(villaId: string) {
      const w = await world()
      const store = w.stores.find((s) => s.villa.id === villaId) ?? null
      return { store, recent: sortMovements(w.movements.filter((m) => m.villaId === villaId)).slice(0, 5).map(w.describe) }
    },
    async createItem(input: StockItemInput) {
      await allow('maintenance', 'create')
      check(validateStockItem(input, await ports.stock.items()))
      return ports.stock.createItem(input)
    },
    async updateItem(id: string, input: StockItemInput) {
      await allow('maintenance', 'edit')
      check(validateStockItem(input, await ports.stock.items(), id))
      return ports.stock.updateItem(id, input)
    },
    async receive(input: ReceiptInput) {
      await allow('maintenance', 'submit')
      check(validateReceipt(input))
      return ports.stock.receive(input)
    },
    /** Fixes a rejected purchase and resubmits the same cash-out; the store and the average cost follow the corrected lines. */
    async correctReceipt(id: string, input: ReceiptCorrection) {
      await allow('maintenance', 'submit')
      const receipt = findById(await ports.stock.receipts(), id, 'stock receipt')
      check(validateReceipt({ ...input, villaId: receipt.villaId }))
      return ports.stock.correctReceipt(id, input)
    },
    /** Gives up a rejected purchase: the goods leave the store again and the cash-out stays rejected. */
    async cancelReceipt(id: string, reason: string) {
      await allow('maintenance', 'submit')
      check({ reason: reason.trim().length < 3 ? 'Say why the purchase is cancelled.' : undefined })
      return ports.stock.cancelReceipt(id, reason)
    },
    async move(input: MoveInput) {
      await allow('maintenance', 'edit')
      check(validateMove(input))
      return ports.stock.move(input)
    },
    /** The count sheet for one store: every item it carries with what the console expects. */
    async countSheet(villaId: string) {
      const w = await world()
      return w.stores.find((s) => s.villa.id === villaId)?.levels.filter((l) => l.item.active) ?? []
    },
    async count(input: CountInput) {
      await allow('maintenance', 'edit')
      check(validateCount(input))
      return ports.stock.count(input)
    },
    async saveKit(groupId: string, lines: readonly StockLine[]) {
      await allow('maintenance', 'edit')
      const kept = lines.filter((l) => l.quantity > 0)
      check(validateKit(kept))
      return ports.stock.saveKit(groupId, kept)
    },
    async linkMinibar(menuItemId: string, stockItemId: string | null) {
      await allow('maintenance', 'edit')
      return ports.stock.linkMinibar(menuItemId, stockItemId)
    },
    /** The minibar of a stay's villa: what can be checked, its par, and what the store still holds. */
    async minibarSheet(bookingId: string) {
      const [w, bookings] = await Promise.all([world(), ports.booking.bookings()])
      const b = findById(bookings, bookingId, 'booking')
      const villaId = w.cat.unit(b.unitId).villaId
      const store = w.stores.find((s) => s.villa.id === villaId)
      const lines = w.menu
        .filter((m) => m.villaId === villaId && m.active)
        .map((m) => {
          const stockItemId = w.links.find((k) => k.menuItemId === m.id)?.stockItemId ?? null
          const stock = stockItemId ? w.item(stockItemId) : null
          return { menuItem: m, stock, par: stock?.par ?? 0, inStore: stockItemId ? (store?.levels.find((l) => l.item.id === stockItemId)?.onHand ?? 0) : null }
        })
      return { open: b.status === 'checked_in', unitCode: w.cat.unit(b.unitId).code, lines }
    },
    /** What the guest took: a delivered minibar order billed on the stay, through room service and check-out. */
    async minibarCheck(input: MinibarCheckInput) {
      await allow('services', 'create')
      check(validateMinibarCheck(input))
      return ports.stock.minibarCheck({ ...input, lines: input.lines.filter((l) => l.quantity > 0) })
    },

    /** Rows for the stock reports; `to` is inclusive. */
    async reportRows(slug: string, from: IsoDate, to: IsoDate, scope: Scope): Promise<ReportRow[]> {
      const w = await world()
      const villas = w.cat.villas.filter((v) => (!scope.villaId || v.id === scope.villaId) && (!scope.locationId || v.locationId === scope.locationId) && (!scope.unitId || w.cat.unit(scope.unitId).villaId === v.id))
      const ids = new Set(villas.map((v) => v.id))
      const inRange = w.movements.filter((m) => ids.has(m.villaId) && m.on >= from && m.on <= to)
      if (slug === 'stock-on-hand') {
        return villas.flatMap((v) =>
          STOCK_KINDS.flatMap((kind) => {
            const levels = storeLevels(w.items, w.movements, v.id, to).filter((l) => l.item.kind === kind)
            if (levels.length === 0) return []
            return [{ villa: v.name, kind: STOCK_KIND_LABEL[kind], items: levels.length, units: levels.reduce((s, l) => s + l.onHand, 0), value: levels.reduce((s, l) => s + l.value, 0), low: levels.filter((l) => l.low).length }]
          }),
        )
      }
      if (slug === 'stock-movements') {
        return sortMovements(inRange).map((m) => {
          const v = w.describe(m)
          return { date: m.on, number: m.number, villa: v.villaName, item: v.itemName, kind: MOVEMENT_KIND_LABEL[m.kind], quantity: m.quantity, unitCost: m.unitCost, value: v.value, unit: v.unitCode || v.otherVillaName, by: m.by, reason: m.reason }
        })
      }
      if (slug === 'minibar-sales') {
        const orders = (await ports.orders.orders()).filter((o) => ids.has(o.villaId) && o.status === 'delivered' && o.deliveredOn !== null && o.deliveredOn >= from && o.deliveredOn <= to)
        const rows = new Map<string, { item: string; villa: string; quantity: number; orders: number; sales: number; cost: number }>()
        for (const o of orders)
          for (const l of o.lines.filter((x) => x.category === 'minibar')) {
            const stockItemId = w.links.find((k) => k.menuItemId === l.itemId)?.stockItemId
            const row = rows.get(l.itemId) ?? { item: l.name, villa: w.villaName(o.villaId), quantity: 0, orders: 0, sales: 0, cost: 0 }
            row.quantity += l.quantity
            row.orders += 1
            row.sales += l.comp ? 0 : Math.round(lineAmount(l) * (1 - o.discountPct / 100))
            row.cost += stockItemId ? Math.round(l.quantity * w.item(stockItemId).averageCost) : 0
            rows.set(l.itemId, row)
          }
        return [...rows.values()].map((r) => ({ ...r, cost: r.cost ? -r.cost : 0, margin: r.sales - r.cost })).sort((a, b) => b.sales - a.sales)
      }
      if (slug === 'amenity-consumption') {
        const bookings = await ports.booking.bookings()
        const end = addDays(to, 1)
        return villas.flatMap((v) => {
          const units = new Set(w.cat.units.filter((u) => u.villaId === v.id).map((u) => u.id))
          const nights = bookings.filter((b) => units.has(b.unitId) && (b.status === 'checked_in' || b.status === 'checked_out')).reduce((s, b) => s + overlapNights(b.checkIn, b.checkOut, from, end), 0)
          const used = new Map<string, { quantity: number; value: number }>()
          for (const m of inRange.filter((x) => x.villaId === v.id && x.kind === 'issue' && w.item(x.itemId).kind === 'amenity')) {
            const row = used.get(m.itemId) ?? { quantity: 0, value: 0 }
            row.quantity -= m.quantity
            row.value -= movementValue(m)
            used.set(m.itemId, row)
          }
          return [...used].map(([itemId, u]) => ({ villa: v.name, item: w.item(itemId).name, nights, quantity: u.quantity, perNight: nights ? Math.round((u.quantity / nights) * 100) / 100 : 0, value: u.value, valuePerNight: nights ? u.value / nights : 0 }))
        })
      }
      throw new RuleError('VALIDATION_ERROR', `No stock report ${slug}.`)
    },
  }
}

export type StockServices = ReturnType<typeof createStockServices>
