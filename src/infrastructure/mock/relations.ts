import type { RelationsPort } from '@/application/ports'
import { can, type AuditAction, type User } from '@/domain/access'
import type { Booking } from '@/domain/booking'
import { findById, RuleError } from '@/domain/errors'
import {
  assertComplaintMove,
  assertComplaintOpen,
  assertIncidentOpen,
  assertPending,
  boxStatusAfter,
  closeRental,
  COMPENSATION_LIMIT,
  COMPLAINT_CATEGORY_LABEL,
  COMPLAINT_STATUS_LABEL,
  creditDescription,
  decideCompensation,
  INCIDENT_KIND_LABEL,
  moveComplaint,
  resolveComplaint,
  signatureData,
  validateBoxAccess,
  validateCloseBox,
  validateComplaint,
  validateDecision,
  validateIncident,
  validateIncidentCharge,
  validateNote,
  validateOpenBox,
  validateResolve,
  validateSafeBox,
  validateStayComplaint,
  type Complaint,
  type ComplaintInput,
  type FolioRequest,
  type Incident,
  type IncidentInput,
  type StayComplaintInput,
} from '@/domain/relations'
import type { MockState } from './state'

export interface RelationsDeps {
  s: MockState
  later: <T>(value: () => T) => Promise<T>
  atomically: <T>(change: () => T) => T
  today: () => string
  clockNow: () => string
  user: () => User
  seq: (key: string) => number
  refuse: (errors: Record<string, string | undefined>) => void
  log: (action: AuditAction, entity: string, entityId: string, summary: string, before?: Record<string, unknown> | null, after?: Record<string, unknown> | null, actor?: User) => void
  /** Posts the money on the stay's folio as billing does from guest's event. */
  postToFolio: (request: FolioRequest, actor: User) => void
  guestActor: User
}

const pad = (n: number) => String(n).padStart(3, '0')

