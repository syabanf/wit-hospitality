import type { Action, Module, User } from '@/domain/access'
import type { Booking } from '@/domain/booking'
import { findById } from '@/domain/errors'
import type { Guest } from '@/domain/guest'
import { TASK_TYPE_LABEL, validateTask, type TaskInput } from '@/domain/housekeeping'
import { validateWorkOrder } from '@/domain/maintenance'
import type { Catalog, Scope } from '@/domain/property'
import {
  COMPENSATION_LIMIT,
  COMPLAINT_CATEGORY_LABEL,
  isOpenComplaint,
  openBoxWarning,
  resolutionHours,
  urgentIncident,
  validateBoxAccess,
  validateCloseBox,
  validateComplaint,
  validateDecision,
  validateIncident,
  validateNote,
  validateSafeBox,
  type BoxAccessInput,
  type BoxRental,
  type CloseBoxInput,
  type Complaint,
  type ComplaintInput,
  type ComplaintStatus,
  type Incident,
  type IncidentInput,
  type OpenBoxInput,
  type ResolveInput,
  type SafeBox,
  type SafeBoxInput,
} from '@/domain/relations'
import { addDays, type IsoDate } from '@/lib/dates'
import type { NewWorkOrder, Ports } from './ports'
import type { BookingView, ReportRow } from './views'

interface Deps {
  ports: Ports
  today: () => IsoDate
  allow: (module: Module, action: Action) => Promise<User>
  access: () => Promise<{ user: User; can: (module: Module, action: Action) => boolean }>
  world: () => Promise<{ cat: Catalog; bookings: Booking[]; guests: Guest[]; views: BookingView[] }>
  check: (errors: Record<string, string | undefined>) => void
}

interface Names {
  villaName: string
  unitCode: string | null
  bookingCode: string | null
}

export interface ComplaintView extends Complaint, Names {
  guestName: string
  /** Whole hours from receipt to resolution; null while open. */
  resolutionHours: number | null
}
export interface IncidentView extends Incident, Names {
  /** High severity, not closed, from the last week: the bell shows it. */
  urgent: boolean
}
export interface RentalView extends BoxRental {
  boxNumber: string
  villaName: string
  guestName: string
  bookingCode: string
}
export interface SafeBoxView extends SafeBox {
  villaName: string
  /** The stay using the box now. */
  rental: RentalView | null
}

