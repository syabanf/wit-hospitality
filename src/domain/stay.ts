import { addDays, type IsoDate } from '@/lib/dates'
import type { Booking } from './booking'
import { RuleError } from './errors'
import type { FolioKind, FolioLine, GuestFolio } from './folio'
import type { WakeUpCall } from './frontDesk'
import type { GuestPreferences, LateCheckout, ServiceWindow } from './hospitality'
import type { UnitKind } from './property'
import type { ServiceKind, ServiceRequest } from './roomService'
import type { MenuItem, OrderLine, ServiceOrder } from './serviceOrder'
import { PB1_CODE, SERVICE_CODE } from './tax'

/**
 * The guest's page during the stay, /stay/:token: one link per stay, open from check-in, read only
 * after check-out and gone a day later. The token is the only credential, so every answer carries
 * this stay's data alone and nothing the team keeps for itself.
 */

// The link

const TOKEN = /^st[0-9a-f]{32}$/
/** A stay token from 16 random bytes: 128 bits, so it cannot be guessed or walked. */
export const stayTokenFrom = (bytes: Uint8Array) => `st${Array.from(bytes.slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('')}`
export const isStayToken = (token: string) => TOKEN.test(token)

/** Days after check-out the page still opens, read only. */
export const STAY_LINK_GRACE_DAYS = 1
export const stayLinkExpiresOn = (b: Pick<Booking, 'checkOut'>): IsoDate => addDays(b.checkOut, STAY_LINK_GRACE_DAYS)

export type StayLinkState = 'open' | 'read_only' | 'expired'
/** Open while the guest is in house, read only once checked out, expired a day after the check-out date or when the stay never happened. */
export function stayLinkState(b: Pick<Booking, 'status' | 'checkOut'>, today: IsoDate): StayLinkState {
  if (today > stayLinkExpiresOn(b)) return 'expired'
  if (b.status === 'checked_in') return 'open'
  return b.status === 'checked_out' ? 'read_only' : 'expired'
}

export const stayLinkExpired = (code: string) => new RuleError('STAY_LINK_EXPIRED', `This stay page closed after ${code} ended.`)
export const stayReadOnly = () => new RuleError('STAY_READ_ONLY', 'Your stay has ended, so this page is read only now.')
/** A stay link is given to a guest in house. */
export function assertLinkable(b: Pick<Booking, 'status' | 'code'>) {
  if (b.status !== 'checked_in') throw new RuleError('BOOKING_INVALID_STATE', `${b.code} is not in house; the stay page opens at check-in.`)
}

// Rate limit

/** Guest writes one stay link may send per window. */
export const GUEST_ACTION_LIMIT = 10
/** Reads one stay link may send per window. */
export const GUEST_READ_LIMIT = 60
export const GUEST_RATE_WINDOW_SECONDS = 60
export const rateLimited = () => new RuleError('RATE_LIMITED', 'Too many requests from this page. Wait a minute and try again.')

/** A fixed-window counter per key: `take` answers false once the key spent its limit for the window. */
export function rateLimiter(windowMs = GUEST_RATE_WINDOW_SECONDS * 1000) {
  const windows = new Map<string, { count: number; resetAt: number }>()
  return {
    take(key: string, limit: number, now: number) {
      const w = windows.get(key)
      if (!w || now >= w.resetAt) {
        windows.set(key, { count: 1, resetAt: now + windowMs })
        return true
      }
      w.count += 1
      return w.count <= limit
    },
  }
}

// What the guest did

export type GuestActionKind = 'clean' | 'service_window' | 'order' | 'request' | 'late_checkout' | 'preferences' | 'wake_up' | 'card' | 'complaint'
export const GUEST_ACTION_LABEL: Record<GuestActionKind, string> = {
  clean: 'Cleaning',
  service_window: 'Service window',
  order: 'Order',
  request: 'Request',
  late_checkout: 'Late check-out',
  preferences: 'Preferences',
  wake_up: 'Wake-up call',
  card: 'Registration card',
  complaint: 'Something went wrong',
}

/** One thing the guest did on the stay page, kept on the stay for the team to read. */
export interface GuestAction {
  kind: GuestActionKind
  /** ISO date-time. */
  at: string
  summary: string
}

