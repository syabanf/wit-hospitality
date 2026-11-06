import type { StockPort } from '@/application/ports'
import { can, type AuditAction, type User } from '@/domain/access'
import { findById, RuleError } from '@/domain/errors'
import type { Transaction, TransactionEvent } from '@/domain/finance'
import type { OrderLine, ServiceOrder } from '@/domain/serviceOrder'
import { orderSummary, orderTotals } from '@/domain/serviceOrder'
import {
  assertCanTake,
  averageAfterReceipt,
  averageWithoutReceipt,
  kitIssue,
  onHand,
  receiptTotal,
  validateCount,
  validateKit,
  validateMinibarCheck,
  validateMove,
  validateReceipt,
  validateStockItem,
  type ReceiptInput,
  type ReceiptLine,
  type StockLine,
  type StockMovement,
  type StockReceipt,
} from '@/domain/stock'
import type { MockState } from './state'

type NewTransaction = Omit<Transaction, 'id' | 'number' | 'status' | 'approvals' | 'history' | 'rejectionReason' | 'reversalOf' | 'reversedBy' | 'createdBy' | 'createdById' | 'createdOn'>

/** The mock API's shared helpers the stock tables need. */
export interface StockContext {
  s: MockState
  later: <T>(value: () => T) => Promise<T>
  today: () => string
  clockNow: () => string
  minuteNow: () => number
  user: () => User
  seq: (key: string) => number
  refuse: (errors: Record<string, string | undefined>) => void
  log: (action: AuditAction, entity: string, entityId: string, summary: string, before?: Record<string, unknown> | null, after?: Record<string, unknown> | null, actor?: User) => void
  newTransaction: (fields: NewTransaction, submit: boolean, me?: User) => Transaction
  resubmit: (t: Transaction, fields: Partial<Transaction>, note: string, me?: User) => void
  event: (kind: TransactionEvent['kind'], note?: string, actor?: User) => TransactionEvent
}

/**
 * Villa stores for the mock API: on hand is the sum of the movements, nothing leaves a store it is not in,
 * and purchases go through the same cash-out and approval path as a work order expense.
 */
