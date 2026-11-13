import type { MessagingPort, PreCheckInPort, Ports } from '@/application/ports'
import { createServices } from '@/application/services'
import { can, ROLE_LABEL, type AuditAction, type User } from '@/domain/access'
import type { Booking } from '@/domain/booking'
import { findById, NotFoundError, RuleError } from '@/domain/errors'
import {
  addressFor,
  canResend,
  checkinTokenFor,
  checkinUrl,
  CHANNEL_LABEL,
  dueTimeTriggers,
  invoiceTokenFor,
  invoiceUrl,
  languageFor,
  payUrl,
  providerStatus,
  renderTemplate,
  STATUS_TRIGGER,
  SYSTEM_SENDER,
  validateMessagingSettings,
  validateSend,
  type Message,
  type MessageChannel,
  type MessageLanguage,
  type MessageVars,
  type TemplateKey,
} from '@/domain/messaging'
import { isGateway, type PaymentKind, type PaymentLink, type PaymentMethod } from '@/domain/payment'
import { countryName, type StayCompanion } from '@/domain/guest'
import { companionFieldsFrom, emptyTraveller, guestCanEdit, guestFieldsFrom, HOUSE_RULES, linkExpired, validatePreCheckIn, type PreCheckIn, type PublicPreCheckIn } from '@/domain/precheckin'
import { daysBetween } from '@/lib/dates'
import type { MockState } from './state'

/** The mock API's helpers that messages and online check-in reuse. */
export interface MessagingDeps {
  s: MockState
  later: <T>(value: () => T) => Promise<T>
  copy: <T>(v: T) => T
  today: () => string
  clockNow: () => string
  seq: (key: string) => number
  user: () => User
  refuse: (errors: Record<string, string | undefined>) => void
  log: (action: AuditAction, entity: string, entityId: string, summary: string, before?: Record<string, unknown> | null, after?: Record<string, unknown> | null, actor?: User) => void
  /** Room balance a stay still owes; zero once paid or on a channel stay. */
  owedOn: (b: Booking) => number
  openLink: (b: Booking, input: { kind: PaymentKind; amount: number; method: PaymentMethod; payer: string }, actor: User) => PaymentLink
  guestActor: User
  /** The finished port object, for the invoice the console's own use case renders. */
  ports: () => Ports
}

/**
 * Outbound guest messages and online check-in for the mock API. Sending stands in for the provider:
 * a message queues, turns sent after a second and delivered after five, or fails when the guest has no contact.
 */
