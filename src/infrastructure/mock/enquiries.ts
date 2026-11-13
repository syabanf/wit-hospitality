import type { EnquiryPort, SitePort } from '@/application/ports'
import { can, ROLE_LABEL, type AuditAction, type User } from '@/domain/access'
import { occupies, overlaps } from '@/domain/booking'
import { canMoveEnquiry, ENQUIRY_STATUS_LABEL, enquiryNumber, isOwnerEnquiry, validateEnquiry, type Enquiry } from '@/domain/enquiry'
import { findById, RuleError } from '@/domain/errors'
import { siteTeam, type SiteHold } from '@/domain/site'
import type { MockState } from './state'

interface Context {
  s: MockState
  later: <T>(value: () => T) => Promise<T>
  today: () => string
  clockNow: () => string
  seq: (key: string) => number
  user: () => User
  refuse: (errors: Record<string, string | undefined>) => void
  log: (action: AuditAction, entity: string, entityId: string, summary: string, before?: Record<string, unknown> | null, after?: Record<string, unknown> | null, actor?: User) => void
  /** Who the audit names for a guest acting without a session. */
  guest: User
}

/** The public website's reads and web enquiries, and the console side of those enquiries. */
export function createSiteAdapter({ s, later, today, clockNow, seq, user, refuse, log, guest }: Context): { site: SitePort; enquiries: EnquiryPort } {
  const copy = <T>(v: T): T => structuredClone(v)

  function allow(action: 'view' | 'edit') {
    const me = user()
    if (!can(s.permissions, me.role, 'booking', action)) throw new RuleError('FORBIDDEN', `${ROLE_LABEL[me.role]} cannot ${action} web enquiries.`)
    return me
  }

  function move(e: Enquiry, to: Enquiry['status'], note: string, me: User) {
    if (!canMoveEnquiry(e.status, to)) throw new RuleError('ENQUIRY_INVALID_STATE', `${e.number} is ${ENQUIRY_STATUS_LABEL[e.status]} and cannot move to ${ENQUIRY_STATUS_LABEL[to]}.`)
    const before = { status: e.status }
    Object.assign(e, { status: to, handledBy: me.name, statusNote: note.trim() })
    log('status', 'enquiry', e.number, `Marked ${e.number} ${ENQUIRY_STATUS_LABEL[to].toLowerCase()}`, before, { status: to, note: e.statusNote })
  }

  const site: SitePort = {
    inventory: () =>
      later(() => ({
        locations: copy(s.locations),
        villas: s.villas.map(({ phone: _phone, email: _email, licenseNo: _licence, bankName: _bank, bankAccountNo: _account, bankAccountName: _holder, ...v }) => copy(v)),
        groups: copy(s.groups),
        units: copy(s.units),
        listings: s.listings.map((l) => ({ unitId: l.unitId, status: l.status, dateRates: { ...l.dateRates } })),
        ratePlans: copy(s.ratePlans),
        restrictions: s.restrictions.map(({ createdBy: _by, createdOn: _on, note: _note, ...r }) => copy(r)),
        tax: { rates: copy(s.tax.rates), directMode: s.tax.directMode },
        menu: s.menu.filter((i) => i.active).map((i) => ({ id: i.id, villaId: i.villaId, category: i.category, name: i.name, description: i.description, price: i.price, unit: i.unit })),
        // The console keeps no public contact yet; the website shows marked placeholders.
        contact: { whatsapp: null, email: null },
        team: siteTeam(s.employees),
      })),
    holds: (from, to) =>
      later(() => [
        ...s.bookings.filter((b) => occupies(b) && overlaps(b.checkIn, b.checkOut, from, to)).map((b): SiteHold => ({ unitId: b.unitId, unitAssigned: b.unitAssigned, from: b.checkIn, to: b.checkOut })),
        ...s.blocks.filter((k) => overlaps(k.from, k.to, from, to)).map((k): SiteHold => ({ unitId: k.unitId, unitAssigned: true, from: k.from, to: k.to })),
      ]),
    enquire: (input) =>
      later(() => {
        refuse(validateEnquiry(input, today()))
        const owner = isOwnerEnquiry(input)
        // An owner writes about a villa we do not run yet: no villa, dates or party to keep.
        const villa = owner ? null : findById(s.villas, input.villaId, 'villa')
        if (villa && !s.units.some((u) => u.villaId === villa.id && u.status !== 'inactive' && (!input.groupId || u.groupId === input.groupId))) throw new RuleError('SITE_VILLA_CLOSED', `${villa.name} is not taking stays at the moment.`)
        const n = seq('enquiry')
        const enquiry: Enquiry = {
          ...input,
          ...(owner ? { villaId: '', groupId: null, checkIn: '', checkOut: '', guests: 0 } : {}),
          name: input.name.trim(),
          email: input.email.trim(),
          whatsapp: input.whatsapp.trim(),
          note: input.note.trim(),
          id: `enq-${n}`,
          number: enquiryNumber(n),
          status: 'new',
          bookingId: null,
          createdOn: today(),
          createdAt: clockNow(),
          handledBy: null,
          statusNote: '',
        }
        s.enquiries.unshift(enquiry)
        log('create', 'enquiry', enquiry.number, villa ? `Web enquiry ${enquiry.number} for ${villa.name}` : `Owner enquiry ${enquiry.number}`, null, null, guest)
        return { number: enquiry.number, villaName: villa?.name ?? '', checkIn: enquiry.checkIn, checkOut: enquiry.checkOut }
      }),
  }

  const enquiries: EnquiryPort = {
    enquiries: () =>
      later(() => {
        allow('view')
        return copy(s.enquiries)
      }),
    setStatus: (id, status, note) =>
      later(() => {
        const me = allow('edit')
        const e = findById(s.enquiries, id, 'enquiry')
        if (status === 'closed' && note.trim().length < 3) refuse({ note: 'Say why it is closed.' })
        move(e, status, note, me)
        return copy(e)
      }),
    convert: (id, bookingId) =>
      later(() => {
        const me = allow('edit')
        const e = findById(s.enquiries, id, 'enquiry')
        const booking = findById(s.bookings, bookingId, 'booking')
        move(e, 'converted', `Booked as ${booking.code}`, me)
        e.bookingId = booking.id
        return copy(e)
      }),
  }

  return { site, enquiries }
}
