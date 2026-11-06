import type { GuestPort, LostFoundPort } from '@/application/ports'
import { can, type AuditAction, type User } from '@/domain/access'
import type { Booking } from '@/domain/booking'
import { findById, RuleError } from '@/domain/errors'
import { documentExpired, foreignDataMissing, ID_TYPE_LABEL, isForeign, NO_DOCUMENT, NO_PREFERENCES, validateCompanion, validateGuest, type CompanionInput, type Guest, type GuestInput, type TravelDocument } from '@/domain/guest'
import { LOST_STATUS_LABEL, validateLostItem, validateLostMove, type LostItem, type LostItemInput } from '@/domain/lostFound'
import type { MockState } from './state'

/** The mock API's shared helpers the guest tables need. */
export interface GuestContext {
  s: MockState
  later: <T>(value: () => T) => Promise<T>
  today: () => string
  clockNow: () => string
  user: () => User
  seq: (key: string) => number
  refuse: (errors: Record<string, string | undefined>) => void
  log: (action: AuditAction, entity: string, entityId: string, summary: string, before?: Record<string, unknown> | null, after?: Record<string, unknown> | null, actor?: User) => void
}

const trimmed = (input: GuestInput) => ({ ...input, name: input.name.trim(), email: input.email.trim(), phone: input.phone.trim(), idNumber: input.idNumber.trim(), notes: input.notes.trim(), ...(input.tags ? { tags: [...new Set(input.tags.map((t) => t.trim()).filter(Boolean))] } : {}) })

/**
 * Guest profiles, stay companions, Immigration reports and lost and found for the mock API.
 * Blacklisting and merging need approve in the guest module; check-in asks for the APOA fields of every foreign adult.
 */