export function createStockAdapter({ s, later, today, clockNow, minuteNow, user, seq, refuse, log, newTransaction, resubmit, event }: StockContext) {
  const copy = <T>(v: T): T => structuredClone(v)
  const villa = (id: string) => s.catalog().villa(id)
  const stockItem = (id: string) => findById(s.stockItems, id, 'stock item')
  const held = (villaId: string, itemId: string) => onHand(s.stockMovements, villaId, itemId)

  function push(fields: Pick<StockMovement, 'villaId' | 'itemId' | 'kind' | 'quantity'> & Partial<StockMovement>, actor: User): StockMovement {
    const n = seq('stockMovement')
    const m: StockMovement = { id: `sm-${n}`, number: `SM-${1000 + n}`, unitCost: stockItem(fields.itemId).averageCost, on: today(), by: actor.name, unitId: null, bookingId: null, orderId: null, receiptId: null, countId: null, transferId: null, otherVillaId: null, reason: '', ...fields }
    s.stockMovements.push(m)
    return m
  }

  /** Checks every line against the store before any of them moves. */
  function take(villaId: string, lines: readonly StockLine[], fields: Pick<StockMovement, 'kind'> & Partial<StockMovement>, actor: User) {
    for (const l of lines) assertCanTake(stockItem(l.itemId), held(villaId, l.itemId), l.quantity, villa(villaId).name)
    return lines.map((l) => push({ ...fields, villaId, itemId: l.itemId, quantity: -l.quantity }, actor))
  }

  /** Stock held across every villa, which the average cost is weighted over. */
  const heldEverywhere = (itemId: string) => s.stockMovements.filter((m) => m.itemId === itemId).reduce((sum, m) => sum + m.quantity, 0)

  /** The cash-out a purchase submits: from the location's cashbox for cash, the bank for a transfer. */
  function purchaseFields(input: ReceiptInput, number: string) {
    const v = villa(input.villaId)
    const box = s.cashAccounts.find((a) => a.kind === 'cashbox' && a.locationId === v.locationId)
    const bank = s.cashAccounts.find((a) => a.kind === 'bank')
    const account = input.method === 'cash' ? (box ?? bank) : (bank ?? box)
    if (!account) throw new RuleError('VALIDATION_ERROR', 'No account to pay from.')
    const minibarOnly = input.lines.every((l) => stockItem(l.itemId).kind === 'minibar')
    return { accountId: account.id, kind: 'cash_out' as const, categoryId: minibarOnly ? 'cat-minibar' : 'cat-house', amount: receiptTotal(input), date: input.receivedOn, locationId: v.locationId, villaId: v.id, description: `${number} stock purchase, ${input.supplier.trim()}`, reference: input.reference.trim() || number, attachments: [...input.attachments] }
  }

  /** A rejected purchase the signed-in person may still fix or cancel: its author, or someone who approves maintenance. */
  function rejectedPurchase(id: string, me: User) {
    const receipt = findById(s.stockReceipts, id, 'stock receipt')
    const t = s.transactions.find((x) => x.id === receipt.transactionId)
    if (!t) throw new RuleError('VALIDATION_ERROR', `${receipt.number} is opening stock with no cash-out.`)
    if (receipt.cancelledOn) throw new RuleError('TRANSACTION_INVALID_STATE', `${receipt.number} was cancelled on ${receipt.cancelledOn}.`)
    if (t.status !== 'rejected') throw new RuleError('TRANSACTION_INVALID_STATE', `${t.number} is ${t.status}; only a rejected purchase can be corrected or cancelled.`)
    if (t.createdById !== me.id && !can(s.permissions, me.role, 'maintenance', 'approve')) throw new RuleError('FORBIDDEN', `Only ${t.createdBy} or a manager can fix ${receipt.number}.`)
    return { receipt, t }
  }

  /** Refuses a change that would take back stock the store has already used. */
  function assertStillHeld(receipt: StockReceipt, itemId: string, out: number) {
    const left = held(receipt.villaId, itemId)
    if (out > left)
      throw new RuleError('STOCK_SHORT', `${villa(receipt.villaId).name} holds ${left} ${stockItem(itemId).name}, but taking back ${receipt.number} needs ${out}; the rest is already used. Correct the receipt down to what is left, or count the store first.`)
  }

  /** Takes a receipt line back out of the item's average cost. */
  function unwindAverage(line: ReceiptLine) {
    const item = stockItem(line.itemId)
    item.averageCost = averageWithoutReceipt(item.averageCost, heldEverywhere(line.itemId), line.quantity, line.unitCost)
  }

  /** Minibar menu lines with the stock they sell, quantities added up per stock item. */
  function minibarStock(lines: ReadonlyArray<Pick<OrderLine, 'itemId' | 'quantity'>>): StockLine[] {
    const by = new Map<string, number>()
    for (const l of lines) {
      const link = s.minibarLinks.find((k) => k.menuItemId === l.itemId)
      if (link) by.set(link.stockItemId, (by.get(link.stockItemId) ?? 0) + l.quantity)
    }
    return [...by].map(([itemId, quantity]) => ({ itemId, quantity }))
  }

  const port: StockPort = {
    items: () => later(() => copy(s.stockItems)),
    createItem: (input) =>
      later(() => {
        refuse(validateStockItem(input, s.stockItems))
        const item = { ...input, name: input.name.trim(), id: `stk-${seq('stockItem')}-${input.code.toLowerCase()}`, averageCost: 0 }
        s.stockItems.push(item)
        log('create', 'stock-item', item.code, `Added stock item ${item.code}, ${item.name}`)
        return copy(item)
      }),
    updateItem: (id, input) =>
      later(() => {
        refuse(validateStockItem(input, s.stockItems, id))
        const item = stockItem(id)
        const before = { reorderLevel: item.reorderLevel, par: item.par, active: item.active }
        Object.assign(item, { ...input, name: input.name.trim() })
        log('update', 'stock-item', item.code, `Edited stock item ${item.code}`, before, { reorderLevel: item.reorderLevel, par: item.par, active: item.active })
        return copy(item)
      }),
    movements: () => later(() => copy(s.stockMovements)),
    receipts: () => later(() => copy(s.stockReceipts)),
    receive: (input) =>
      later(() => {
        refuse(validateReceipt(input))
        const me = user()
        const v = villa(input.villaId)
        const n = seq('stockReceipt')
        const number = `SR-${300 + n}`
        // The cash-out goes first: a missing receipt refuses it before any stock is booked in.
        const t = newTransaction({ ...purchaseFields(input, number), unitId: null, bookingId: null, origin: 'stock', transferId: null }, true, me)
        const receipt = { id: `srx-${n}`, number, villaId: v.id, supplier: input.supplier.trim(), lines: input.lines.map((l) => ({ ...l })), method: input.method, reference: input.reference.trim(), attachments: [...input.attachments], receivedOn: input.receivedOn, transactionId: t.id, createdBy: me.name, createdOn: today() }
        s.stockReceipts.push(receipt)
        for (const l of input.lines) {
          const item = stockItem(l.itemId)
          item.averageCost = averageAfterReceipt(item.averageCost, heldEverywhere(l.itemId), l.quantity, l.unitCost)
          push({ villaId: v.id, itemId: l.itemId, kind: 'receipt', quantity: l.quantity, unitCost: l.unitCost, on: input.receivedOn, receiptId: receipt.id, reason: receipt.supplier }, me)
        }
        log('create', 'stock-receipt', number, `Received ${input.lines.length} items into ${v.name} from ${receipt.supplier}, ${t.number} for approval`, null, { amount: t.amount })
        return copy(receipt)
      }),
    correctReceipt: (id, input) =>
      later(() => {
        const me = user()
        const { receipt, t } = rejectedPurchase(id, me)
        const full = { ...input, villaId: receipt.villaId }
        refuse(validateReceipt(full))
        for (const l of input.lines) stockItem(l.itemId)
        // Every item is checked before anything moves: a smaller quantity may not take back stock already used.
        for (const old of receipt.lines) assertStillHeld(receipt, old.itemId, old.quantity - (input.lines.find((l) => l.itemId === old.itemId)?.quantity ?? 0))
        const before = { amount: t.amount, lines: receipt.lines.length }
        resubmit(t, purchaseFields(full, receipt.number), `Corrected from ${receipt.number}`, me)
        // Reverse the old receipt in the average and the movements, then book the corrected one in.
        for (const old of receipt.lines) unwindAverage(old)
        const replaced = s.stockMovements.filter((m) => m.receiptId === receipt.id)
        s.stockMovements = s.stockMovements.filter((m) => m.receiptId !== receipt.id)
        for (const l of input.lines) {
          const item = stockItem(l.itemId)
          item.averageCost = averageAfterReceipt(item.averageCost, heldEverywhere(l.itemId), l.quantity, l.unitCost)
          const same = replaced.find((m) => m.itemId === l.itemId)
          const fields = { quantity: l.quantity, unitCost: l.unitCost, on: input.receivedOn, reason: input.supplier.trim() }
          if (same) s.stockMovements.push({ ...same, ...fields })
          else push({ ...fields, villaId: receipt.villaId, itemId: l.itemId, kind: 'receipt', receiptId: receipt.id }, me)
        }
        Object.assign(receipt, { supplier: input.supplier.trim(), lines: input.lines.map((l) => ({ ...l })), method: input.method, reference: input.reference.trim(), attachments: [...input.attachments], receivedOn: input.receivedOn })
        log('update', 'stock-receipt', receipt.number, `Corrected ${receipt.number} and resubmitted ${t.number}`, before, { amount: t.amount, lines: receipt.lines.length })
        return copy(receipt)
      }),
    cancelReceipt: (id, reason) =>
      later(() => {
        const me = user()
        const { receipt, t } = rejectedPurchase(id, me)
        refuse({ reason: reason.trim().length < 3 ? 'Say why the purchase is cancelled.' : undefined })
        for (const l of receipt.lines) assertStillHeld(receipt, l.itemId, l.quantity)
        for (const l of receipt.lines) {
          unwindAverage(l)
          push({ villaId: receipt.villaId, itemId: l.itemId, kind: 'receipt', quantity: -l.quantity, unitCost: l.unitCost, receiptId: receipt.id, reason: `Cancelled ${receipt.number}: ${reason.trim()}` }, me)
        }
        receipt.cancelledOn = today()
        t.history = [...t.history, event('rejected', `Closed: ${receipt.number} cancelled. ${reason.trim()}`, me)]
        log('update', 'stock-receipt', receipt.number, `Cancelled ${receipt.number}; its stock left ${villa(receipt.villaId).name} and ${t.number} stays rejected`)
        return copy(receipt)
      }),
    move: (input) =>
      later(() => {
        refuse(validateMove(input))
        const me = user()
        const from = villa(input.villaId)
        const reason = input.reason.trim()
        if (input.kind === 'issue') {
          const unit = s.catalog().unit(input.unitId ?? '')
          if (unit.villaId !== from.id) throw new RuleError('VALIDATION_ERROR', `${unit.code} is not in ${from.name}.`)
          const moved = take(from.id, input.lines, { kind: 'issue', unitId: unit.id, reason: reason || `Issued to ${unit.code}` }, me)
          log('create', 'stock-movement', moved[0]?.number ?? '', `Issued ${input.lines.length} items from ${from.name} to ${unit.code}`)
          return copy(moved)
        }
        if (input.kind === 'transfer') {
          const to = villa(input.toVillaId ?? '')
          const transferId = `stf-${seq('stockTransfer')}`
          const out = take(from.id, input.lines, { kind: 'transfer', transferId, otherVillaId: to.id, reason }, me)
          const back = out.map((m) => push({ villaId: to.id, itemId: m.itemId, kind: 'transfer', quantity: -m.quantity, unitCost: m.unitCost, transferId, otherVillaId: from.id, reason }, me))
          log('create', 'stock-movement', out[0]?.number ?? '', `Moved ${input.lines.length} items from ${from.name} to ${to.name}`)
          return copy([...out, ...back])
        }
        const written = take(from.id, input.lines, { kind: 'write_off', reason }, me)
        log('create', 'stock-movement', written[0]?.number ?? '', `Wrote off ${input.lines.length} items in ${from.name}: ${reason}`)
        return copy(written)
      }),
    counts: () => later(() => copy(s.stockCounts)),
    count: (input) =>
      later(() => {
        refuse(validateCount(input))
        const me = user()
        const v = villa(input.villaId)
        const countedBy = input.countedBy.trim()
        const n = seq('stockCount')
        const count = { id: `scx-${n}`, number: `SC-${100 + n}`, villaId: v.id, countedBy, countedOn: today(), note: input.note.trim(), lines: input.lines.map((l) => ({ itemId: l.itemId, expected: held(v.id, l.itemId), counted: l.counted, unitCost: stockItem(l.itemId).averageCost })) }
        s.stockCounts.push(count)
        for (const l of count.lines) if (l.counted !== l.expected) push({ villaId: v.id, itemId: l.itemId, kind: 'adjustment', quantity: l.counted - l.expected, by: countedBy, countId: count.id, reason: `Count ${count.number} by ${countedBy}` }, me)
        log('create', 'stock-count', count.number, `Counted ${count.lines.length} items in ${v.name}`)
        return copy(count)
      }),
    kits: () => later(() => copy(s.amenityKits)),
    saveKit: (groupId, lines) =>
      later(() => {
        refuse(validateKit(lines))
        const group = s.catalog().group(groupId)
        for (const l of lines) stockItem(l.itemId)
        const kit = { groupId, lines: lines.map((l) => ({ ...l })) }
        s.amenityKits = [...s.amenityKits.filter((k) => k.groupId !== groupId), ...(lines.length ? [kit] : [])]
        log('update', 'amenity-kit', groupId, lines.length ? `Set the ${group.name} amenity kit to ${lines.length} items` : `Removed the ${group.name} amenity kit`)
        return copy(kit)
      }),
    minibarLinks: () => later(() => copy(s.minibarLinks)),
    linkMinibar: (menuItemId, stockItemId) =>
      later(() => {
        const menuItem = findById(s.menu, menuItemId, 'menu item')
        if (menuItem.category !== 'minibar') throw new RuleError('VALIDATION_ERROR', `${menuItem.name} is not on the minibar.`)
        if (stockItemId && stockItem(stockItemId).kind !== 'minibar') throw new RuleError('VALIDATION_ERROR', 'Link a minibar stock item.')
        s.minibarLinks = [...s.minibarLinks.filter((k) => k.menuItemId !== menuItemId), ...(stockItemId ? [{ menuItemId, stockItemId }] : [])]
        log('update', 'minibar-link', menuItemId, stockItemId ? `Linked ${menuItem.name} to ${stockItem(stockItemId).code}` : `Unlinked ${menuItem.name}`)
        return copy(s.minibarLinks)
      }),
    minibarCheck: (input) =>
      later(() => {
        refuse(validateMinibarCheck(input))
        const me = user()
        const b = findById(s.bookings, input.bookingId, 'booking')
        if (b.status !== 'checked_in') throw new RuleError('ORDER_NO_STAY', `${b.code} is not in house; check the minibar while the guest stays.`)
        const unit = s.catalog().unit(b.unitId)
        const lines: OrderLine[] = input.lines
          .filter((l) => l.quantity > 0)
          .map((l) => {
            const item = findById(s.menu, l.menuItemId, 'menu item')
            if (item.villaId !== unit.villaId || item.category !== 'minibar') throw new RuleError('ITEM_UNAVAILABLE', `${item.name} is not in the ${villa(unit.villaId).name} minibar.`)
            return { itemId: item.id, name: item.name, category: item.category, unit: item.unit, price: item.price, quantity: l.quantity, costPrice: 0, partnerId: null, comp: false }
          })
        const n = seq('order')
        const at = minuteNow()
        const note = input.note.trim() || 'Minibar check'
        const order: ServiceOrder = { id: `so-${n}`, number: `SO-${700 + n}`, bookingId: b.id, unitId: unit.id, villaId: unit.villaId, lines, note, requestedOn: today(), requestedAt: at, priority: 'normal', status: 'delivered', assignee: me.name, placedBy: 'staff', createdOn: today(), deliveredOn: today(), deliveredAt: at, discountPct: 0, discountReason: '', compReason: '', paymentId: null, costTransactionIds: [], history: [{ kind: 'placed', by: me.name, at: clockNow(), note }, { kind: 'delivered', by: me.name, at: clockNow(), note: 'Taken from the in-room minibar' }] }
        // The restock leaves the store; refused as a whole when the store runs short, before the order exists.
        if (input.restock) take(unit.villaId, minibarStock(lines), { kind: 'issue', unitId: unit.id, bookingId: b.id, orderId: order.id, reason: `Minibar restock, ${unit.code}` }, me)
        s.orders.push(order)
        log('create', 'service-order', order.number, `Minibar check on ${b.code}: ${orderSummary(order)}`, null, { charge: orderTotals(order).charge })
        return copy(order)
      }),
  }

  return {
    port,
    /** A delivered minibar order came out of the villa store. */
    sell(o: ServiceOrder, actor: User) {
      take(o.villaId, minibarStock(o.lines), { kind: 'minibar_sale', unitId: o.unitId, bookingId: o.bookingId, orderId: o.id, reason: o.number }, actor)
    },
    /** Issues the room type's kit to a unit marked ready; returns what the store was short of, or ''. */
    issueKit(unitId: string, actor: User): string {
      const unit = s.catalog().unit(unitId)
      const kit = s.amenityKits.find((k) => k.groupId === unit.groupId)
      if (!kit) return ''
      const { issue, short } = kitIssue(kit, (itemId) => held(unit.villaId, itemId))
      for (const l of issue) push({ villaId: unit.villaId, itemId: l.itemId, kind: 'issue', quantity: -l.quantity, unitId, reason: `Amenity kit, ${unit.code} ready` }, actor)
      return short.length ? `Amenity kit short: ${short.map((l) => `${stockItem(l.itemId).name} ${l.quantity}`).join(', ')}` : ''
    },
  }
}
