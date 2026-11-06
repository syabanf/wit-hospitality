import { addDays, daysBetween, withinRange, type IsoDate } from '@/lib/dates'
import type { Attachment } from './attachment'
import type { Booking } from './booking'
import type { Payment } from './payment'
import { clockLabel } from './roomService'
import { MENU_CATEGORY_CODE } from './transactionCode'

/** What the villa sells to a staying guest, grouped the way the menu card prints it. */
export type MenuCategory = 'breakfast' | 'food' | 'minibar' | 'laundry' | 'transport' | 'spa' | 'tours' | 'extras' | 'housekeeping'
export const MENU_CATEGORIES: readonly MenuCategory[] = ['breakfast', 'food', 'minibar', 'laundry', 'transport', 'spa', 'tours', 'extras', 'housekeeping']
export const MENU_CATEGORY_LABEL: Record<MenuCategory, string> = {
  breakfast: 'Breakfast',
  food: 'Food and drinks',
  minibar: 'Minibar',
  laundry: 'Laundry',
  transport: 'Airport transfer and transport',
  spa: 'Spa and massage',
  tours: 'Tours and activities',
  extras: 'Extra bed and amenities',
  housekeeping: 'Housekeeping extras',
}

/** The income category each kind of service posts to once the guest pays. */
export const REVENUE_CATEGORY: Record<MenuCategory, string> = {
  breakfast: 'cat-svc-fnb',
  food: 'cat-svc-fnb',
  minibar: 'cat-svc-fnb',
  laundry: 'cat-svc-laundry',
  transport: 'cat-svc-transport',
  spa: 'cat-svc-spa',
  tours: 'cat-svc-tours',
  extras: 'cat-svc-other',
  housekeeping: 'cat-svc-other',
}
export const SERVICE_REVENUE_CATEGORIES: readonly string[] = [...new Set(Object.values(REVENUE_CATEGORY))]
/** Where a partner's share of a delivered order is booked. */
export const PARTNER_COST_CATEGORY = 'cat-svc-partner'

export type PriceUnit = 'item' | 'kg' | 'trip' | 'person' | 'hour'
export const PRICE_UNITS: readonly PriceUnit[] = ['item', 'kg', 'trip', 'person', 'hour']
export const PRICE_UNIT_LABEL: Record<PriceUnit, string> = { item: 'per item', kg: 'per kg', trip: 'per trip', person: 'per person', hour: 'per hour' }

export type PartnerKind = 'spa' | 'tours' | 'transport' | 'laundry' | 'food'
export const PARTNER_KINDS: readonly PartnerKind[] = ['spa', 'tours', 'transport', 'laundry', 'food']
export const PARTNER_KIND_LABEL: Record<PartnerKind, string> = { spa: 'Spa therapists', tours: 'Tour operator', transport: 'Drivers', laundry: 'Laundry', food: 'Catering' }

/** An outside business that delivers part of the menu and bills the villa for it. */
export interface ServicePartner {
  id: string
  name: string
  kind: PartnerKind
  contact: string
  phone: string
  active: boolean
}
export type PartnerInput = Omit<ServicePartner, 'id'>

export function validatePartner(input: PartnerInput): Partial<Record<keyof PartnerInput, string>> {
  const errors: Partial<Record<keyof PartnerInput, string>> = {}
  if (input.name.trim().length < 2) errors.name = 'Enter the partner’s name.'
  if (!PARTNER_KINDS.includes(input.kind)) errors.kind = 'Pick what they provide.'
  if (input.phone && !/^\+?[\d\s-]{7,}$/.test(input.phone)) errors.phone = 'Enter a phone number with the country code.'
  return errors
}

export interface MenuItem {
  id: string
  villaId: string
  category: MenuCategory
  name: string
  description: string
  photo: Attachment | null
  /** Rupiah per unit. */
  price: number
  unit: PriceUnit
  /** Minutes since midnight; a window that ends before it starts runs past midnight. */
  availableFrom: number
  availableTo: number
  /** Notice the kitchen or partner needs, in minutes. */
  leadMinutes: number
  active: boolean
  /** Set when an outside partner delivers it; `costPrice` is what the partner bills per unit. */
  partnerId: string | null
  costPrice: number
}
export type MenuItemInput = Omit<MenuItem, 'id'>