/** Complaints, incidents and safe deposit boxes: the guest relations desk. */
export function createRelationsServices({ ports, today, allow, access, world, check }: Deps) {
  const p = ports.relations

  function namer(w: Awaited<ReturnType<typeof world>>) {
    const villaName = (id: string) => w.cat.villas.find((v) => v.id === id)?.name ?? id
    const unitCode = (id: string | null) => (id ? (w.cat.units.find((u) => u.id === id)?.code ?? null) : null)
    const bookingCode = (id: string | null) => (id ? (w.bookings.find((b) => b.id === id)?.code ?? null) : null)
    const guestName = (id: string) => w.guests.find((g) => g.id === id)?.name ?? ''
    const inScope = (villaId: string) => w.cat.villas.some((v) => v.id === villaId)
    return { villaName, unitCode, bookingCode, guestName, inScope }
  }
  type Namer = ReturnType<typeof namer>

  const complaintView = (c: Complaint, n: Namer): ComplaintView => ({ ...c, villaName: n.villaName(c.villaId), unitCode: n.unitCode(c.unitId), bookingCode: n.bookingCode(c.bookingId), guestName: n.guestName(c.guestId), resolutionHours: resolutionHours(c) })
  const incidentView = (i: Incident, n: Namer): IncidentView => ({ ...i, villaName: n.villaName(i.villaId), unitCode: n.unitCode(i.unitId), bookingCode: n.bookingCode(i.bookingId), urgent: urgentIncident(i, addDays(today(), -7)) })
  /** Newest first. */
  const byTime = <T>(at: (x: T) => string) => (a: T, b: T) => at(b).localeCompare(at(a))

  async function complaintWorld() {
    const [w, all, a] = await Promise.all([world(), p.complaints(), access()])
    const n = namer(w)
    const complaints = all.filter((c) => n.inScope(c.villaId)).map((c) => complaintView(c, n)).sort(byTime((c) => c.receivedAt))
    return { w, complaints, a }
  }

  async function incidentWorld() {
    const [w, all, a] = await Promise.all([world(), p.incidents(), access()])
    const n = namer(w)
    const incidents = all.filter((i) => n.inScope(i.villaId)).map((i) => incidentView(i, n)).sort(byTime((i) => i.occurredAt))
    return { w, incidents, a }
  }

  async function boxWorld() {
    const [w, boxes, rentals] = await Promise.all([world(), p.safeBoxes(), p.boxRentals()])
    const n = namer(w)
    const views: RentalView[] = rentals
      .filter((r) => n.inScope(r.villaId))
      .map((r) => ({ ...r, boxNumber: boxes.find((b) => b.id === r.boxId)?.number ?? '', villaName: n.villaName(r.villaId), guestName: n.guestName(r.guestId), bookingCode: n.bookingCode(r.bookingId) ?? '' }))
      .sort(byTime((r) => r.openedAt))
    const boxViews: SafeBoxView[] = boxes
      .filter((b) => n.inScope(b.villaId))
      .map((b) => ({ ...b, villaName: n.villaName(b.villaId), rental: views.find((r) => r.boxId === b.id && r.status === 'open') ?? null }))
      .sort((a, b) => a.villaName.localeCompare(b.villaName) || a.number.localeCompare(b.number, undefined, { numeric: true }))
    return { w, boxes: boxViews, rentals: views }
  }

  /** Stays the forms link to: in house first, then the ones that left lately. */
  const linkable = (views: readonly BookingView[]) =>
    views
      .filter((b) => b.status === 'checked_in' || (b.status === 'checked_out' && (b.checkedOutOn ?? b.checkOut) >= addDays(today(), -30)))
      .sort((a, b) => Number(b.status === 'checked_in') - Number(a.status === 'checked_in') || b.checkIn.localeCompare(a.checkIn))

  const complaints = {
    async list() {
      await allow('guest', 'view')
      const { w, complaints, a } = await complaintWorld()
      return { complaints, catalog: w.cat, guests: w.guests, stays: linkable(w.views), today: today(), limit: COMPENSATION_LIMIT, mayApprove: a.can('guest', 'approve') }
    },
    async detail(id: string) {
      await allow('guest', 'view')
      const { w, complaints, a } = await complaintWorld()
      const complaint = findById(complaints, id, 'complaint')
      return { complaint, catalog: w.cat, guests: w.guests, stays: linkable(w.views), today: today(), limit: COMPENSATION_LIMIT, mayApprove: a.can('guest', 'approve'), booking: w.views.find((b) => b.id === complaint.bookingId) ?? null }
    },
    /** A guest's complaints, or a stay's, newest first. */
    async of(f: { guestId?: string; bookingId?: string }) {
      const { complaints } = await complaintWorld()
      return complaints.filter((c) => (!f.guestId || c.guestId === f.guestId) && (!f.bookingId || c.bookingId === f.bookingId))
    },
    async log(input: ComplaintInput) {
      await allow('guest', 'create')
      check(validateComplaint(input, today()))
      return p.logComplaint(input)
    },
    async update(id: string, input: ComplaintInput) {
      await allow('guest', 'edit')
      check(validateComplaint(input, today()))
      return p.updateComplaint(id, input)
    },
    async note(id: string, note: string) {
      await allow('guest', 'edit')
      check(validateNote(note))
      return p.noteComplaint(id, note)
    },
    async move(id: string, to: Extract<ComplaintStatus, 'in_progress' | 'closed'>, note: string) {
      await allow('guest', 'edit')
      return p.moveComplaint(id, to, note)
    },
    async resolve(id: string, input: ResolveInput) {
      await allow('guest', 'edit')
      return p.resolveComplaint(id, input)
    },
    async decide(id: string, approve: boolean, note: string) {
      await allow('guest', 'approve')
      check(validateDecision({ approve, note }))
      return p.decideCompensation(id, approve, note)
    },
    /** Opens a work order through maintenance's own command and links it on the complaint's timeline. */
    async raiseWorkOrder(id: string, input: NewWorkOrder) {
      await allow('guest', 'edit')
      await allow('maintenance', 'create')
      check(validateWorkOrder(input))
      const wo = await ports.maintenance.createWorkOrder(input)
      return p.noteComplaint(id, `Raised work order ${wo.number}: ${wo.title}`, { kind: 'work_order', id: wo.id, label: wo.number })
    },
    /** Adds a housekeeping task through housekeeping's own command and links it on the timeline. */
    async raiseTask(id: string, input: TaskInput) {
      await allow('guest', 'edit')
      await allow('maintenance', 'edit')
      check(validateTask(input))
      const task = await ports.housekeeping.addTask(input)
      return p.noteComplaint(id, `Asked housekeeping for a ${TASK_TYPE_LABEL[task.type].toLowerCase()} on ${task.date}`, { kind: 'room_task', id: task.id, label: TASK_TYPE_LABEL[task.type] })
    },
  }

  const incidents = {
    async list() {
      await allow('guest', 'view')
      const { w, incidents, a } = await incidentWorld()
      return { incidents, catalog: w.cat, guests: w.guests, stays: linkable(w.views), today: today(), mayApprove: a.can('guest', 'approve') }
    },
    async detail(id: string) {
      await allow('guest', 'view')
      const { w, incidents, a } = await incidentWorld()
      return { incident: findById(incidents, id, 'incident'), catalog: w.cat, guests: w.guests, stays: linkable(w.views), today: today(), mayApprove: a.can('guest', 'approve') }
    },
    async log(input: IncidentInput) {
      await allow('guest', 'create')
      check(validateIncident(input, today()))
      return p.logIncident(input)
    },
    async update(id: string, input: IncidentInput) {
      await allow('guest', 'edit')
      check(validateIncident(input, today()))
      return p.updateIncident(id, input)
    },
    async followUp(id: string, note: string) {
      await allow('guest', 'edit')
      return p.followUpIncident(id, note)
    },
    async charge(id: string, amount: number, reason: string) {
      await allow('guest', 'edit')
      return p.chargeIncident(id, amount, reason)
    },
    async close(id: string, note: string) {
      await allow('guest', 'approve')
      return p.closeIncident(id, note)
    },
    /** New high-severity incidents for the bell, shown to those who sign incidents off. */
    async urgent() {
      const { incidents, a } = await incidentWorld()
      return a.can('guest', 'approve') ? incidents.filter((i) => i.urgent) : []
    },
  }

  const safeBoxes = {
    async list() {
      await allow('guest', 'view')
      const { w, boxes, rentals } = await boxWorld()
      return { boxes, rentals, catalog: w.cat, stays: w.views.filter((b) => b.status === 'checked_in'), today: today() }
    },
    async save(id: string | null, input: SafeBoxInput) {
      await allow('guest', 'edit')
      const { w, boxes } = await boxWorld()
      const villaId = boxes.find((b) => b.id === id)?.villaId ?? input.villaId
      check(validateSafeBox(input, boxes.filter((b) => b.villaId === villaId && b.id !== id), w.cat.villas.find((v) => v.id === villaId)?.name ?? ''))
      return p.saveSafeBox(id, input)
    },
    async open(input: OpenBoxInput) {
      await allow('guest', 'edit')
      return p.openBox(input)
    },
    async access(rental: BoxRental, input: BoxAccessInput) {
      await allow('guest', 'edit')
      check(validateBoxAccess(rental, input))
      return p.accessBox(rental.id, input)
    },
    async close(rental: BoxRental, input: CloseBoxInput) {
      await allow('guest', 'edit')
      check(validateCloseBox(rental, input))
      return p.closeBox(rental.id, input)
    },
    /** A stay's boxes, and the check-out form's warning for each one still open. */
    async ofStay(bookingId: string) {
      const { rentals } = await boxWorld()
      const mine = rentals.filter((r) => r.bookingId === bookingId)
      return { rentals: mine, warnings: mine.filter((r) => r.status === 'open').map((r) => openBoxWarning(r.boxNumber)) }
    },
  }

  /** Complaints by month, villa and category, with how long they took to resolve. */
  async function reportRows(from: IsoDate, to: IsoDate, scope: Scope): Promise<ReportRow[]> {
    const { complaints: all } = await complaintWorld()
    const inRange = all.filter((c) => c.receivedAt.slice(0, 10) >= from && c.receivedAt.slice(0, 10) <= to && (!scope.villaId || c.villaId === scope.villaId) && (!scope.unitId || c.unitId === scope.unitId))
    const groups = new Map<string, ComplaintView[]>()
    for (const c of inRange) {
      const key = `${c.receivedAt.slice(0, 7)}|${c.villaName}|${c.category}`
      groups.set(key, [...(groups.get(key) ?? []), c])
    }
    return [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, list]) => {
        const [month = '', villa = ''] = key.split('|')
        const hours = list.flatMap((c) => (c.resolutionHours === null ? [] : [c.resolutionHours]))
        // One label per row: the report's chart keys its columns by the first column.
        return {
          group: `${month} · ${villa} · ${COMPLAINT_CATEGORY_LABEL[list[0]!.category]}`,
          complaints: list.length,
          open: list.filter((c) => isOpenComplaint(c.status)).length,
          resolved: list.filter((c) => !isOpenComplaint(c.status)).length,
          high: list.filter((c) => c.severity === 'high').length,
          hours: hours.length ? Math.round(hours.reduce((s, h) => s + h, 0) / hours.length) : null,
          credits: list.reduce((s, c) => s + (c.compensation?.status === 'posted' ? c.compensation.amount : 0), 0),
        }
      })
  }

  return { complaints, incidents, safeBoxes, reportRows }
}
