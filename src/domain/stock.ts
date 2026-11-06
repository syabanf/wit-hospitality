import type { IsoDate } from '@/lib/dates'
import type { Attachment } from './attachment'
import { RuleError } from './errors'
import { TRANSACTION_STATUS_LABEL, type Transaction, type TransactionStatus } from './finance'
import type { ExpenseMethod } from './maintenance'

/** What a villa store keeps: drinks and snacks for the minibar, guest amenities, and linen. */
export type StockKind = 'minibar' | 'amenity' | 'linen'
export const STOCK_KINDS: readonly StockKind[] = ['minibar', 'amenity', 'linen']
export const STOCK_KIND_LABEL: Record<StockKind, string> = { minibar: 'Minibar', amenity: 'Guest amenity', linen: 'Linen' }

export type StockUnit = 'piece' | 'bottle' | 'can' | 'pack' | 'pair' | 'set'
export const STOCK_UNITS: readonly StockUnit[] = ['piece', 'bottle', 'can', 'pack', 'pair', 'set']

/** One stock item, shared by every villa; each villa store holds its own quantity of it. */
export interface StockItem {
  id: string
  code: string
  name: string
  kind: StockKind
  unit: StockUnit
  /** A store at or under this quantity shows the item as low. */
  reorderLevel: number
  /** Minibar items only: how many each unit's minibar holds when full. */
  par: number
  /** Rupiah per unit, moved by every receipt. */
  averageCost: number
  active: boolean
}
export type StockItemInput = Omit<StockItem, 'id' | 'averageCost'>

const CODE = /^[A-Z0-9-]{2,16}$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const wholeAtLeast = (n: number, min: number) => Number.isInteger(n) && n >= min

export function validateStockItem(input: StockItemInput, items: readonly StockItem[], excludeId?: string): Partial<Record<keyof StockItemInput, string>> {
  const errors: Partial<Record<keyof StockItemInput, string>> = {}
  if (!CODE.test(input.code)) errors.code = 'Capital letters, digits and dashes, 2 to 16 long.'
  else if (items.some((i) => i.code === input.code && i.id !== excludeId)) errors.code = `${input.code} is already used.`
  if (input.name.trim().length < 2) errors.name = 'Name the item.'
  if (!STOCK_KINDS.includes(input.kind)) errors.kind = 'Pick the kind.'
  if (!STOCK_UNITS.includes(input.unit)) errors.unit = 'Pick the unit.'
  if (!wholeAtLeast(input.reorderLevel, 0)) errors.reorderLevel = 'A whole number, zero or more.'
  if (!wholeAtLeast(input.par, 0)) errors.par = 'A whole number, zero or more.'
  else if (input.par > 0 && input.kind !== 'minibar') errors.par = 'Only minibar items have a par level.'
  return errors
}

export type MovementKind = 'receipt' | 'issue' | 'minibar_sale' | 'adjustment' | 'transfer' | 'write_off'
export const MOVEMENT_KINDS: readonly MovementKind[] = ['receipt', 'issue', 'minibar_sale', 'adjustment', 'transfer', 'write_off']
export const MOVEMENT_KIND_LABEL: Record<MovementKind, string> = { receipt: 'Receipt', issue: 'Issue to unit', minibar_sale: 'Minibar sale', adjustment: 'Count adjustment', transfer: 'Transfer', write_off: 'Write-off' }

/** One change to one item in one villa store; `quantity` is signed, out of the store is negative. */
export interface StockMovement {
  id: string
  number: string
  villaId: string
  itemId: string
  kind: MovementKind
  quantity: number
  /** Rupiah per unit when it moved: the purchase price on a receipt, the average cost otherwise. */
  unitCost: number
  on: IsoDate
  by: string
  unitId: string | null
  bookingId: string | null
  orderId: string | null
  receiptId: string | null
  countId: string | null
  /** Both halves of a transfer share it; `otherVillaId` names the store on the other side. */
  transferId: string | null
  otherVillaId: string | null
  /** Why stock was written off or issued, or what the console did. */
  reason: string
}

export const movementValue = (m: Pick<StockMovement, 'quantity' | 'unitCost'>) => Math.round(m.quantity * m.unitCost)

export function onHand(movements: readonly Pick<StockMovement, 'villaId' | 'itemId' | 'quantity' | 'on'>[], villaId: string, itemId: string, upTo?: IsoDate): number {
  return movements.filter((m) => m.villaId === villaId && m.itemId === itemId && (!upTo || m.on <= upTo)).reduce((s, m) => s + m.quantity, 0)
}

export const isLow = (item: Pick<StockItem, 'reorderLevel'>, quantity: number) => item.reorderLevel > 0 && quantity <= item.reorderLevel

