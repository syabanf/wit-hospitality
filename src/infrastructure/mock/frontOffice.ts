import type { LogBookPort, PreAuthPort, RoomCheckPort } from '@/application/frontOfficePorts'
import { can, ROLE_LABEL, type Action, type AuditAction, type Module, type User } from '@/domain/access'
import type { Booking } from '@/domain/booking'
import { findById, RuleError } from '@/domain/errors'
import type { GuestFolio } from '@/domain/folio'
import { acknowledgeProblem, doneProblem, LOG_CATEGORY_LABEL, shiftOf, validateLog, type LogEntry, type LogLink } from '@/domain/logBook'
import { gatewayFee, type Payment } from '@/domain/payment'
import { captureProblem, CARD_BRAND_LABEL, cardLabel, closedProblem, gatewayApprovalCode, gatewayDeclines, holdProblem, validatePreAuth, type PreAuth } from '@/domain/preAuth'
import { checkSummary, DISCREPANCY_ACTION_LABEL, DISCREPANCY_LABEL, discrepancyOf, frontOfficeStay, roomCheckId, stayPersons, validateResolve, validateRoomCheck, type RoomCheck } from '@/domain/roomCheck'
import type { MockState } from './state'

/** The mock API's shared helpers the front office controls need. */
export interface FrontOfficeContext {
  s: MockState
  later: <T>(value: () => T) => Promise<T>
  copy: <T>(v: T) => T
  today: () => string
  clockNow: () => string
  user: () => User
  seq: (key: string) => number
  refuse: (errors: Record<string, string | undefined>) => void
  log: (action: AuditAction, entity: string, entityId: string, summary: string, before?: Record<string, unknown> | null, after?: Record<string, unknown> | null, actor?: User) => void
  /** The payment path the desk records through: a paid payment on the stay's shift. */
  newPayment: (b: Booking, fields: Pick<Payment, 'kind' | 'method' | 'amount' | 'status' | 'reference' | 'payer' | 'note'> & Partial<Payment>, actor: User) => Payment
  /** Lands a paid payment in the ledger, as the gateway's confirmation does. */
  bookMoney: (p: Payment, actor: User) => void
  syncBooking: (bookingId: string) => void
  folioOf: (b: Booking) => GuestFolio
}

const rupiah = (n: number) => n.toLocaleString('id-ID')