export function validateMenuItem(input: MenuItemInput): Partial<Record<keyof MenuItemInput, string>> {
  const errors: Partial<Record<keyof MenuItemInput, string>> = {}
  const minutes = (m: number) => Number.isInteger(m) && m >= 0 && m <= 24 * 60
  if (!input.villaId) errors.villaId = 'Pick the villa.'
  if (!MENU_CATEGORIES.includes(input.category)) errors.category = 'Pick the category.'
  if (input.name.trim().length < 2) errors.name = 'Enter the item name.'
  if (!Number.isInteger(input.price) || input.price < 0) errors.price = 'Enter the price in whole rupiah, or zero.'
  if (!PRICE_UNITS.includes(input.unit)) errors.unit = 'Pick how it is priced.'
  if (!minutes(input.availableFrom)) errors.availableFrom = 'A time of day.'
  if (!minutes(input.availableTo)) errors.availableTo = 'A time of day.'
  if (!Number.isInteger(input.leadMinutes) || input.leadMinutes < 0 || input.leadMinutes > 7 * 24 * 60) errors.leadMinutes = 'Notice in minutes, up to a week.'
  if (!Number.isInteger(input.costPrice) || input.costPrice < 0) errors.costPrice = 'Enter the cost in whole rupiah, or zero.'
  else if (input.costPrice > 0 && !input.partnerId) errors.partnerId = 'Pick the partner who bills that cost.'
  return errors
}

/** Whether an item is served at that minute of the day. */
export function availableAt(item: Pick<MenuItem, 'availableFrom' | 'availableTo'>, minute: number) {
  const { availableFrom: from, availableTo: to } = item
  return from <= to ? minute >= from && minute <= to : minute >= from || minute <= to
}

export const hoursLabel = (item: Pick<MenuItem, 'availableFrom' | 'availableTo'>) =>
  item.availableFrom === 0 && item.availableTo >= 24 * 60 - 1 ? 'Any time' : `${clockLabel(item.availableFrom)} to ${clockLabel(item.availableTo % (24 * 60))}`

export const leadLabel = (minutes: number) => (minutes === 0 ? 'No notice' : minutes < 60 ? `${minutes} min notice` : minutes % 60 === 0 ? `${minutes / 60} h notice` : `${Math.floor(minutes / 60)} h ${minutes % 60} min notice`)

export type OrderStatus = 'new' | 'confirmed' | 'preparing' | 'delivered' | 'cancelled' | 'voided'
export const ORDER_STATUSES: readonly OrderStatus[] = ['new', 'confirmed', 'preparing', 'delivered', 'cancelled', 'voided']
export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = { new: 'New', confirmed: 'Accepted', preparing: 'Preparing', delivered: 'Delivered', cancelled: 'Cancelled', voided: 'Voided' }

export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  new: ['confirmed', 'cancelled'],
  confirmed: ['preparing', 'delivered', 'cancelled'],
  preparing: ['delivered', 'cancelled'],
  delivered: ['voided'],
  cancelled: [],
  voided: [],
}
export type OrderAction = Exclude<OrderStatus, 'new'>
export const canTransitionOrder = (o: Pick<ServiceOrder, 'status'>, to: OrderStatus) => ORDER_TRANSITIONS[o.status].includes(to)
/** The one forward step a card offers. */
export const nextOrderStep = (o: Pick<ServiceOrder, 'status'>): OrderAction | null =>
  o.status === 'new' ? 'confirmed' : o.status === 'confirmed' ? 'preparing' : o.status === 'preparing' ? 'delivered' : null
export const ORDER_ACTION_LABEL: Record<OrderAction, string> = { confirmed: 'Accept', preparing: 'Start preparing', delivered: 'Mark delivered', cancelled: 'Cancel order', voided: 'Void delivery' }
export const isOpenOrder = (o: Pick<ServiceOrder, 'status'>) => o.status === 'new' || o.status === 'confirmed' || o.status === 'preparing'

/** A menu item as it was ordered: name and prices are copied so later menu edits leave the bill alone. */
export interface OrderLine {
  itemId: string
  name: string
  category: MenuCategory
  unit: PriceUnit
  price: number
  quantity: number
  costPrice: number
  partnerId: string | null
  /** On the house: the guest pays nothing for it, the partner is still paid. */
  comp: boolean
}

export interface OrderEvent {
  kind: 'placed' | 'confirmed' | 'preparing' | 'delivered' | 'cancelled' | 'voided' | 'assigned' | 'paid'
  by: string
  /** ISO date-time. */
  at: string
  note: string
}