export interface StoreLevel {
  item: StockItem
  onHand: number
  value: number
  low: boolean
}

/** What a villa store holds: every item it has ever moved, with quantity, value and the low flag. */
export function storeLevels(items: readonly StockItem[], movements: readonly StockMovement[], villaId: string, upTo?: IsoDate): StoreLevel[] {
  const carried = new Set(movements.filter((m) => m.villaId === villaId).map((m) => m.itemId))
  return items
    .filter((i) => carried.has(i.id))
    .map((item) => {
      const quantity = onHand(movements, villaId, item.id, upTo)
      return { item, onHand: quantity, value: Math.round(quantity * item.averageCost), low: item.active && isLow(item, quantity) }
    })
}

/** The weighted average after a receipt; stock already held counts at the old average. */
export function averageAfterReceipt(averageCost: number, held: number, quantity: number, unitCost: number): number {
  const before = Math.max(0, held)
  return before + quantity > 0 ? Math.round((before * averageCost + quantity * unitCost) / (before + quantity)) : unitCost
}

/** The average before a receipt, so a corrected or cancelled receipt can be taken back out of it. */
export function averageWithoutReceipt(averageCost: number, held: number, quantity: number, unitCost: number): number {
  const rest = held - quantity
  return rest > 0 ? Math.max(0, Math.round((held * averageCost - quantity * unitCost) / rest)) : averageCost
}

/** Refuses to take more out of a store than it holds. */
export function assertCanTake(item: Pick<StockItem, 'name'>, held: number, quantity: number, storeName: string) {
  if (quantity > held) throw new RuleError('STOCK_SHORT', `${storeName} holds ${held} ${item.name}; ${quantity} cannot leave the store.`)
}

export interface StockLine {
  itemId: string
  quantity: number
}

export interface ReceiptLine extends StockLine {
  unitCost: number
}

/** Goods bought into a villa store; the purchase is a cash-out through approval. */
export interface StockReceipt {
  id: string
  number: string
  villaId: string
  supplier: string
  lines: readonly ReceiptLine[]
  method: ExpenseMethod
  /** The supplier's invoice or receipt number. */
  reference: string
  attachments: readonly Attachment[]
  receivedOn: IsoDate
  /** Null for opening stock that was never bought through the console. */
  transactionId: string | null
  createdBy: string
  createdOn: IsoDate
  /** Set when a rejected purchase was cancelled: its stock left the store again and the cash-out stays rejected for good. */
  cancelledOn?: IsoDate | null
}

/** The purchase status a receipt shows: its cash-out's, or cancelled, or opening stock with no cash-out. */
export type ReceiptStatus = TransactionStatus | 'cancelled' | 'opening'
export const RECEIPT_STATUS_LABEL: Record<ReceiptStatus, string> = { ...TRANSACTION_STATUS_LABEL, cancelled: 'Cancelled', opening: 'Opening stock' }

export function receiptStatus(r: Pick<StockReceipt, 'cancelledOn'>, entry: Pick<Transaction, 'status'> | null): ReceiptStatus {
  if (r.cancelledOn) return 'cancelled'
  return entry?.status ?? 'opening'
}

export interface ReceiptInput {
  villaId: string
  supplier: string
  lines: readonly ReceiptLine[]
  method: ExpenseMethod
  reference: string
  attachments: readonly Attachment[]
  receivedOn: string
}

/** What a correction may change on a rejected receipt; the villa store stays. */
export type ReceiptCorrection = Omit<ReceiptInput, 'villaId'>

export const receiptTotal = (r: Pick<StockReceipt, 'lines'>) => r.lines.reduce((s, l) => s + Math.round(l.quantity * l.unitCost), 0)

const validLines = (lines: readonly StockLine[]) => lines.length > 0 && lines.every((l) => l.itemId && wholeAtLeast(l.quantity, 1)) && new Set(lines.map((l) => l.itemId)).size === lines.length

export function validateReceipt(input: ReceiptInput): Partial<Record<keyof ReceiptInput, string>> {
  const errors: Partial<Record<keyof ReceiptInput, string>> = {}
  if (!input.villaId) errors.villaId = 'Pick the villa store.'
  if (input.supplier.trim().length < 2) errors.supplier = 'Name the shop or supplier.'
  if (!validLines(input.lines)) errors.lines = 'Add each item once, in whole quantities from 1.'
  else if (input.lines.some((l) => !wholeAtLeast(l.unitCost, 1))) errors.lines = 'Enter what each item cost, in whole rupiah.'
  if (input.method !== 'cash' && input.method !== 'bank_transfer') errors.method = 'Pick how it was paid.'
  if (!DATE.test(input.receivedOn)) errors.receivedOn = 'Pick the day the goods arrived.'
  return errors
}

