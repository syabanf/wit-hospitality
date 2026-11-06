import type { GroupPaymentInput, GroupPort, NewBooking } from '@/application/ports'
import { overbookLimit } from '@/domain/overbooking'
import type { RestrictionOverrideInput } from '@/domain/restriction'
import type { User } from '@/domain/access'
import type { Attachment } from '@/domain/attachment'
import type { Booking } from '@/domain/booking'
import { findById, RuleError } from '@/domain/errors'
import { allocate, clashMessage, groupClashes, liveStay, stayOrder, stayPriceChange, validateGroup, validateGroupStay, type BookingGroup, type GroupStayInput } from '@/domain/group'
import type { GuestInput } from '@/domain/guest'
import { isGateway, PAYMENT_KIND_LABEL, PAYMENT_METHOD_LABEL, validatePayment, type Payment, type PaymentKind, type PaymentLink, type PaymentMethod } from '@/domain/payment'
import type { CityLedgerBilling, CityLedgerBillingInput } from '@/domain/cityLedger'
import type { MockState } from './state'

/** The mock adapter's own helpers the group rules reuse, so a group runs through the same booking and payment paths. */
export interface GroupDeps {
  s: MockState
  later: <T>(value: () => T) => Promise<T>
  atomically: <T>(change: () => T) => T
  copy: <T>(v: T) => T
  seq: (key: string) => number
  user: () => User
  today: () => string
  clockNow: () => string
  log: (action: 'create' | 'update', entity: string, entityId: string, summary: string) => void
  refuse: (errors: Record<string, string | undefined>) => void
  createGuest: (input: GuestInput) => { id: string }
  createStay: (input: NewBooking, extra: Pick<Booking, 'bookingGroupId' | 'partySize'>) => Booking
  newPayment: (b: Booking, fields: Pick<Payment, 'kind' | 'method' | 'amount' | 'status' | 'reference' | 'payer' | 'note'> & Partial<Payment>, actor: User) => Payment
  bookBatch: (shares: readonly Payment[], actor: User, attachments?: readonly Attachment[]) => void
  openLink: (b: Booking, input: { kind: PaymentKind; amount: number; method: PaymentMethod; payer: string; bookingId?: string; group?: Pick<Payment, 'groupId' | 'batch'> }, actor: User, settle: { also: ReadonlyArray<{ kind: PaymentKind; amount: number; bookingId?: string; group?: Pick<Payment, 'groupId' | 'batch'> }> }) => PaymentLink
  linkPayments: (l: PaymentLink) => Payment[]
  owedOn: (b: Booking) => number
  syncBooking: (bookingId: string) => void
  /** The group's city ledger billing, checked against the account's credit with every stay counted. */
  billTo: (input: CityLedgerBillingInput | null | undefined, stays: readonly Booking[], source: string) => CityLedgerBilling | undefined
}