export interface ServiceOrder {
  id: string
  number: string
  bookingId: string
  unitId: string
  villaId: string
  lines: readonly OrderLine[]
  note: string
  requestedOn: IsoDate
  /** Minutes since midnight. */
  requestedAt: number
  priority: 'normal' | 'urgent'
  status: OrderStatus
  assignee: string
  placedBy: 'guest' | 'staff'
  createdOn: IsoDate
  deliveredOn: IsoDate | null
  deliveredAt: number | null
  /** Percent off the chargeable lines, with the reason. */
  discountPct: number
  discountReason: string
  compReason: string
  /** The latest payment asked for this order; the order is settled when that payment is paid. */
  paymentId: string | null
  /** Cash-outs to partners, booked when the order is delivered. */
  costTransactionIds: readonly string[]
  history: readonly OrderEvent[]
}

export const lineAmount = (l: Pick<OrderLine, 'price' | 'quantity'>) => Math.round(l.price * l.quantity)
export const lineCost = (l: Pick<OrderLine, 'costPrice' | 'quantity'>) => Math.round(l.costPrice * l.quantity)

export interface OrderTotals {
  gross: number
  comp: number
  discount: number
  /** What the guest pays. */
  charge: number
  /** What partners bill the villa. */
  cost: number
  margin: number
}

export function orderTotals(o: Pick<ServiceOrder, 'lines' | 'discountPct'>): OrderTotals {
  const gross = o.lines.reduce((s, l) => s + lineAmount(l), 0)
  const comp = o.lines.filter((l) => l.comp).reduce((s, l) => s + lineAmount(l), 0)
  const discount = Math.round(((gross - comp) * o.discountPct) / 100)
  const charge = gross - comp - discount
  const cost = o.lines.reduce((s, l) => s + lineCost(l), 0)
  return { gross, comp, discount, charge, cost, margin: charge - cost }
}

/** The charge split by a key of the line; the discount spreads pro rata and rounding lands on the biggest share. */
function chargeSplit(o: Pick<ServiceOrder, 'lines' | 'discountPct'>, keyOf: (l: OrderLine) => string): Array<{ key: string; amount: number }> {
  const { charge } = orderTotals(o)
  const gross = new Map<string, number>()
  for (const l of o.lines.filter((x) => !x.comp)) gross.set(keyOf(l), (gross.get(keyOf(l)) ?? 0) + lineAmount(l))
  const before = [...gross.values()].reduce((s, v) => s + v, 0)
  if (before === 0 || charge === 0) return []
  const shares = [...gross].map(([key, amount]) => ({ key, amount: Math.floor((amount * charge) / before) })).sort((a, b) => b.amount - a.amount)
  const first = shares[0]
  if (first) first.amount += charge - shares.reduce((s, x) => s + x.amount, 0)
  return shares.filter((x) => x.amount > 0)
}

/** The charge split per income category, for the cash-ins an order payment lands as. */
export const revenueSplit = (o: Pick<ServiceOrder, 'lines' | 'discountPct'>) => chargeSplit(o, (l) => REVENUE_CATEGORY[l.category]).map(({ key, amount }) => ({ categoryId: key, amount }))

/** The charge split per transaction code, for the folio and the revenue lines delivery books. */
export const codeSplit = (o: Pick<ServiceOrder, 'lines' | 'discountPct'>) => chargeSplit(o, (l) => MENU_CATEGORY_CODE[l.category]).map(({ key, amount }) => ({ code: key, amount }))

/** Partner bills per partner, the cash-outs a delivery books. */
export function partnerCosts(o: Pick<ServiceOrder, 'lines'>): Array<{ partnerId: string; amount: number; lines: OrderLine[] }> {
  const by = new Map<string, OrderLine[]>()
  for (const l of o.lines) if (l.partnerId && l.costPrice > 0) by.set(l.partnerId, [...(by.get(l.partnerId) ?? []), l])
  return [...by].map(([partnerId, lines]) => ({ partnerId, lines, amount: lines.reduce((s, l) => s + lineCost(l), 0) }))
}

export type OrderPayState = 'not_due' | 'free' | 'unpaid' | 'pending' | 'paid'
export const PAY_STATE_LABEL: Record<OrderPayState, string> = { not_due: 'Not billed yet', free: 'No charge', unpaid: 'To pay', pending: 'Link sent', paid: 'Paid' }