export function createMessagingAdapter(d: MessagingDeps) {
  const { s, later, copy, today, clockNow, seq, user, refuse, log } = d
  const booking = (id: string) => findById(s.bookings, id, 'booking')
  const guestOf = (b: Booking) => findById(s.guests, b.guestId, 'guest')
  const template = (key: TemplateKey) => s.messaging.templates.find((t) => t.key === key)

  function varsFor(b: Booking, extra: Partial<MessageVars> = {}): Partial<MessageVars> {
    const place = s.catalog().place(b.unitId)
    return { guest: guestOf(b).name.split(' ')[0], villa: place.villa.name, unit: b.unitAssigned ? place.unit.code : (place.group?.name ?? ''), code: b.code, checkIn: b.checkIn, checkOut: b.checkOut, wifi: s.messaging.wifi[place.villa.id] ?? 'ask the front desk', ...extra }
  }

  /** The link a template carries when the caller gave none. */
  function defaultLink(key: TemplateKey | null, b: Booking): Partial<MessageVars> {
    if (key === 'pre_arrival') return { link: checkinUrl(b.id) }
    if (key === 'post_stay') return { link: invoiceUrl(b.id) }
    if (key === 'payment_link') {
      const open = [...s.paymentLinks].reverse().find((l) => l.bookingId === b.id && l.status === 'pending')
      return open ? { link: payUrl(open.token), amount: open.amount } : {}
    }
    return {}
  }

  /** Hands one message to the provider. A missing number or address fails it the way a gateway would. */
  function deliver(m: Message) {
    m.queuedAt = clockNow()
    m.attempts += 1
    Object.assign(m, { sentAt: null, deliveredAt: null, readAt: null, failedAt: null, error: '' })
    if (m.to) m.status = 'queued'
    else Object.assign(m, { status: 'failed', failedAt: m.queuedAt, error: m.channel === 'whatsapp' ? 'No WhatsApp number on the guest profile' : 'No email address on the guest profile' })
  }

  function queue(b: Booking, key: TemplateKey | null, fields: { channel?: MessageChannel; language?: MessageLanguage; body?: string; vars?: Partial<MessageVars> }, actor: User | null): Message {
    const t = key ? template(key) : undefined
    const guest = guestOf(b)
    const channel = fields.channel ?? t?.channel ?? 'whatsapp'
    const language = fields.language ?? languageFor(guest)
    const vars = varsFor(b, { ...defaultLink(key, b), ...fields.vars })
    const n = seq('message')
    const m: Message = {
      id: `msg-${n}`,
      number: `MSG-${String(n).padStart(4, '0')}`,
      bookingId: b.id,
      guestId: guest.id,
      to: addressFor(guest, channel),
      channel,
      templateKey: key,
      language,
      subject: t ? renderTemplate(t.subject[language], vars) : '',
      body: renderTemplate(fields.body ?? t?.body[language] ?? '', vars),
      status: 'queued',
      sentBy: actor?.name ?? SYSTEM_SENDER,
      sentById: actor?.id ?? null,
      queuedAt: clockNow(),
      sentAt: null,
      deliveredAt: null,
      readAt: null,
      failedAt: null,
      error: '',
      attempts: 0,
    }
    deliver(m)
    s.messages.push(m)
    return m
  }

  /** A trigger fires once per stay and template, and only while its template is switched on. */
  function fire(b: Booking, key: TemplateKey, vars: Partial<MessageVars> = {}, once = true) {
    if (!template(key)?.enabled) return
    if (once && s.messages.some((m) => m.bookingId === b.id && m.templateKey === key && m.sentById === null)) return
    queue(b, key, { vars }, null)
  }

  /** Moves queued messages on and sends the time triggers that fell due since the last read. */
  function sweep() {
    const now = clockNow()
    for (const m of s.messages) {
      const next = providerStatus(m, now)
      if (next === m.status) continue
      if (next === 'sent' || next === 'delivered') m.sentAt ??= now
      if (next === 'delivered') m.deliveredAt = now
      m.status = next
    }
    for (const b of s.bookings) for (const key of dueTimeTriggers(b, now, s.messaging.preArrivalDays)) fire(b, key)
  }

  const assertSender = () => {
    const me = user()
    if (!can(s.permissions, me.role, 'booking', 'edit')) throw new RuleError('FORBIDDEN', `${ROLE_LABEL[me.role]} cannot message guests.`)
    return me
  }

  function stayByToken(token: string, tokenFor: (id: string) => string, what: string) {
    const b = s.bookings.find((x) => tokenFor(x.id) === token)
    if (!b || b.status === 'draft') throw new NotFoundError(what, token)
    return b
  }

  function checkinStay(token: string) {
    const b = stayByToken(token, checkinTokenFor, 'online check-in')
    if (linkExpired(b, today())) throw new RuleError('PRECHECKIN_LINK_EXPIRED', `This check-in link closed when ${b.code} ended.`)
    return b
  }

  const preOf = (bookingId: string) => s.preCheckIns.find((p) => p.bookingId === bookingId) ?? null

  function publicView(token: string, b: Booking): PublicPreCheckIn {
    const place = s.catalog().place(b.unitId)
    const guest = guestOf(b)
    const pre = preOf(b.id)
    const adults = pre?.adults ?? b.partySize?.adults ?? 2
    const pending = s.paymentLinks.find((l) => l.bookingId === b.id && l.status === 'pending' && !l.checkOut && !l.bundle)
    const draft = { email: guest.email, phone: guest.phone, arrivalTime: '14:00', flight: '', adults, children: b.partySize?.children ?? 0, travellers: [{ ...emptyTraveller(guest.name, countryName(guest.nationality)), documentType: guest.idType, documentNumber: guest.idNumber }], idPhotos: [], rulesName: '', rulesAccepted: false }
    return {
      token,
      bookingCode: b.code,
      guestName: guest.name,
      villaName: place.villa.name,
      locationName: place.location.name,
      unitName: b.unitAssigned ? `${place.unit.code} ${place.unit.name}` : (place.group?.name ?? place.unit.name),
      checkIn: b.checkIn,
      checkOut: b.checkOut,
      nights: daysBetween(b.checkIn, b.checkOut),
      status: pre?.status ?? 'not_started',
      editable: guestCanEdit(b, pre),
      form: copy(pre ? { email: pre.email, phone: pre.phone, arrivalTime: pre.arrivalTime, flight: pre.flight, adults: pre.adults, children: pre.children, travellers: pre.travellers, idPhotos: pre.idPhotos, rulesName: pre.rulesName, rulesAccepted: pre.rulesAccepted } : draft),
      balance: b.source === 'direct' ? Math.max(0, d.owedOn(b)) : 0,
      payToken: pending?.token ?? null,
      // The villa's own rules once it has them, else the operator's standard list.
      houseRules: place.villa.houseRules.trim() ? place.villa.houseRules.split('\n').map((r) => r.trim()).filter(Boolean) : HOUSE_RULES,
      checkInTime: place.villa.checkInTime,
      checkOutTime: place.villa.checkOutTime,
      today: today(),
    }
  }

  const messaging: MessagingPort = {
    messages: () =>
      later(() => {
        sweep()
        return copy(s.messages)
      }),
    settings: () => later(() => copy(s.messaging)),
    saveSettings: (settings) =>
      later(() => {
        assertSender()
        refuse(validateMessagingSettings(settings))
        const before = Object.fromEntries(s.messaging.templates.map((t) => [t.key, t.enabled]))
        s.messaging = copy(settings)
        log('update', 'message-settings', 'messaging', `Changed the guest message templates; pre-arrival ${settings.preArrivalDays} days before`, before, Object.fromEntries(settings.templates.map((t) => [t.key, t.enabled])))
        return copy(s.messaging)
      }),
    send: (input) =>
      later(() => {
        const me = assertSender()
        refuse(validateSend(input))
        const b = booking(input.bookingId)
        const m = queue(b, input.templateKey, { channel: input.channel, language: input.language, ...(input.templateKey ? {} : { body: input.body.trim() }) }, me)
        log('create', 'message', m.number, `Sent ${m.templateKey ? (template(m.templateKey)?.name ?? m.templateKey) : 'a message'} to ${guestOf(b).name} on ${CHANNEL_LABEL[m.channel]} for ${b.code}`, null, { status: m.status }, me)
        return copy(m)
      }),
    resend: (id) =>
      later(() => {
        const me = assertSender()
        const m = findById(s.messages, id, 'message')
        if (!canResend(m)) throw new RuleError('MESSAGE_NOT_FAILED', `${m.number} is ${m.status}; only a failed message goes again.`)
        m.to = addressFor(guestOf(booking(m.bookingId)), m.channel)
        deliver(m)
        log('update', 'message', m.number, `Resent ${m.number}, attempt ${m.attempts}`, { status: 'failed' }, { status: m.status }, me)
        return copy(m)
      }),
    invoice: async (token) => {
      const b = await later(() => stayByToken(token, invoiceTokenFor, 'invoice'))
      // The server renders the e-invoice with the console's own invoice use case, as a reader of every villa.
      const reader: User = { ...d.guestActor, role: 'owner', name: 'E-invoice' }
      const ports = d.ports()
      return createServices({ ...ports, access: { ...ports.access, session: async () => reader } }).payments.invoice(b.id)
    },
  }

  const precheckin: PreCheckInPort = {
    preCheckIns: () => later(() => copy(s.preCheckIns)),
    verify: (bookingId) =>
      later(() => {
        const me = assertSender()
        const b = booking(bookingId)
        const pre = preOf(b.id)
        if (!pre) throw new RuleError('PRECHECKIN_NOT_SUBMITTED', `${b.code} has no online check-in to verify yet.`)
        if (pre.status === 'verified') throw new RuleError('PRECHECKIN_VERIFIED', `${b.code} was verified by ${pre.verifiedBy}.`)
        if (b.status !== 'confirmed') throw new RuleError('BOOKING_INVALID_STATE', `${b.code} is ${b.status.replace('_', ' ')}; verify before check-in.`)
        const guest = guestOf(b)
        const fields = guestFieldsFrom(pre, guest)
        const before = { nationality: guest.nationality, idNumber: guest.idNumber, phone: guest.phone, email: guest.email }
        if (fields) Object.assign(guest, fields)
        // The other travellers become stay companions; a document number already on the stay updates that companion.
        const companions = companionFieldsFrom(pre, s.companions.filter((c) => c.bookingId === b.id)).map(({ id, fields: f }) => {
          const known = id ? s.companions.find((c) => c.id === id) : undefined
          if (known) return Object.assign(known, f)
          const c: StayCompanion = { birthPlace: '', addressInIndonesia: '', ...f, id: `cmp-${seq('companion')}`, bookingId: b.id }
          s.companions.push(c)
          return c
        })
        b.partySize = { adults: pre.adults, children: pre.children }
        Object.assign(pre, { status: 'verified', verifiedBy: me.name, verifiedById: me.id, verifiedAt: clockNow() })
        const registered = companions.length ? ` and registered ${companions.map((c) => c.name).join(', ')}` : ''
        log('status', 'precheckin', b.code, `Verified the online check-in of ${b.code} against the ID${registered}`, before, { nationality: guest.nationality, idNumber: guest.idNumber, phone: guest.phone, email: guest.email, party: pre.adults + pre.children, companions: companions.length }, me)
        return copy(pre)
      }),
    guestView: (token) => later(() => publicView(token, checkinStay(token))),
    submit: (token, input) =>
      later(() => {
        const b = checkinStay(token)
        const pre = preOf(b.id)
        if (!guestCanEdit(b, pre)) throw new RuleError('PRECHECKIN_LOCKED', pre?.status === 'verified' ? 'The front desk already verified your details. Ask them to change anything.' : 'You are checked in already.')
        const errors = validatePreCheckIn(input, b)
        refuse(errors)
        const fields = { ...copy(input), email: input.email.trim(), phone: input.phone.trim(), flight: input.flight.trim().toUpperCase(), rulesName: input.rulesName.trim(), idPhotos: input.idPhotos.map((f) => ({ ...f, uploadedBy: d.guestActor.name })) }
        const record: PreCheckIn = { ...fields, bookingId: b.id, status: 'submitted', submittedAt: clockNow(), verifiedBy: null, verifiedById: null, verifiedAt: null }
        s.preCheckIns = [...s.preCheckIns.filter((p) => p.bookingId !== b.id), record]
        log(pre ? 'update' : 'create', 'precheckin', b.code, `Guest ${pre ? 'updated' : 'sent'} the online check-in for ${b.code}`, null, { adults: record.adults, arrivalTime: record.arrivalTime }, d.guestActor)
        return publicView(token, b)
      }),
    payBalance: (token, method) =>
      later(() => {
        const b = checkinStay(token)
        if (!isGateway(method)) throw new RuleError('VALIDATION_ERROR', 'Pay by QRIS, virtual account or card.')
        const owed = b.source === 'direct' ? d.owedOn(b) : 0
        if (owed <= 0) throw new RuleError('PAYMENT_OVERPAID', `Nothing is left to pay on ${b.code}.`)
        const open = s.paymentLinks.find((l) => l.bookingId === b.id && l.status === 'pending' && !l.checkOut && !l.bundle)
        if (open) return copy(open)
        return copy(d.openLink(b, { kind: 'balance', amount: owed, method, payer: guestOf(b).name }, d.guestActor))
      }),
  }

  return {
    messaging,
    precheckin,
    /** Fires the trigger of a booking status: confirmation, welcome, thank you with the e-invoice. */
    onStatus(b: Booking) {
      const key = STATUS_TRIGGER[b.status]
      if (key && !(key === 'booking_confirmed' && b.bookingGroupId)) fire(b, key)
    },
    /** Payment links and receipts repeat on a stay, so they fire every time. */
    onLink(link: PaymentLink) {
      fire(booking(link.bookingId), 'payment_link', { link: payUrl(link.token), amount: link.amount }, false)
    },
    onPaid(bookingId: string, amount: number) {
      fire(booking(bookingId), 'payment_received', { amount }, false)
    },
  }
}