/** The stay keeps the latest actions; older ones stay on the audit trail. */
export const GUEST_ACTIONS_KEPT = 50
export const withGuestAction = (actions: readonly GuestAction[] | undefined, action: GuestAction): GuestAction[] => [...(actions ?? []), action].slice(-GUEST_ACTIONS_KEPT)

/** When the guest asked for a clean on `date`, or null. */
export const cleanAskedAt = (actions: readonly GuestAction[] | undefined, date: IsoDate) => (actions ?? []).findLast((a) => a.kind === 'clean' && a.at.slice(0, 10) === date)?.at ?? null
export const cleanAlreadyAsked = () => new RuleError('CLEAN_ALREADY_ASKED', 'Cleaning is already asked for today.')

// The six actions

const MAX_GUEST_NOTE = 500
export const guestNoteProblem = (note: string) => (note.trim().length > MAX_GUEST_NOTE ? `Keep the note to ${MAX_GUEST_NOTE} characters.` : undefined)

/** A villa guest picks a window or Do not disturb; a room follows the housekeeping schedule or Do not disturb. */
export function guestWindowProblem(kind: UnitKind, w: Pick<ServiceWindow, 'mode'>): string | undefined {
  if (kind === 'villa' && w.mode === 'scheduled') return 'Pick a time window or Do not disturb.'
  if (kind === 'room' && w.mode === 'window') return 'Pick the housekeeping schedule or Do not disturb.'
  return undefined
}

/** What a guest may ask for from the page; cleaning has its own button. */
export const GUEST_REQUEST_KINDS: readonly ServiceKind[] = ['towels', 'laundry', 'minibar', 'maintenance', 'transfer', 'other']
export const GUEST_REQUEST_LABEL: Record<ServiceKind, string> = {
  cleaning: 'Cleaning',
  towels: 'Extra towels and amenities',
  laundry: 'Laundry pickup',
  minibar: 'Minibar refill',
  maintenance: 'Something needs fixing',
  transfer: 'Airport transfer',
  other: 'Something else',
}

export interface GuestRequestInput {
  kind: ServiceKind
  note: string
}

export function validateGuestRequest(input: GuestRequestInput): Partial<Record<keyof GuestRequestInput, string>> {
  const errors: Partial<Record<keyof GuestRequestInput, string>> = {}
  if (!GUEST_REQUEST_KINDS.includes(input.kind)) errors.kind = 'Pick what you need.'
  const note = guestNoteProblem(input.note)
  if (note) errors.note = note
  else if (input.kind === 'other' && input.note.trim().length < 3) errors.note = 'Tell us what you need.'
  return errors
}

/** Hours a guest can pick for a late check-out: each full hour after the house time, up to 18:00. */
export function lateCheckoutTimes(checkOutTime: string): string[] {
  const first = Number(checkOutTime.slice(0, 2)) + 1
  return Array.from({ length: Math.max(0, 19 - first) }, (_, i) => `${String(first + i).padStart(2, '0')}:00`)
}

// What the page shows

/** A menu item without what it costs the house or who delivers it. */
export type GuestMenuItem = Omit<MenuItem, 'costPrice' | 'partnerId'>
export const guestMenuItem = ({ costPrice: _costPrice, partnerId: _partnerId, ...item }: MenuItem): GuestMenuItem => item

export interface GuestOrder {
  number: string
  status: ServiceOrder['status']
  lines: Array<Pick<OrderLine, 'name' | 'quantity' | 'price' | 'comp'>>
  requestedOn: IsoDate
  requestedAt: number
  charge: number
}

export type GuestRequest = Pick<ServiceRequest, 'number' | 'kind' | 'status' | 'requestedOn' | 'requestedAt'>
export const guestRequest = (r: ServiceRequest): GuestRequest => ({ number: r.number, kind: r.kind, status: r.status, requestedOn: r.requestedOn, requestedAt: r.requestedAt })

export interface GuestFolioLine {
  date: IsoDate
  label: string
  /** Rupiah: a charge above zero, a payment or credit below. */
  amount: number
}

/** The folio as the guest may read it: posted lines in order, taxes as billed, the balance so far. */
export interface GuestFolioView {
  lines: GuestFolioLine[]
  subtotal: number
  service: number
  pb1: number
  /** Posted charges less payments: above zero the guest owes. */
  balance: number
  /** Room nights still to post, which check-out settles. */
  toCome: number
  depositHeld: number
}

