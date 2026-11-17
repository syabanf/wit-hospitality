import type { StayPort } from '@/application/ports'
import type { User } from '@/domain/access'
import type { Booking } from '@/domain/booking'
import { findById, NotFoundError } from '@/domain/errors'
import type { GuestFolio } from '@/domain/folio'
import { cleanWindow, preferencesOf, validateServiceWindow, WINDOW_MODE_LABEL, windowLabel, windowOf, type GuestPreferences } from '@/domain/hospitality'
import { HOUSE_RULES } from '@/domain/precheckin'
import { unitKindOf } from '@/domain/property'
import type { ServiceRequest, ServiceRequestInput } from '@/domain/roomService'
import { orderSummary, orderTotals, type OrderInput, type ServiceOrder } from '@/domain/serviceOrder'
import {
  assertLinkable,
  cleanAlreadyAsked,
  cleanAskedAt,
  firstName,
  GUEST_ACTION_LIMIT,
  GUEST_READ_LIMIT,
  GUEST_REQUEST_LABEL,
  guestFolioView,
  guestMenuItem,
  guestNoteProblem,
  guestRequest,
  guestWindowProblem,
  isStayToken,
  rateLimited,
  rateLimiter,
  stayLinkExpired,
  stayLinkState,
  stayReadOnly,
  validateGuestRequest,
  withGuestAction,
  type GuestActionKind,
  type GuestStayView,
} from '@/domain/stay'
import { daysBetween } from '@/lib/dates'
import type { MockState } from './state'

/** The mock API's helpers the stay page reuses, so a guest's action runs the desk's own rules. */
export interface StayDeps {
  s: MockState
  later: <T>(value: () => T) => Promise<T>
  atomically: <T>(change: () => T) => T
  copy: <T>(v: T) => T
  today: () => string
  clockNow: () => string
  user: () => User
  refuse: (errors: Record<string, string | undefined>) => void
  log: (action: 'update', entity: string, entityId: string, summary: string, before?: Record<string, unknown> | null, after?: Record<string, unknown> | null, actor?: User) => void
  guestActor: User
  issueStayLink: (b: Booking) => void
  askClean: (b: Booking, actor: User) => ServiceRequest
  savePreferences: (b: Booking, preferences: GuestPreferences, actor: User) => void
  lateCheckoutQuote: (b: Booking, until: string) => number
  giveLateCheckout: (b: Booking, until: string, actor: User) => number
  placeOrder: (input: OrderInput, actor: User, placedBy: 'guest') => ServiceOrder
  newRequest: (input: ServiceRequestInput, assignee?: string) => ServiceRequest
  folioOf: (b: Booking) => GuestFolio
}