/** Complaints, incidents and safe deposit boxes for the mock API, with the API's codes and wording. */
export function createRelationsAdapter(d: RelationsDeps) {
  const { s, later, atomically, today, clockNow, user, seq, refuse, log } = d
  const copy = <T>(v: T): T => structuredClone(v)
  const villaOf = (id: string) => s.catalog().villa(id)
  const stayOf = (id: string) => findById(s.bookings, id, 'booking')
  const villaOfStay = (b: Booking) => s.catalog().unit(b.unitId).villaId
  const mayApprove = (me: User) => can(s.permissions, me.role, 'guest', 'approve')
  const requireApprove = (me: User, what: string) => {
    if (!mayApprove(me)) throw new RuleError('FORBIDDEN', `Only someone who may approve in the guest module can ${what}.`)
  }
  const inHouse = (b: Booking) => {
    if (b.status !== 'checked_in') throw new RuleError('BOOKING_INVALID_STATE', `${b.code} is not in house; post to the folio during the stay.`)
  }
  /** Minutes, as the forms send them; the timeline keeps seconds like the API's stamp. */
  const now = () => clockNow()

  /** The stay wins the villa and unit; without one the unit must be in the villa. */
  function place(villaId: string, unitId: string | null, bookingId: string | null) {
    if (bookingId) {
      const b = stayOf(bookingId)
      return { villaId: villaOfStay(b), unitId: b.unitId as string | null, stay: b }
    }
    villaOf(villaId)
    if (unitId) {
      const unit = s.catalog().unit(unitId)
      if (unit.villaId !== villaId) throw new RuleError('VALIDATION_ERROR', `${unit.code} is not in that villa.`)
    }
    return { villaId, unitId: unitId || null, stay: null }
  }

  function cleanComplaint(input: ComplaintInput) {
    const p = place(input.villaId, input.unitId, input.bookingId)
    let guestId = input.guestId
    if (p.stay) {
      if (guestId && guestId !== p.stay.guestId) throw new RuleError('VALIDATION_ERROR', `${p.stay.code} is booked by another guest.`)
      guestId = p.stay.guestId
    }
    const guest = findById(s.guests, guestId ?? '', 'guest')
    const fields = { villaId: p.villaId, unitId: p.unitId, bookingId: input.bookingId || null, guestId: guest.id, category: input.category, severity: input.severity, description: input.description.trim(), receivedBy: input.receivedBy.trim(), receivedAt: input.receivedAt, owner: input.owner.trim() }
    return { fields, guest }
  }

  function newComplaint(input: ComplaintInput, source: Complaint['source'], me: User) {
    const { fields, guest } = cleanComplaint(input)
    const n = seq('complaint')
    const c: Complaint = { ...fields, id: `cpl-${n}`, number: `CP-${pad(n)}`, source, status: 'open', resolution: null, compensation: null, links: [], timeline: [{ at: now(), by: me.name, kind: 'logged', note: '', ref: null }] }
    s.complaints.push(c)
    return { c, guest }
  }

  const complaintOf = (id: string) => findById(s.complaints, id, 'complaint')
  const incidentOf = (id: string) => findById(s.incidents, id, 'incident')

  function cleanIncident(input: IncidentInput) {
    const p = place(input.villaId, input.unitId, input.bookingId)
    return {
      ...input,
      villaId: p.villaId,
      unitId: p.unitId,
      bookingId: input.bookingId || null,
      area: input.area.trim(),
      people: input.people.map((x) => ({ kind: x.kind, name: x.name.trim(), guestId: x.guestId || null, note: x.note.trim() })),
      description: input.description.trim(),
      actions: input.actions.trim(),
      policeReport: input.policeReport.trim(),
      attachments: [...input.attachments],
    }
  }

  /** The stay page's complaint, filed open by "Guest"; reservation's action writes the audit line. */
  function fileFromStay(b: Booking, input: StayComplaintInput) {
    refuse(validateStayComplaint(input))
    const stamp = now()
    const { c } = newComplaint({ villaId: '', unitId: null, bookingId: b.id, guestId: null, category: input.category, severity: 'medium', description: input.description, receivedBy: 'Guest', receivedAt: stamp.slice(0, 16), owner: 'Front desk' }, 'stay_page', d.guestActor)
    return c.number
  }

  const port: RelationsPort = {
    complaints: () => later(() => copy(s.complaints)),
    logComplaint: (input) =>
      later(() => {
        refuse(validateComplaint(input, today()))
        const me = user()
        const { c, guest } = newComplaint(input, 'desk', me)
        log('create', 'complaint', c.number, `Logged complaint ${c.number} from ${guest.name} at ${villaOf(c.villaId).name}: ${COMPLAINT_CATEGORY_LABEL[c.category]}`)
        return copy(c)
      }),
    updateComplaint: (id, input) =>
      later(() => {
        refuse(validateComplaint(input, today()))
        const c = complaintOf(id)
        assertComplaintOpen(c)
        Object.assign(c, cleanComplaint(input).fields)
        log('update', 'complaint', c.number, `Edited ${c.number}`)
        return copy(c)
      }),
    noteComplaint: (id, note, ref) =>
      later(() => {
        const c = complaintOf(id)
        assertComplaintOpen(c)
        refuse(validateNote(note))
        if (ref) c.links.push({ ...ref })
        c.timeline.push({ at: now(), by: user().name, kind: ref ? 'link' : 'note', note: note.trim(), ref: ref ? { ...ref } : null })
        log('update', 'complaint', c.number, `Noted on ${c.number}`)
        return copy(c)
      }),
    moveComplaint: (id, to, note) =>
      later(() => {
        const c = complaintOf(id)
        assertComplaintMove(c, to)
        const before = c.status
        moveComplaint(c, to, note, user().name, now())
        log('status', 'complaint', c.number, `${c.number} ${COMPLAINT_STATUS_LABEL[before].toLowerCase()} to ${COMPLAINT_STATUS_LABEL[to].toLowerCase()}`, { status: before }, { status: to })
        return copy(c)
      }),
    resolveComplaint: (id, input) =>
      later(() =>
        atomically(() => {
          const me = user()
          const c = complaintOf(id)
          refuse(validateResolve(c, input))
          const before = c.status
          let post = false
          const k = input.compensation
          if (k?.kind === 'folio_credit') {
            inHouse(stayOf(c.bookingId!))
            post = k.amount <= COMPENSATION_LIMIT || mayApprove(me)
          }
          if (resolveComplaint(c, input, post, me.name, now())) d.postToFolio({ sourceId: `complaint:${c.id}`, bookingId: c.bookingId!, kind: 'credit', amount: c.compensation!.amount, description: creditDescription(c) }, me)
          log('status', 'complaint', c.number, `Resolved ${c.number}: ${c.resolution!.action}`, { status: before }, { status: 'resolved' })
          return copy(c)
        }),
      ),
    decideCompensation: (id, approve, note) =>
      later(() =>
        atomically(() => {
          const me = user()
          const c = complaintOf(id)
          assertPending(c)
          requireApprove(me, 'approve compensation')
          refuse(validateDecision({ approve, note }))
          if (approve) {
            inHouse(stayOf(c.bookingId!))
            d.postToFolio({ sourceId: `complaint:${c.id}`, bookingId: c.bookingId!, kind: 'credit', amount: c.compensation!.amount, description: creditDescription(c) }, me)
          }
          decideCompensation(c, { approve, note }, me.name, now())
          log('approve', 'complaint', c.number, `${approve ? 'Approved' : 'Refused'} the credit of ${c.compensation!.amount} on ${c.number}`)
          return copy(c)
        }),
      ),

    incidents: () => later(() => copy(s.incidents)),
    logIncident: (input) =>
      later(() => {
        refuse(validateIncident(input, today()))
        const me = user()
        const n = seq('incident')
        const i: Incident = { ...cleanIncident(input), id: `inc-${n}`, number: `IN-${pad(n)}`, reportedBy: me.name, status: 'open', timeline: [{ at: now(), by: me.name, kind: 'logged', note: '' }], charge: null, signOff: null }
        s.incidents.push(i)
        log('create', 'incident', i.number, `Logged incident ${i.number} at ${villaOf(i.villaId).name}: ${INCIDENT_KIND_LABEL[i.kind]}`)
        return copy(i)
      }),
    updateIncident: (id, input) =>
      later(() => {
        const i = incidentOf(id)
        assertIncidentOpen(i)
        refuse(validateIncident(input, today()))
        Object.assign(i, cleanIncident(input))
        log('update', 'incident', i.number, `Edited ${i.number}`)
        return copy(i)
      }),
    followUpIncident: (id, note) =>
      later(() => {
        const i = incidentOf(id)
        assertIncidentOpen(i)
        if (note.trim().length < 3) refuse({ note: 'Write the follow-up.' })
        if (i.status === 'open') i.status = 'follow_up'
        i.timeline.push({ at: now(), by: user().name, kind: 'follow_up', note: note.trim() })
        log('update', 'incident', i.number, `Followed up ${i.number}`)
        return copy(i)
      }),
    chargeIncident: (id, amount, reason) =>
      later(() =>
        atomically(() => {
          const me = user()
          const i = incidentOf(id)
          const charged = i.charge ? stayOf(i.charge.bookingId).code : ''
          refuse(validateIncidentCharge(i, { amount, reason }, charged))
          const b = stayOf(i.bookingId!)
          inHouse(b)
          const at = now()
          d.postToFolio({ sourceId: `incident:${i.id}`, bookingId: b.id, kind: 'charge', amount, description: `Damage, ${i.number}: ${reason.trim()}` }, me)
          i.charge = { amount, reason: reason.trim(), bookingId: b.id, by: me.name, at }
          i.timeline.push({ at, by: me.name, kind: 'charge', note: `Charged ${amount} to ${b.code}: ${reason.trim()}` })
          log('create', 'incident', i.number, `Charged damage of ${amount} on ${b.code} for ${i.number}`)
          return copy(i)
        }),
      ),
    closeIncident: (id, note) =>
      later(() => {
        const me = user()
        const i = incidentOf(id)
        assertIncidentOpen(i)
        requireApprove(me, 'sign off an incident')
        if (note.trim().length < 3) refuse({ note: 'Write the closing note.' })
        const before = i.status
        const at = now()
        i.status = 'closed'
        i.signOff = { by: me.name, at, note: note.trim() }
        i.timeline.push({ at, by: me.name, kind: 'closed', note: note.trim() })
        log('status', 'incident', i.number, `Signed off ${i.number}`, { status: before }, { status: 'closed' })
        return copy(i)
      }),

    safeBoxes: () => later(() => copy(s.safeBoxes)),
    saveSafeBox: (id, input) =>
      later(() => {
        const box = id ? findById(s.safeBoxes, id, 'safe box') : null
        const villaId = box?.villaId ?? input.villaId
        const villa = villaOf(villaId)
        refuse(validateSafeBox(input, s.safeBoxes.filter((b) => b.villaId === villaId && b.id !== id), villa.name))
        if (box) {
          box.status = boxStatusAfter(box, input.outOfOrder)
          Object.assign(box, { number: input.number.trim(), size: input.size, note: input.note.trim() })
          log('update', 'safe-box', box.id, `Changed safe box ${box.number} at ${villa.name}`)
          return copy(box)
        }
        const created = { id: `box-${seq('safeBox')}`, villaId, number: input.number.trim(), size: input.size, status: input.outOfOrder ? ('out_of_order' as const) : ('free' as const), note: input.note.trim() }
        s.safeBoxes.push(created)
        log('create', 'safe-box', created.id, `Added safe box ${created.number} at ${villa.name}`)
        return copy(created)
      }),
    boxRentals: () => later(() => copy(s.boxRentals)),
    openBox: (input) =>
      later(() => {
        const me = user()
        const box = findById(s.safeBoxes, input.boxId, 'safe box')
        const b = stayOf(input.bookingId)
        refuse(validateOpenBox(box, { code: b.code, status: b.status, villaId: villaOfStay(b) }, input))
        const n = seq('boxRental')
        const at = now()
        const r = { id: `bxr-${n}`, number: `SB-${pad(n)}`, boxId: box.id, villaId: box.villaId, bookingId: b.id, guestId: b.guestId, items: input.items.trim(), keyNumber: input.keyNumber.trim(), status: 'open' as const, openedAt: at, openedBy: me.name, closedAt: null, closedBy: null, keyReturned: null, keyFee: 0, log: [{ kind: 'open' as const, at, by: me.name, signature: input.signature, signatureData: signatureData(input), note: '' }] }
        box.status = 'in_use'
        s.boxRentals.push(r)
        log('update', 'safe-box-rental', r.number, `Opened box ${box.number} for ${b.code} (${r.number})`)
        return copy(r)
      }),
    accessBox: (id, input) =>
      later(() => {
        const me = user()
        const r = findById(s.boxRentals, id, 'box rental')
        refuse(validateBoxAccess(r, input))
        r.log.push({ kind: input.kind, at: now(), by: me.name, signature: input.signature, signatureData: signatureData(input), note: input.note.trim() })
        const box = findById(s.safeBoxes, r.boxId, 'safe box')
        log('update', 'safe-box-rental', r.number, `Box ${box.number} for ${stayOf(r.bookingId).code}: ${input.kind === 'take' ? 'took items out' : 'added items'}`)
        return copy(r)
      }),
    closeBox: (id, input) =>
      later(() =>
        atomically(() => {
          const me = user()
          const r = findById(s.boxRentals, id, 'box rental')
          refuse(validateCloseBox(r, input))
          const box = findById(s.safeBoxes, r.boxId, 'safe box')
          const b = stayOf(r.bookingId)
          if (input.keyFee > 0) {
            inHouse(b)
            d.postToFolio({ sourceId: `box-rental:${r.id}`, bookingId: b.id, kind: 'charge', amount: input.keyFee, description: `Lost safe box key, box ${box.number} (${r.number})` }, me)
          }
          closeRental(r, input, me.name, now())
          if (box.status === 'in_use') box.status = 'free'
          log('update', 'safe-box-rental', r.number, `Closed box ${box.number} for ${b.code}: ${input.keyReturned ? 'key returned' : 'key lost'}`)
          return copy(r)
        }),
      ),
  }

  return { port, fileFromStay }
}