const GUEST_LINE_LABEL: Record<Exclude<FolioKind, 'room' | 'room_service' | 'charge' | 'tax' | 'deposit'>, string> = {
  discount: 'Discount',
  channel: 'Paid through Airbnb',
  comp: 'On the house',
  departure: 'Charged at check-out',
  rebate: 'Rebate',
  payment: 'Payment',
  refund: 'Refund',
  transfer: 'Billed to the company account',
}

/**
 * A folio line in the guest's words. Room nights lose the rate notes, a payment its reference and
 * note, a rebate its reason: those are the team's. Charges and room service keep what was sold.
 */
export function guestLineLabel(l: Pick<FolioLine, 'kind' | 'description' | 'code' | 'memo'>): string {
  switch (l.kind) {
    case 'room':
      return l.description.split(',')[0] ?? l.description
    case 'room_service':
      return l.description.includes(': ') ? l.description.slice(l.description.indexOf(': ') + 2) : l.description
    case 'charge':
      return l.description
    case 'tax':
      return l.code === SERVICE_CODE ? 'Service charge' : l.code === PB1_CODE ? 'PB1, regional hotel tax' : 'Tax'
    case 'deposit':
      return l.memo < 0 ? 'Security deposit returned' : 'Security deposit held'
    default:
      return GUEST_LINE_LABEL[l.kind]
  }
}

const SETTLES: ReadonlySet<FolioKind> = new Set(['payment', 'refund', 'channel', 'transfer'])

export function guestFolioView(f: Pick<GuestFolio, 'lines' | 'balance' | 'forecast' | 'depositHeld'>): GuestFolioView {
  const posted = f.lines.filter((l) => !l.forecast && l.kind !== 'deposit')
  const charged = (pick: (code: string) => boolean) => posted.filter((l) => !SETTLES.has(l.kind) && pick(l.code)).reduce((s, l) => s + l.debit - l.credit, 0)
  return {
    lines: posted.map((l) => ({ date: l.date, label: guestLineLabel(l), amount: l.debit - l.credit })),
    subtotal: charged((c) => c !== SERVICE_CODE && c !== PB1_CODE),
    service: charged((c) => c === SERVICE_CODE),
    pb1: charged((c) => c === PB1_CODE),
    balance: f.balance,
    toCome: Math.max(0, f.forecast),
    depositHeld: f.depositHeld,
  }
}

/** What GET /stay/:token answers. */
export interface GuestStayView {
  token: string
  state: Exclude<StayLinkState, 'expired'>
  bookingCode: string
  /** The lead guest's first name. */
  guestName: string
  villaName: string
  locationName: string
  unitName: string
  unitKind: UnitKind
  checkIn: IsoDate
  checkOut: IsoDate
  nights: number
  checkInTime: string
  checkOutTime: string
  /** The villa host's first name; null on a room stay or a stay without a host. */
  hostName: string | null
  houseRules: string[]
  today: IsoDate
  serviceWindow: ServiceWindow
  preferences: GuestPreferences
  /** When the guest asked for today's clean (ISO date-time), or null. */
  cleanAskedAt: string | null
  lateCheckout: Pick<LateCheckout, 'until' | 'charge'> | null
  /** The service menu; null when ordering is not available. */
  menu: GuestMenuItem[] | null
  orders: GuestOrder[]
  requests: GuestRequest[]
  /** Null when the bill is not available. */
  folio: GuestFolioView | null
  /** Whether the stay has a signed registration card; absent from an API that predates it. */
  cardSigned?: boolean
  wakeUpCalls?: GuestWakeUp[]
}

/** A wake-up call as the guest sees it. */
export type GuestWakeUp = Pick<WakeUpCall, 'id' | 'date' | 'time' | 'note' | 'repeatDaily' | 'status'>
export const guestWakeUp = (c: WakeUpCall): GuestWakeUp => ({ id: c.id, date: c.date, time: c.time, note: c.note, repeatDaily: c.repeatDaily, status: c.status })

export interface LateCheckoutQuote {
  until: string
  charge: number
}

export const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? ''