/** Issue to a unit, transfer to another villa store, or write off. */
export type MoveKind = Extract<MovementKind, 'issue' | 'transfer' | 'write_off'>

export interface MoveInput {
  kind: MoveKind
  villaId: string
  /** Issue only. */
  unitId: string | null
  /** Transfer only. */
  toVillaId: string | null
  lines: readonly StockLine[]
  reason: string
}

export function validateMove(input: MoveInput): Partial<Record<keyof MoveInput, string>> {
  const errors: Partial<Record<keyof MoveInput, string>> = {}
  if (!input.villaId) errors.villaId = 'Pick the villa store.'
  if (!validLines(input.lines)) errors.lines = 'Add each item once, in whole quantities from 1.'
  if (input.kind === 'issue' && !input.unitId) errors.unitId = 'Pick the unit.'
  if (input.kind === 'transfer') {
    if (!input.toVillaId) errors.toVillaId = 'Pick the store it goes to.'
    else if (input.toVillaId === input.villaId) errors.toVillaId = 'Pick another villa.'
  }
  if (input.kind === 'write_off' && input.reason.trim().length < 3) errors.reason = 'Say why the stock is written off.'
  return errors
}

export interface CountLine {
  itemId: string
  /** What the console expected on the shelf. */
  expected: number
  counted: number
  unitCost: number
}

/** A shelf count of one villa store; each difference posts as a count adjustment. */
export interface StockCount {
  id: string
  number: string
  villaId: string
  countedBy: string
  countedOn: IsoDate
  lines: readonly CountLine[]
  note: string
}

export interface CountInput {
  villaId: string
  countedBy: string
  lines: ReadonlyArray<{ itemId: string; counted: number }>
  note: string
}

export function validateCount(input: CountInput): Partial<Record<keyof CountInput, string>> {
  const errors: Partial<Record<keyof CountInput, string>> = {}
  if (!input.villaId) errors.villaId = 'Pick the villa store.'
  if (input.countedBy.trim().length < 2) errors.countedBy = 'Name who counted.'
  if (input.lines.length === 0) errors.lines = 'Count at least one item.'
  else if (input.lines.some((l) => !wholeAtLeast(l.counted, 0))) errors.lines = 'Counts are whole numbers, zero or more.'
  return errors
}

export const lineVariance = (l: Pick<CountLine, 'expected' | 'counted'>) => l.counted - l.expected
export const varianceValue = (c: Pick<StockCount, 'lines'>) => c.lines.reduce((s, l) => s + Math.round(lineVariance(l) * l.unitCost), 0)

/** What one room type gets after every turnover: soap, shampoo, water and the rest. */
export interface AmenityKit {
  groupId: string
  lines: readonly StockLine[]
}

export const validateKit = (lines: readonly StockLine[]) => (lines.length === 0 || validLines(lines) ? {} : { lines: 'Add each item once, in whole quantities from 1.' })

/** What a kit takes from a store that may be short: issue what is there and report the rest. */
export function kitIssue(kit: Pick<AmenityKit, 'lines'>, held: (itemId: string) => number) {
  const split = kit.lines.map((l) => ({ itemId: l.itemId, wanted: l.quantity, take: Math.min(l.quantity, Math.max(0, held(l.itemId))) }))
  return {
    issue: split.filter((l) => l.take > 0).map((l) => ({ itemId: l.itemId, quantity: l.take })),
    short: split.filter((l) => l.take < l.wanted).map((l) => ({ itemId: l.itemId, quantity: l.wanted - l.take })),
  }
}

/** A minibar menu item and the stock item it sells. */
export interface MinibarLink {
  menuItemId: string
  stockItemId: string
}

/** What the guest took from the in-room minibar, entered on a stay. */
export interface MinibarCheckInput {
  bookingId: string
  lines: ReadonlyArray<{ menuItemId: string; quantity: number }>
  /** Issue the same quantities from the villa store to bring the minibar back to par. */
  restock: boolean
  note: string
}

export function validateMinibarCheck(input: MinibarCheckInput): Partial<Record<keyof MinibarCheckInput, string>> {
  const taken = input.lines.filter((l) => l.quantity > 0)
  if (taken.length === 0) return { lines: 'Enter what the guest took.' }
  if (taken.some((l) => !wholeAtLeast(l.quantity, 1) || l.quantity > 50)) return { lines: 'Whole quantities from 1 to 50.' }
  return {}
}

/** Newest first; inside a day, the latest number on top. */
export const sortMovements = <T extends StockMovement>(list: readonly T[]): T[] => [...list].sort((a, b) => b.on.localeCompare(a.on) || b.number.localeCompare(a.number, undefined, { numeric: true }))