export function createGroupPort(d: GroupDeps): GroupPort {
  const { s } = d
  const staysOf = (groupId: string) => s.bookings.filter((b) => b.bookingGroupId === groupId)
  const villasOf = (stays: readonly Booking[]) => [...new Set(stays.map((b) => s.catalog().unit(b.unitId).villaId))]

  /** Every unit is tested before anything is written; one clash refuses them all. */
  function assertAllFree(stays: readonly GroupStayInput[]) {
    const clashes = groupClashes(s.catalog(), stays, s.bookings, s.blocks, (groupId) => overbookLimit(s.overbooking, groupId))
    if (clashes.length) throw new RuleError('GROUP_UNAVAILABLE', clashMessage(clashes))
  }

  /** Each stay is a direct booking in the lead's name, with the group discount where it has none of its own. */
  function addStays(group: BookingGroup, stays: readonly GroupStayInput[], confirm: boolean, override: RestrictionOverrideInput | null = null) {
    const created = stays.map((st) =>
      d.createStay(
        { guestId: group.leadGuestId, newGuest: null, unitId: st.unitId, groupId: st.unitId ? null : st.roomTypeId, source: 'direct', airbnbAccountId: null, airbnbCode: null, checkIn: st.checkIn, checkOut: st.checkOut, channelRate: null, price: stayPriceChange(st.price, group.discount), notes: '', confirm, override },
        { bookingGroupId: group.id, partySize: { adults: st.adults, children: st.children } },
      ),
    )
    group.villaIds = villasOf(staysOf(group.id))
    return created
  }

  /**
   * One payment split over the stays in order, each share up to what its stay still owes. A master
   * folio still carries the room of stays that already left, so their shares land on their own stays.
   */
  function pay(group: BookingGroup, input: GroupPaymentInput, me: User) {
    const stays = stayOrder(staysOf(group.id).filter((b) => liveStay(b) || (group.billing === 'master' && b.status === 'checked_out')))
    const dues = stays.map((b) => ({ bookingId: b.id, due: d.owedOn(b) }))
    const owed = dues.reduce((sum, x) => sum + Math.max(0, x.due), 0)
    d.refuse(validatePayment({ bookingId: stays[0]?.id ?? '', kind: input.kind, method: input.method, amount: input.amount, reference: input.reference, payer: '', note: input.note }, owed, 0))
    const batch = `GP-${2000 + d.seq('groupPayment')}`
    const payer = s.guests.find((g) => g.id === group.leadGuestId)?.name ?? ''
    const shares = allocate(input.amount, dues)
    const tag = { groupId: group.id, batch }
    d.log('create', 'booking-group', group.code, `${isGateway(input.method) ? 'Sent a link for' : 'Took'} group ${PAYMENT_KIND_LABEL[input.kind].toLowerCase()} ${batch} on ${group.code} by ${PAYMENT_METHOD_LABEL[input.method]}: ${input.amount}`)
    if (isGateway(input.method)) {
      const [first, ...also] = shares.map((x) => ({ kind: input.kind, amount: x.amount, bookingId: x.bookingId, group: tag }))
      if (!first) throw new RuleError('VALIDATION_ERROR', 'Nothing is owed on the group.')
      const link = d.openLink(findById(s.bookings, first.bookingId, 'booking'), { ...first, method: input.method, payer }, me, { also })
      return { payments: d.linkPayments(link), link }
    }
    const payments = shares.map((x) => {
      const p = d.newPayment(findById(s.bookings, x.bookingId, 'booking'), { kind: input.kind, method: input.method, amount: x.amount, status: 'paid', reference: input.reference.trim(), payer, note: input.note.trim() || `Group ${group.code}`, paidOn: d.today(), ...tag }, me)
      p.history = [...p.history, { kind: 'paid', by: me.name, at: d.clockNow(), note: PAYMENT_METHOD_LABEL[input.method] }]
      return p
    })
    d.bookBatch(payments, me, input.attachments ?? [])
    for (const p of payments) d.syncBooking(p.bookingId)
    return { payments, link: null }
  }

  return {
    groups: () => d.later(() => d.copy(s.bookingGroups)),
    create: (input) =>
      d.later(() =>
        d.atomically(() => {
          const me = d.user()
          d.refuse(validateGroup({ name: input.name, hasGuest: Boolean(input.guestId || input.newGuest), stays: input.stays, discount: input.discount }))
          assertAllFree(input.stays)
          const leadGuestId = input.guestId ?? (input.newGuest ? d.createGuest(input.newGuest).id : '')
          findById(s.guests, leadGuestId, 'guest')
          const n = d.seq('bookingGroup')
          const group: BookingGroup = { id: `bg-${n}`, code: `GRP-${1000 + n}`, name: input.name.trim(), leadGuestId, villaIds: [], source: input.source, billing: input.billing, discount: input.discount ? { pct: input.discount.pct, reason: input.discount.reason.trim() } : null, note: input.note.trim(), createdBy: me.name, createdAt: d.clockNow() }
          s.bookingGroups.push(group)
          const stays = addStays(group, input.stays, input.confirm, input.override ?? null)
          const billing = d.billTo(input.cityLedger, stays, 'direct')
          if (billing) group.cityLedger = billing
          d.log('create', 'booking-group', group.code, `${input.confirm ? 'Confirmed' : 'Drafted'} group ${group.code} ${group.name}: ${stays.map((b) => b.code).join(', ')}`)
          const deposit = input.deposit ? pay(group, input.deposit, me) : null
          return { group: d.copy(group), link: deposit?.link ? d.copy(deposit.link) : null }
        }),
      ),
    addStay: (groupId, stay) =>
      d.later(() =>
        d.atomically(() => {
          const group = findById(s.bookingGroups, groupId, 'group')
          d.refuse(validateGroupStay(stay))
          const live = staysOf(groupId).filter(liveStay)
          if (live.length === 0) throw new RuleError('BOOKING_INVALID_STATE', `${group.code} has no stay left to join; book a new group instead.`)
          assertAllFree([stay])
          const [created] = addStays(group, [stay], live.some((b) => b.status !== 'draft'))
          if (!created) throw new RuleError('VALIDATION_ERROR', 'Pick a unit or a room type.')
          d.log('update', 'booking-group', group.code, `Added ${created.code} to ${group.code}`)
          return d.copy(created)
        }),
      ),
    removeStay: (groupId, bookingId) =>
      d.later(() => {
        const group = findById(s.bookingGroups, groupId, 'group')
        const b = findById(s.bookings, bookingId, 'booking')
        if (b.bookingGroupId !== groupId) throw new RuleError('VALIDATION_ERROR', `${b.code} is not in ${group.code}.`)
        if (!liveStay(b)) throw new RuleError('BOOKING_INVALID_STATE', `${b.code} is over; it stays on the group's record.`)
        if (staysOf(groupId).length <= 1) throw new RuleError('GROUP_LAST_STAY', `${b.code} is the only stay of ${group.code}; cancel the group instead.`)
        delete b.bookingGroupId
        group.villaIds = villasOf(staysOf(groupId))
        d.log('update', 'booking-group', group.code, `Took ${b.code} out of ${group.code}; it carries on as a booking of its own`)
        return d.copy(b)
      }),
    pay: (groupId, input) =>
      d.later(() =>
        d.atomically(() => {
          const result = pay(findById(s.bookingGroups, groupId, 'group'), input, d.user())
          return { payments: d.copy(result.payments), link: result.link ? d.copy(result.link) : null }
        }),
      ),
  }
}