/** The guest's stay page for the mock API: the link, what it shows and the six things a guest can do from it. */
export function createStayAdapter(d: StayDeps): StayPort {
  const { s, later, atomically, copy, today, clockNow } = d
  const limiter = rateLimiter()

  /** The stay behind a token while its link lives; reads and writes each spend the token's allowance. */
  function stayBy(token: string, write: boolean) {
    const b = isStayToken(token) ? s.bookings.find((x) => x.stayToken === token) : undefined
    if (!b) throw new NotFoundError('stay page', token)
    if (!limiter.take(`${write ? 'w' : 'r'}:${token}`, write ? GUEST_ACTION_LIMIT : GUEST_READ_LIMIT, Date.now())) throw rateLimited()
    const state = stayLinkState(b, today())
    if (state === 'expired') throw stayLinkExpired(b.code)
    if (write && state !== 'open') throw stayReadOnly()
    return b
  }

  const hostOf = (b: Booking) => (b.hostId ? (s.employees.find((e) => e.id === b.hostId)?.name ?? '') : '')

  function view(token: string, b: Booking): GuestStayView {
    const catalog = s.catalog()
    const place = catalog.place(b.unitId)
    const kind = unitKindOf(catalog, b.unitId)
    const host = firstName(hostOf(b))
    return {
      token,
      state: b.status === 'checked_in' ? 'open' : 'read_only',
      bookingCode: b.code,
      guestName: firstName(findById(s.guests, b.guestId, 'guest').name),
      villaName: place.villa.name,
      locationName: place.location.name,
      unitName: `${place.unit.code} ${place.unit.name}`,
      unitKind: kind,
      checkIn: b.checkIn,
      checkOut: b.checkOut,
      nights: daysBetween(b.checkIn, b.checkOut),
      checkInTime: place.villa.checkInTime,
      checkOutTime: place.villa.checkOutTime,
      hostName: kind === 'villa' && host ? host : null,
      houseRules: place.villa.houseRules.trim() ? place.villa.houseRules.split('\n').map((r) => r.trim()).filter(Boolean) : [...HOUSE_RULES],
      today: today(),
      serviceWindow: copy(windowOf(b, kind)),
      preferences: copy(preferencesOf(b)),
      cleanAskedAt: cleanAskedAt(b.guestActions, today()),
      lateCheckout: b.lateCheckout ? { until: b.lateCheckout.until, charge: b.lateCheckout.charge } : null,
      menu: s.menu.filter((i) => i.villaId === place.villa.id && i.active).map((i) => copy(guestMenuItem(i))),
      orders: s.orders
        .filter((o) => o.bookingId === b.id)
        .reverse()
        .map((o) => ({ number: o.number, status: o.status, lines: o.lines.map((l) => ({ name: l.name, quantity: l.quantity, price: l.price, comp: l.comp })), requestedOn: o.requestedOn, requestedAt: o.requestedAt, charge: orderTotals(o).charge })),
      requests: s.requests.filter((r) => r.bookingId === b.id).reverse().map(guestRequest),
      folio: guestFolioView(d.folioOf(b)),
    }
  }

  /** One guest action, all or nothing: the change, its line on the stay and on the audit trail in the guest's name. */
  function act(token: string, kind: GuestActionKind, change: (b: Booking) => string) {
    return later(() =>
      atomically(() => {
        const b = stayBy(token, true)
        const summary = change(b)
        b.guestActions = withGuestAction(b.guestActions, { kind, at: clockNow(), summary })
        d.log('update', 'booking', b.code, `Guest of ${b.code}: ${summary}`, null, { kind }, d.guestActor)
        return view(token, b)
      }),
    )
  }

  return {
    issueLink: (bookingId) =>
      later(() => {
        const me = d.user()
        const b = findById(s.bookings, bookingId, 'booking')
        assertLinkable(b)
        if (!b.stayToken) {
          d.issueStayLink(b)
          d.log('update', 'booking', b.code, `Made the stay page link of ${b.code}`, null, null, me)
        }
        return copy(b)
      }),
    guestView: (token) => later(() => view(token, stayBy(token, false))),
    askClean: (token, note) =>
      act(token, 'clean', (b) => {
        d.refuse({ note: guestNoteProblem(note) })
        if (cleanAskedAt(b.guestActions, today())) throw cleanAlreadyAsked()
        const request = d.askClean(b, d.guestActor)
        if (note.trim() && !request.note.includes(note.trim())) request.note = `${request.note} · ${note.trim()}`
        return 'Asked for cleaning today'
      }),
    setServiceWindow: (token, window) =>
      act(token, 'service_window', (b) => {
        d.refuse(validateServiceWindow(window))
        d.refuse({ mode: guestWindowProblem(unitKindOf(s.catalog(), b.unitId), window) })
        b.serviceWindow = cleanWindow(window)
        return window.mode === 'dnd' ? 'Asked not to be disturbed' : `Set the service window to ${window.mode === 'window' ? windowLabel(b.serviceWindow) : WINDOW_MODE_LABEL.scheduled.toLowerCase()}`
      }),
    placeOrder: (token, input) =>
      act(token, 'order', (b) => {
        const order = d.placeOrder({ bookingId: b.id, lines: input.lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity })), note: input.note, requestedOn: input.requestedOn, requestedAt: input.requestedAt, priority: 'normal', discountPct: 0, discountReason: '', compReason: '' }, d.guestActor, 'guest')
        return `Ordered ${orderSummary(order)} (${order.number})`
      }),
    request: (token, input) =>
      act(token, 'request', (b) => {
        d.refuse(validateGuestRequest(input))
        const request = d.newRequest({ unitId: b.unitId, bookingId: b.id, kind: input.kind, priority: 'normal', note: input.note.trim(), charge: 0 }, hostOf(b))
        return `Asked for ${GUEST_REQUEST_LABEL[request.kind].toLowerCase()} (${request.number})`
      }),
    quoteLateCheckout: (token, until) =>
      later(() => {
        const b = stayBy(token, true)
        return { until, charge: d.lateCheckoutQuote(b, until) }
      }),
    lateCheckout: (token, until) =>
      act(token, 'late_checkout', (b) => {
        const charge = d.giveLateCheckout(b, until, d.guestActor)
        return `Asked for a late check-out until ${until}, ${charge > 0 ? `charged ${charge}` : 'free'}`
      }),
    setPreferences: (token, preferences) =>
      act(token, 'preferences', (b) => {
        // As the API: a room stay takes only the arrival time and notes, refused rather than dropped.
        if (unitKindOf(s.catalog(), b.unitId) === 'room') d.refuse({ setups: preferences.breakfastTime || preferences.dietary.trim() || preferences.setups.length ? 'A room stay takes only the arrival time and notes.' : undefined })
        d.savePreferences(b, { ...preferences, arrivalTime: preferencesOf(b).arrivalTime }, d.guestActor)
        return 'Updated the preferences'
      }),
  }
}