/** Delivered orders are billed; the order is paid once its payment is. */
export function payState(o: Pick<ServiceOrder, 'status' | 'paymentId' | 'lines' | 'discountPct'>, payments: readonly Pick<Payment, 'id' | 'status'>[]): OrderPayState {
  if (o.status !== 'delivered') return 'not_due'
  if (orderTotals(o).charge === 0) return 'free'
  const p = o.paymentId ? payments.find((x) => x.id === o.paymentId) : undefined
  return p?.status === 'paid' ? 'paid' : p?.status === 'pending' ? 'pending' : 'unpaid'
}

export interface Folio {
  charged: number
  paid: number
  pending: number
  outstanding: number
  /** Delivered orders the guest still owes, link or not. */
  unpaid: ServiceOrder[]
}

/** Room service on one stay: what delivered orders charge and what is settled. */
export function folio(orders: readonly ServiceOrder[], payments: readonly Pick<Payment, 'id' | 'status'>[]): Folio {
  const billed = orders.filter((o) => o.status === 'delivered')
  const amount = (list: readonly ServiceOrder[]) => list.reduce((s, o) => s + orderTotals(o).charge, 0)
  const paid = billed.filter((o) => payState(o, payments) === 'paid')
  const pending = billed.filter((o) => payState(o, payments) === 'pending')
  const unpaid = billed.filter((o) => ['unpaid', 'pending'].includes(payState(o, payments)))
  return { charged: amount(billed), paid: amount(paid), pending: amount(pending), outstanding: amount(unpaid), unpaid }
}

/** Minutes a guest may wait past the requested time before an order counts as late. */
export const ORDER_SLA_MINUTES = 30

export function orderLate(o: Pick<ServiceOrder, 'status' | 'requestedOn' | 'requestedAt'>, today: IsoDate, nowMinutes: number) {
  if (!isOpenOrder(o)) return false
  return o.requestedOn < today || (o.requestedOn === today && nowMinutes > o.requestedAt + ORDER_SLA_MINUTES)
}

/** Minutes from the requested time to delivery; zero when it arrived early. */
export function deliveryDelay(o: Pick<ServiceOrder, 'requestedOn' | 'requestedAt' | 'deliveredOn' | 'deliveredAt'>): number | null {
  if (!o.deliveredOn || o.deliveredAt === null) return null
  return Math.max(0, daysBetween(o.requestedOn, o.deliveredOn) * 24 * 60 + o.deliveredAt - o.requestedAt)
}

/** How many days ahead an arriving guest may already order (an airport pickup, a dinner). */
export const ORDER_ARRIVAL_DAYS = 3

/** Stays a guest or the desk may order for: in house, or arriving within a few days. */
export function orderableStay(b: Pick<Booking, 'status' | 'checkIn'>, today: IsoDate) {
  return b.status === 'checked_in' || (b.status === 'confirmed' && b.checkIn >= today && b.checkIn <= addDays(today, ORDER_ARRIVAL_DAYS))
}

export interface OrderLineInput {
  itemId: string
  quantity: number
  comp?: boolean
}

export interface OrderInput {
  bookingId: string
  lines: readonly OrderLineInput[]
  note: string
  requestedOn: IsoDate
  requestedAt: number
  priority: 'normal' | 'urgent'
  discountPct: number
  discountReason: string
  compReason: string
}

/** What a guest sends from the menu page; the stay comes from the room's QR code. */
export type GuestOrderInput = Pick<OrderInput, 'lines' | 'note' | 'requestedOn' | 'requestedAt'>

export const MAX_QUANTITY = 50

export function validateOrder(input: Pick<OrderInput, 'lines' | 'requestedOn' | 'requestedAt'> & Partial<OrderInput>): Partial<Record<keyof OrderInput, string>> {
  const errors: Partial<Record<keyof OrderInput, string>> = {}
  if (input.lines.length === 0) errors.lines = 'Add at least one item.'
  else if (input.lines.some((l) => !(l.quantity >= 0.1) || l.quantity > MAX_QUANTITY || Math.abs(Math.round(l.quantity * 10) - l.quantity * 10) > 1e-9))
    errors.lines = `Quantities run from 0.1 to ${MAX_QUANTITY}, in steps of 0.1.`
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.requestedOn)) errors.requestedOn = 'Pick the day.'
  if (!Number.isInteger(input.requestedAt) || input.requestedAt < 0 || input.requestedAt >= 24 * 60) errors.requestedAt = 'Pick the time.'
  const pct = input.discountPct ?? 0
  if (!(pct >= 0 && pct <= 100)) errors.discountPct = 'A percentage from 0 to 100.'
  else if (pct > 0 && (input.discountReason ?? '').trim().length < 3) errors.discountReason = 'Say why the order is discounted.'
  if (input.lines.some((l) => l.comp) && (input.compReason ?? '').trim().length < 3) errors.compReason = 'Say why it is on the house.'
  return errors
}