export function createGuestAdapter({ s, later, today, clockNow, user, seq, refuse, log }: GuestContext) {
  const copy = <T>(v: T): T => structuredClone(v)
  const guestOf = (id: string) => findById(s.guests, id, 'guest')
  const mayApprove = (me: User) => can(s.permissions, me.role, 'guest', 'approve')
  const requireApprove = (what: string) => {
    const me = user()
    if (!mayApprove(me)) throw new RuleError('FORBIDDEN', `Only someone who may approve in the guest module can ${what}.`)
    return me
  }

  function createGuest(input: GuestInput): Guest {
    refuse(validateGuest(input))
    const guest: Guest = { ...NO_DOCUMENT, preferences: { ...NO_PREFERENCES }, vipLevel: 0, vipReason: '', tags: [], blacklist: null, ...trimmed(input), id: `g-${String(seq('guest')).padStart(2, '0')}`, createdOn: today() }
    s.guests.push(guest)
    return guest
  }

  /** Refuses a stay for a blacklisted guest unless someone who may approve gives a reason; the override is audited. */
  function assertBookable(guestId: string, override?: string) {
    const g = s.guests.find((x) => x.id === guestId)
    if (!g?.blacklist) return
    if (!override?.trim()) throw new RuleError('GUEST_BLACKLISTED', `${g.name} is blacklisted: ${g.blacklist.reason}. A villa manager can book them with a reason.`)
    const me = requireApprove('book a blacklisted guest')
    log('approve', 'guest', g.id, `${me.name} booked blacklisted ${g.name} anyway: ${override.trim()}`, { blacklist: g.blacklist.reason }, { override: override.trim() })
  }

  /** Every foreign adult on the stay needs the APOA fields and a document still valid on arrival. */
  function assertCheckInReady(b: Booking) {
    const lead = guestOf(b.guestId)
    const people: Array<{ name: string } & TravelDocument> = [lead, ...s.companions.filter((c) => c.bookingId === b.id && c.adult)]
    const gaps = people.map((p) => ({ p, missing: foreignDataMissing(p) })).filter((x) => x.missing.length)
    if (gaps.length) throw new RuleError('FOREIGN_DATA_MISSING', `Immigration needs more for ${gaps.map((x) => `${x.p.name}: ${x.missing.join(', ')}`).join('; ')}.`)
    const expired = people.find((p) => isForeign(p) && documentExpired(p, today()))
    if (expired) throw new RuleError('DOCUMENT_EXPIRED', `${expired.name}'s ${ID_TYPE_LABEL[expired.idType].toLowerCase()} expired on ${expired.idExpiry}. Ask for a valid one before check-in.`)
  }

  const stayOf = (bookingId: string) => findById(s.bookings, bookingId, 'booking')
  const openStay = (b: Booking) => {
    if (b.status === 'checked_out' || b.status === 'cancelled' || b.status === 'no_show') throw new RuleError('BOOKING_INVALID_STATE', `${b.code} is closed; companions cannot change.`)
  }
  const companionOf = (id: string) => findById(s.companions, id, 'companion')
  const cleanCompanion = (input: CompanionInput) => ({ ...input, name: input.name.trim(), idNumber: input.idNumber.trim() })

  const port: GuestPort = {
    guests: () => later(() => copy(s.guests)),
    create: (input) =>
      later(() => {
        const g = createGuest(input)
        log('create', 'guest', g.id, `Added guest ${g.name}`)
        return copy(g)
      }),
    update: (id, input) =>
      later(() => {
        refuse(validateGuest(input))
        const g = guestOf(id)
        const before = { vipLevel: g.vipLevel, nationality: g.nationality, idNumber: g.idNumber }
        Object.assign(g, trimmed(input))
        log('update', 'guest', id, `Edited guest ${g.name}`, before, { vipLevel: g.vipLevel, nationality: g.nationality, idNumber: g.idNumber })
        return copy(g)
      }),
    setBlacklist: (id, reason) =>
      later(() => {
        const me = requireApprove('change the blacklist')
        const g = guestOf(id)
        if (reason !== null && reason.trim().length < 5) throw new RuleError('VALIDATION_ERROR', 'Say why the guest is blacklisted.')
        const before = g.blacklist
        g.blacklist = reason === null ? null : { reason: reason.trim(), setBy: me.name, setOn: today() }
        log(reason === null ? 'update' : 'status', 'guest', id, reason === null ? `Took ${g.name} off the blacklist` : `Blacklisted ${g.name}: ${reason.trim()}`, { blacklist: before?.reason ?? null }, { blacklist: g.blacklist?.reason ?? null })
        return copy(g)
      }),
    merge: (keepId, dropId) =>
      later(() => {
        requireApprove('merge guest profiles')
        if (keepId === dropId) throw new RuleError('VALIDATION_ERROR', 'Pick two different profiles.')
        const keep = guestOf(keepId)
        const drop = guestOf(dropId)
        // Orders, payments and folio lines hang off the stays, so they follow them.
        const stays = s.bookings.filter((b) => b.guestId === dropId)
        const groups = s.bookingGroups.filter((g) => g.leadGuestId === dropId)
        const items = s.lostItems.filter((i) => i.guestId === dropId)
        for (const b of stays) b.guestId = keepId
        for (const g of groups) g.leadGuestId = keepId
        for (const i of items) i.guestId = keepId
        for (const r of s.foreignReports) if (r.personId === dropId) r.personId = keepId
        const moved = { stays: stays.length, groups: groups.length, items: items.length }
        // Blanks on the kept profile take the dropped profile's value; tags join, the higher VIP level stays.
        const fill = <K extends keyof Guest>(k: K) => {
          if (!keep[k] && drop[k]) keep[k] = drop[k]
        }
        for (const k of ['email', 'phone', 'idNumber', 'idExpiry', 'birthDate', 'sex', 'birthPlace', 'entryDate', 'entryPort', 'visaType', 'addressInIndonesia'] as const) fill(k)
        keep.preferences = Object.fromEntries(Object.entries(keep.preferences).map(([k, v]) => [k, v || drop.preferences[k as keyof typeof drop.preferences]])) as Guest['preferences']
        keep.tags = [...new Set([...keep.tags, ...drop.tags])]
        if (drop.vipLevel > keep.vipLevel) Object.assign(keep, { vipLevel: drop.vipLevel, vipReason: drop.vipReason })
        keep.blacklist ??= drop.blacklist
        keep.notes = [keep.notes, drop.notes].filter(Boolean).join('\n')
        keep.createdOn = keep.createdOn < drop.createdOn ? keep.createdOn : drop.createdOn
        s.guests = s.guests.filter((g) => g.id !== dropId)
        log('update', 'guest', keepId, `Merged ${drop.name} (${dropId}) into ${keep.name}: ${moved.stays} stays, ${moved.groups} groups, ${moved.items} lost items moved`, { dropped: dropId }, moved)
        return copy(keep)
      }),
    companions: () => later(() => copy(s.companions)),
    addCompanion: (bookingId, input) =>
      later(() => {
        const b = stayOf(bookingId)
        openStay(b)
        refuse(validateCompanion(input))
        const c = { ...cleanCompanion(input), id: `cmp-${seq('companion')}`, bookingId }
        s.companions.push(c)
        log('create', 'companion', c.id, `Registered ${c.name} on ${b.code}`)
        return copy(c)
      }),
    updateCompanion: (id, input) =>
      later(() => {
        const c = companionOf(id)
        openStay(stayOf(c.bookingId))
        refuse(validateCompanion(input))
        Object.assign(c, cleanCompanion(input))
        log('update', 'companion', id, `Edited companion ${c.name}`)
        return copy(c)
      }),
    removeCompanion: (id) =>
      later(() => {
        const c = companionOf(id)
        openStay(stayOf(c.bookingId))
        s.companions = s.companions.filter((x) => x.id !== id)
        log('delete', 'companion', id, `Removed ${c.name} from ${stayOf(c.bookingId).code}`)
      }),
    foreignReports: () => later(() => copy(s.foreignReports)),
    markReported: (bookingId, personIds, reference) =>
      later(() => {
        const me = user()
        const b = stayOf(bookingId)
        if (b.status !== 'checked_in' && b.status !== 'checked_out') throw new RuleError('BOOKING_INVALID_STATE', `${b.code} has not checked in; report the guests once they arrive.`)
        const onStay = new Set([b.guestId, ...s.companions.filter((c) => c.bookingId === b.id).map((c) => c.id)])
        const unknown = personIds.find((p) => !onStay.has(p))
        if (unknown) throw new RuleError('VALIDATION_ERROR', `${unknown} is not registered on ${b.code}.`)
        const fresh = personIds.filter((p) => !s.foreignReports.some((r) => r.bookingId === b.id && r.personId === p))
        if (!fresh.length) throw new RuleError('ALREADY_REPORTED', `Everyone picked on ${b.code} is already reported.`)
        const lines = fresh.map((personId) => ({ id: `fr-${seq('foreignReport')}`, bookingId: b.id, personId, reportedAt: clockNow(), reportedBy: me.name, reference: reference.trim() }))
        s.foreignReports.push(...lines)
        log('create', 'foreign-report', b.code, `Reported ${lines.length} foreign guest${lines.length === 1 ? '' : 's'} on ${b.code} to Immigration${reference.trim() ? `, ${reference.trim()}` : ''}`)
        return copy(lines)
      }),
  }

  const itemOf = (id: string) => findById(s.lostItems, id, 'lost item')
  const cleanItem = (input: LostItemInput) => {
    refuse(validateLostItem(input, today()))
    const unit = input.unitId ? s.catalog().unit(input.unitId) : null
    if (unit && unit.villaId !== input.villaId) throw new RuleError('VALIDATION_ERROR', `${unit.code} is not in that villa.`)
    if (input.bookingId) {
      const b = stayOf(input.bookingId)
      if (input.guestId && input.guestId !== b.guestId) throw new RuleError('VALIDATION_ERROR', `${b.code} is booked by another guest.`)
      return { ...input, guestId: b.guestId, where: input.where.trim(), description: input.description.trim(), storage: input.storage.trim(), photos: [...input.photos] }
    }
    if (input.guestId) guestOf(input.guestId)
    return { ...input, where: input.where.trim(), description: input.description.trim(), storage: input.storage.trim(), photos: [...input.photos] }
  }

  /** A new find in the finder's name; the desk page and the room attendant's task both log through here. */
  function logFind(input: LostItemInput, me: User): LostItem {
    const fields = cleanItem(input)
    const n = seq('lostItem')
    const item: LostItem = { ...fields, id: `lf-${n}`, number: `LF-${String(n).padStart(3, '0')}`, foundBy: me.name, status: 'found', returned: null, history: [{ status: 'found', by: me.name, at: clockNow(), note: '' }] }
    s.lostItems.push(item)
    log('create', 'lost-item', item.number, `Logged ${item.description} found at ${s.catalog().villa(item.villaId).name}`, null, null, me)
    return item
  }

  const lostFound: LostFoundPort = {
    items: () => later(() => copy(s.lostItems)),
    create: (input) => later(() => copy(logFind(input, user()))),
    update: (id, input) =>
      later(() => {
        const item = itemOf(id)
        Object.assign(item, cleanItem(input))
        log('update', 'lost-item', item.number, `Edited ${item.number}`)
        return copy(item)
      }),
    move: (id, move) =>
      later(() => {
        const me = user()
        const item = itemOf(id)
        const problem = validateLostMove(item, move, today(), s.lostFoundSettings)
        if (problem) throw new RuleError('LOST_ITEM_INVALID_STATE', problem)
        const before = item.status
        item.status = move.to
        if (move.to === 'returned' && move.returned) item.returned = { ...move.returned, to: move.returned.to.trim(), courier: move.returned.courier.trim(), tracking: move.returned.tracking.trim() }
        item.history = [...item.history, { status: move.to, by: me.name, at: clockNow(), note: move.note.trim() }]
        log('status', 'lost-item', item.number, `${item.number} ${LOST_STATUS_LABEL[before].toLowerCase()} to ${LOST_STATUS_LABEL[move.to].toLowerCase()}`, { status: before }, { status: move.to })
        return copy(item)
      }),
    settings: () => later(() => copy(s.lostFoundSettings)),
    saveSettings: (settings) =>
      later(() => {
        requireApprove('change the holding period')
        if (!Number.isInteger(settings.holdDays) || settings.holdDays < 7 || settings.holdDays > 365) throw new RuleError('VALIDATION_ERROR', 'Hold items between 7 and 365 days.')
        const before = s.lostFoundSettings.holdDays
        s.lostFoundSettings = { holdDays: settings.holdDays }
        log('update', 'lost-found-settings', 'holding', `Set the lost and found holding period to ${settings.holdDays} days`, { holdDays: before }, { holdDays: settings.holdDays })
        return copy(s.lostFoundSettings)
      }),
  }

  return { port, lostFound, logFind, createGuest, assertBookable, assertCheckInReady }
}