export function createFrontOffice({ s, later, copy, today, clockNow, user, seq, refuse, log, newPayment, bookMoney, syncBooking, folioOf }: FrontOfficeContext) {
  const allow = (module: Module, action: Action, what: string) => {
    const me = user()
    if (!can(s.permissions, me.role, module, action)) throw new RuleError('FORBIDDEN', `${ROLE_LABEL[me.role]} cannot ${what}.`)
    return me
  }
  const unitCode = (unitId: string) => s.catalog().unit(unitId).code

  const roomChecks: RoomCheckPort = {
    checks: () => later(() => copy([...s.roomChecks].sort((a, b) => b.date.localeCompare(a.date) || unitCode(a.unitId).localeCompare(unitCode(b.unitId))))),
    record: (input) =>
      later(() => {
        const me = allow('maintenance', 'edit', 'record room checks')
        const unit = findById(s.units, input.unitId, 'unit')
        refuse(validateRoomCheck(input, today()))
        const id = roomCheckId(input.date, unit.id)
        const current = s.roomChecks.find((c) => c.id === id)
        if (current?.resolution) throw new RuleError('ROOM_CHECK_RESOLVED', `${unit.code} on ${input.date} is resolved; its check stays as recorded.`)
        const stay = frontOfficeStay(s.bookings, unit.id, input.date)
        const persons = input.found === 'occupied' ? input.persons : null
        const frontPersons = stay ? stayPersons(stay) : null
        const check: RoomCheck = {
          id,
          unitId: unit.id,
          villaId: unit.villaId,
          date: input.date,
          found: input.found,
          persons,
          note: input.note.trim(),
          checkedBy: me.name,
          checkedAt: clockNow(),
          frontOffice: stay ? 'occupied' : 'vacant',
          bookingId: stay?.id ?? null,
          bookingCode: stay?.code ?? null,
          frontPersons,
          discrepancy: discrepancyOf(input.found, persons, Boolean(stay), frontPersons),
          resolution: null,
        }
        s.roomChecks = [...s.roomChecks.filter((c) => c.id !== id), check]
        log(current ? 'update' : 'create', 'room-check', id, checkSummary(check, unit.code), current ? { found: current.found } : null, { found: check.found, discrepancy: check.discrepancy })
        return copy(check)
      }),
    resolve: (id, input) =>
      later(() => {
        const me = allow('booking', 'edit', 'resolve discrepancies')
        const check = findById(s.roomChecks, id, 'room check')
        const code = unitCode(check.unitId)
        refuse(validateResolve(check, code, input))
        const kind = check.discrepancy ?? 'sleep'
        check.resolution = { action: input.action, note: input.note.trim(), by: me.name, at: clockNow() }
        log('status', 'room-check', id, `Resolved ${DISCREPANCY_LABEL[kind].toLowerCase()} on ${code} ${check.date}: ${DISCREPANCY_ACTION_LABEL[input.action]}`, { resolution: null }, { action: input.action })
        return copy(check)
      }),
  }

  const hold = (id: string) => findById(s.preAuths, id, 'card hold')
  const close = (h: PreAuth, me: User) => Object.assign(h, { closedBy: me.name, closedAt: clockNow() })

  // The mock is the demo gateway: it authorizes, captures and releases on the desk's word, and
  // declines a card ending 0000.
  const preAuths: PreAuthPort = {
    preAuths: () => later(() => copy(s.preAuths)),
    create: (input) =>
      later(() => {
        const me = allow('payments', 'create', 'take card holds')
        const b = findById(s.bookings, input.bookingId, 'booking')
        refuse(validatePreAuth(input, today()))
        const problem = holdProblem(b, s.preAuths)
        if (problem) throw problem
        if (gatewayDeclines(input.last4)) throw new RuleError('PREAUTH_DECLINED', `The gateway declined the hold on ${CARD_BRAND_LABEL[input.brand]} ending ${input.last4}.`)
        const n = seq('preAuth')
        const h: PreAuth = {
          id: `pa-${n}`,
          number: `PA-${1000 + n}`,
          bookingId: b.id,
          amount: input.amount,
          brand: input.brand,
          last4: input.last4,
          approvalCode: input.approvalCode.trim() || gatewayApprovalCode(n),
          expiresOn: input.expiresOn,
          status: 'active',
          takenBy: me.name,
          takenAt: clockNow(),
          captured: 0,
          paymentId: null,
          closedBy: null,
          closedAt: null,
        }
        s.preAuths.push(h)
        log('create', 'pre-auth', h.number, `Held ${rupiah(h.amount)} on ${cardLabel(h)} for ${b.code}, until ${h.expiresOn}`, null, { amount: h.amount })
        return copy(h)
      }),
    capture: (id, amount) =>
      later(() => {
        const me = allow('payments', 'create', 'capture card holds')
        const h = hold(id)
        const b = findById(s.bookings, h.bookingId, 'booking')
        refuse(captureProblem(h, amount, folioOf(b).due.room, today()))
        const p = newPayment(b, { kind: 'balance', method: 'card', amount, status: 'paid', reference: h.approvalCode, payer: '', note: `Captured from ${h.number}`, paidOn: today(), gatewayFee: gatewayFee('card', amount, s.paymentPolicy) }, me)
        p.history = [...p.history, { kind: 'paid', by: me.name, at: clockNow(), note: 'Card hold captured' }]
        bookMoney(p, me)
        syncBooking(b.id)
        Object.assign(close(h, me), { status: 'captured', captured: amount, paymentId: p.id })
        log('status', 'pre-auth', h.number, `Captured ${rupiah(amount)} of ${h.number} on ${b.code}`, { status: 'active' }, { status: 'captured', captured: amount })
        return { preAuth: copy(h), payment: copy(p) }
      }),
    release: (id) =>
      later(() => {
        const me = allow('payments', 'create', 'release card holds')
        const h = hold(id)
        const closed = closedProblem(h)
        if (closed) throw closed
        close(h, me).status = 'released'
        log('status', 'pre-auth', h.number, `Released ${h.number} on ${findById(s.bookings, h.bookingId, 'booking').code}`, { status: 'active' }, { status: 'released' })
        return copy(h)
      }),
  }

  /** A note in the book, in the writer's shift; the shift close and the page both write through it. */
  function addEntry(fields: Pick<LogEntry, 'category' | 'text' | 'villaId' | 'link' | 'followUp' | 'shiftId'>, me: User): LogEntry {
    const at = clockNow()
    const entry: LogEntry = { id: `log-${seq('logEntry')}`, at, ...shiftOf(at), author: me.name, authorId: me.id, ...fields, text: fields.text.trim(), acknowledgedBy: null, acknowledgedAt: null, doneBy: null, doneAt: null, doneNote: '' }
    s.logEntries.push(entry)
    log('create', 'log-entry', entry.id, `Logged ${LOG_CATEGORY_LABEL[entry.category].toLowerCase()} note${entry.followUp ? ', follow-up' : ''}`, null, { category: entry.category, followUp: entry.followUp }, me)
    return entry
  }
  const linkOf = (link: { kind: LogLink['kind']; id: string }): LogLink | null => {
    if (link.kind === 'booking') {
      const b = s.bookings.find((x) => x.id === link.id)
      return b ? { ...link, label: b.code } : null
    }
    if (link.kind === 'unit') {
      const u = s.units.find((x) => x.id === link.id)
      return u ? { ...link, label: u.code } : null
    }
    const g = s.guests.find((x) => x.id === link.id)
    return g ? { ...link, label: g.name } : null
  }
  const entry = (id: string) => findById(s.logEntries, id, 'log entry')

  const logBook: LogBookPort = {
    entries: () => later(() => copy([...s.logEntries].sort((a, b) => b.at.localeCompare(a.at)))),
    write: (input) =>
      later(() => {
        const me = allow('booking', 'edit', 'write in the log book')
        const link = input.link ? linkOf(input.link) : null
        refuse({ ...validateLog(input), ...(input.link && !link ? { link: 'That booking, room or guest was not found.' } : {}), ...(input.villaId && !s.villas.some((v) => v.id === input.villaId) ? { villaId: 'Pick a property.' } : {}) })
        return copy(addEntry({ category: input.category, text: input.text, villaId: input.villaId, link, followUp: input.followUp, shiftId: null }, me))
      }),
    acknowledge: (id) =>
      later(() => {
        const me = allow('booking', 'edit', 'acknowledge log book notes')
        const e = entry(id)
        const problem = acknowledgeProblem(e, me.id)
        if (problem) throw problem
        Object.assign(e, { acknowledgedBy: me.name, acknowledgedAt: clockNow() })
        log('status', 'log-entry', id, `Acknowledged the note of ${e.author}`)
        return copy(e)
      }),
    done: (id, note) =>
      later(() => {
        const me = allow('booking', 'edit', 'close log book notes')
        const e = entry(id)
        refuse(doneProblem(e, note))
        const at = clockNow()
        Object.assign(e, { doneBy: me.name, doneAt: at, doneNote: note.trim(), acknowledgedBy: e.acknowledgedBy ?? me.name, acknowledgedAt: e.acknowledgedAt ?? at })
        log('status', 'log-entry', id, `Marked the note of ${e.author} done`)
        return copy(e)
      }),
  }

  /** The handover a cashier writes when closing the shift: an entry in the book, no follow-up. */
  const handover = (shiftId: string, text: string, me: User) => addEntry({ category: 'handover', text, villaId: null, link: null, followUp: false, shiftId }, me).id

  return { roomChecks, preAuths, logBook, handover }
}