/** Why an item cannot be ordered for that time, with the API's code, or null. */
export function itemProblem(item: MenuItem, requestedOn: IsoDate, requestedAt: number, today: IsoDate, nowMinutes: number): { code: string; message: string } | null {
  if (!item.active) return { code: 'ITEM_UNAVAILABLE', message: `${item.name} is off the menu.` }
  if (!availableAt(item, requestedAt)) return { code: 'ITEM_UNAVAILABLE', message: `${item.name} is served ${hoursLabel(item)}.` }
  if (requestedOn < today) return { code: 'VALIDATION_ERROR', message: 'Pick a time from now on.' }
  if (requestedOn === today && requestedAt < nowMinutes + item.leadMinutes) return { code: 'ITEM_LEAD_TIME', message: `${item.name} needs ${leadLabel(item.leadMinutes)}; pick ${clockLabel(Math.min(24 * 60 - 1, nowMinutes + item.leadMinutes))} or later.` }
  return null
}

function hash(text: string): number {
  let h = 2166136261
  for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
  return h >>> 0
}
/** The token printed on a room's QR card: readable, and hard to guess for another room. */
export const orderTokenFor = (unitCode: string) => `${unitCode.toLowerCase()}-${hash(`menu:${unitCode}`).toString(36).slice(0, 5)}`

/** What the guest's menu page shows; read without a session. */
export interface PublicMenu {
  token: string
  villaName: string
  locationName: string
  unitCode: string
  unitName: string
  stay: { bookingCode: string; guestName: string; checkIn: IsoDate; checkOut: IsoDate; status: Booking['status'] } | null
  items: MenuItem[]
  orders: Array<Pick<ServiceOrder, 'number' | 'status' | 'lines' | 'requestedOn' | 'requestedAt' | 'note'> & { charge: number; payState: OrderPayState }>
  outstanding: number
  /** An open gateway link for the room service bill, if the guest already asked for one. */
  payToken: string | null
  today: IsoDate
}

export interface OrderFilter {
  status?: OrderStatus | 'all' | 'open'
  category?: MenuCategory | ''
  query?: string
  from?: string
  to?: string
}

export function filterOrders<T extends ServiceOrder & { unitCode: string; guestName: string }>(list: readonly T[], f: OrderFilter): T[] {
  const q = (f.query ?? '').trim().toLowerCase()
  return list.filter((o) => {
    if (f.status === 'open' && !isOpenOrder(o)) return false
    if (f.status && f.status !== 'all' && f.status !== 'open' && o.status !== f.status) return false
    if (f.category && !o.lines.some((l) => l.category === f.category)) return false
    if (!withinRange(o.requestedOn, f.from, f.to)) return false
    if (q && ![o.number, o.unitCode, o.guestName, o.note, o.assignee, ...o.lines.map((l) => l.name)].some((v) => v.toLowerCase().includes(q))) return false
    return true
  })
}

/** Live orders first, urgent and earliest requested on top; finished ones newest first. */
export function sortOrders<T extends ServiceOrder>(list: readonly T[]): T[] {
  const rank: Record<OrderStatus, number> = { new: 0, confirmed: 1, preparing: 1, delivered: 2, cancelled: 3, voided: 3 }
  const when = (o: T) => `${o.requestedOn} ${String(o.requestedAt).padStart(4, '0')}`
  return [...list].sort((a, b) => rank[a.status] - rank[b.status] || (a.priority === 'urgent' ? 0 : 1) - (b.priority === 'urgent' ? 0 : 1) || (rank[a.status] >= 2 ? when(b).localeCompare(when(a)) : when(a).localeCompare(when(b))))
}

/** One line per order for lists: "2 × Balinese breakfast, 1 × Fresh coconut". */
export const orderSummary = (o: Pick<ServiceOrder, 'lines'>) => o.lines.map((l) => `${l.quantity} × ${l.name}`).join(', ')
