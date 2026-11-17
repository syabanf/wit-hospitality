import type { Attachment } from './attachment'
import { MAX_ATTACHMENTS } from './attachment'
import { RuleError } from './errors'

/**
 * Guest relations: complaints, incidents and safe deposit boxes. The codes and wording match
 * api/internal/guest/domain/relations.go; api/docs/contracts/guest-relations-contract.md explains them.
 */

/** A folio credit above this waits for someone who may approve in the guest module. */
export const COMPENSATION_LIMIT = 500_000
/** A drawn signature's PNG data URL stays under this many characters. */
export const MAX_SIGNATURE_DATA = 200_000

export type Severity = 'low' | 'medium' | 'high'
export const SEVERITIES: readonly Severity[] = ['low', 'medium', 'high']
export const SEVERITY_LABEL: Record<Severity, string> = { low: 'Low', medium: 'Medium', high: 'High' }

export type ComplaintCategory = 'room' | 'cleanliness' | 'noise' | 'service' | 'food' | 'billing' | 'staff' | 'facility' | 'other'
export const COMPLAINT_CATEGORIES: readonly ComplaintCategory[] = ['room', 'cleanliness', 'noise', 'service', 'food', 'billing', 'staff', 'facility', 'other']
export const COMPLAINT_CATEGORY_LABEL: Record<ComplaintCategory, string> = { room: 'Room', cleanliness: 'Cleanliness', noise: 'Noise', service: 'Service', food: 'Food and drinks', billing: 'Billing', staff: 'Staff', facility: 'Facilities', other: 'Other' }

export type ComplaintStatus = 'open' | 'in_progress' | 'resolved' | 'closed'
export const COMPLAINT_STATUSES: readonly ComplaintStatus[] = ['open', 'in_progress', 'resolved', 'closed']
export const COMPLAINT_STATUS_LABEL: Record<ComplaintStatus, string> = { open: 'Open', in_progress: 'In progress', resolved: 'Resolved', closed: 'Closed' }
/** Resolving has its own step; back to in progress from resolved reopens the complaint. */
export const COMPLAINT_TRANSITIONS: Record<ComplaintStatus, readonly ComplaintStatus[]> = { open: ['in_progress', 'resolved'], in_progress: ['resolved'], resolved: ['closed', 'in_progress'], closed: [] }
export const isOpenComplaint = (s: ComplaintStatus) => s === 'open' || s === 'in_progress'

export type CompensationKind = 'folio_credit' | 'free_service' | 'goodwill'
export const COMPENSATION_KINDS: readonly CompensationKind[] = ['folio_credit', 'free_service', 'goodwill']
export const COMPENSATION_KIND_LABEL: Record<CompensationKind, string> = { folio_credit: 'Folio credit', free_service: 'Free service', goodwill: 'Goodwill gesture' }
export type CompensationStatus = 'pending_approval' | 'posted' | 'rejected' | 'given'
export const COMPENSATION_STATUS_LABEL: Record<CompensationStatus, string> = { pending_approval: 'Waits for approval', posted: 'Posted to the folio', rejected: 'Refused', given: 'Given' }

export interface ComplaintLink {
  kind: 'work_order' | 'room_task'
  id: string
  label: string
}

export interface ComplaintEntry {
  at: string
  by: string
  kind: 'logged' | 'note' | 'status' | 'resolved' | 'compensation' | 'link'
  note: string
  ref: ComplaintLink | null
}

export interface Compensation {
  kind: CompensationKind
  /** Folio credit only; 0 otherwise. */
  amount: number
  description: string
  status: CompensationStatus
  decidedBy: string | null
  decidedAt: string | null
}

export interface Complaint {
  id: string
  number: string
  villaId: string
  unitId: string | null
  bookingId: string | null
  guestId: string
  category: ComplaintCategory
  severity: Severity
  /** What the guest said. */
  description: string
  receivedBy: string
  /** `YYYY-MM-DDTHH:MM`. */
  receivedAt: string
  /** Who follows it up. */
  owner: string
  source: 'desk' | 'stay_page'
  status: ComplaintStatus
  resolution: { action: string; by: string; at: string } | null
  compensation: Compensation | null
  links: ComplaintLink[]
  timeline: ComplaintEntry[]
}

export interface ComplaintInput {
  villaId: string
  unitId: string | null
  bookingId: string | null
  guestId: string | null
  category: ComplaintCategory
  severity: Severity
  description: string
  receivedBy: string
  receivedAt: string
  owner: string
}

export interface CompensationInput {
  kind: CompensationKind
  amount: number
  description: string
}

export interface ResolveInput {
  action: string
  compensation: CompensationInput | null
}

/** What the guest types on the stay page. */
export interface StayComplaintInput {
  category: ComplaintCategory
  description: string
}

type Errors = Record<string, string>
const short = (s: string, n: number) => s.trim().length < n
const MINUTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/

function minute(errors: Errors, field: string, value: string, missing: string, today: string) {
  if (!MINUTE.test(value)) errors[field] = missing
  else if (value.slice(0, 10) > today) errors[field] = 'The time cannot be in the future.'
}

export function validateComplaint(input: ComplaintInput, today: string): Errors {
  const errors: Errors = {}
  if (!input.villaId) errors.villaId = 'Pick the villa.'
  if (!input.guestId && !input.bookingId) errors.guestId = 'Pick the guest or the stay.'
  if (!COMPLAINT_CATEGORIES.includes(input.category)) errors.category = 'Pick the category.'
  if (!SEVERITIES.includes(input.severity)) errors.severity = 'Pick the severity.'
  if (short(input.description, 5)) errors.description = 'Write what the guest said.'
  if (short(input.receivedBy, 2)) errors.receivedBy = 'Say who received it.'
  minute(errors, 'receivedAt', input.receivedAt, 'Enter when it was received.', today)
  if (short(input.owner, 2)) errors.owner = 'Name who follows it up.'
  return errors
}

export function validateStayComplaint(input: StayComplaintInput): Errors {
  const errors: Errors = {}
  if (!COMPLAINT_CATEGORIES.includes(input.category)) errors.category = 'Pick what it is about.'
  if (short(input.description, 5)) errors.description = 'Tell us what went wrong.'
  return errors
}

const complaintRefused = (message: string) => new RuleError('COMPLAINT_INVALID_STATE', message)

export function assertComplaintOpen(c: Pick<Complaint, 'number' | 'status'>) {
  if (c.status === 'closed') throw complaintRefused(`${c.number} is closed.`)
}

const cannotBecome = (c: Pick<Complaint, 'number' | 'status'>, to: string) => complaintRefused(`${c.number} is ${COMPLAINT_STATUS_LABEL[c.status].toLowerCase()}; it cannot become ${(COMPLAINT_STATUS_LABEL[to as ComplaintStatus] ?? to).toLowerCase()}.`)

/** A move to in progress or closed along the transitions; resolving has its own step. */
export function assertComplaintMove(c: Pick<Complaint, 'number' | 'status'>, to: ComplaintStatus) {
  if ((to !== 'in_progress' && to !== 'closed') || !COMPLAINT_TRANSITIONS[c.status].includes(to)) throw cannotBecome(c, to)
}

/** The moves the console offers on a complaint. */
export const complaintMoves = (s: ComplaintStatus) => COMPLAINT_TRANSITIONS[s].filter((t) => t !== 'resolved')

export function moveComplaint(c: Complaint, to: ComplaintStatus, note: string, by: string, at: string) {
  const from = c.status
  c.status = to
  if (from === 'resolved' && to === 'in_progress') {
    c.resolution = null
    if (c.compensation?.status === 'pending_approval') Object.assign(c.compensation, { status: 'rejected', decidedBy: by, decidedAt: at })
  }
  const text = `${COMPLAINT_STATUS_LABEL[from]} to ${COMPLAINT_STATUS_LABEL[to].toLowerCase()}${note.trim() ? `: ${note.trim()}` : ''}`
  c.timeline.push({ at, by, kind: 'status', note: text, ref: null })
}

export const validateNote = (note: string): Errors => (short(note, 2) ? { note: 'Write the note.' } : {})

/** Checks the state, then the fields, then that a credit has a stay; refusals throw, field errors return. */
export function validateResolve(c: Pick<Complaint, 'number' | 'status' | 'bookingId'>, input: ResolveInput): Errors {
  if (c.status !== 'open' && c.status !== 'in_progress') throw cannotBecome(c, 'resolved')
  const errors: Errors = {}
  if (short(input.action, 3)) errors.action = 'Say what was done.'
  const k = input.compensation
  if (k) {
    if (!COMPENSATION_KINDS.includes(k.kind)) errors['compensation.kind'] = 'Pick the compensation.'
    if (k.kind === 'folio_credit' && !(Number.isInteger(k.amount) && k.amount > 0)) errors['compensation.amount'] = 'Enter the credit in whole rupiah.'
    if (short(k.description, 3)) errors['compensation.description'] = 'Say what the guest gets.'
  }
  if (Object.keys(errors).length) return errors
  if (k?.kind === 'folio_credit' && !c.bookingId) throw new RuleError('COMPENSATION_NO_STAY', "A folio credit needs the guest's stay; link the stay first.")
  return errors
}

/** Records the resolution; a credit posts at once when `post`, else waits. Answers whether the folio posting goes out. */
export function resolveComplaint(c: Complaint, input: ResolveInput, post: boolean, by: string, at: string): boolean {
  c.status = 'resolved'
  c.resolution = { action: input.action.trim(), by, at }
  c.timeline.push({ at, by, kind: 'resolved', note: c.resolution.action, ref: null })
  const k = input.compensation
  if (!k) return false
  const comp: Compensation = { kind: k.kind, amount: 0, description: k.description.trim(), status: 'given', decidedBy: null, decidedAt: null }
  let note = `${COMPENSATION_KIND_LABEL[k.kind]}: ${comp.description}`
  if (k.kind === 'folio_credit') {
    comp.amount = k.amount
    if (post) {
      Object.assign(comp, { status: 'posted', decidedBy: by, decidedAt: at })
      note = `Credit of ${k.amount} posted to the folio`
    } else {
      comp.status = 'pending_approval'
      note = `Credit of ${k.amount} waits for a manager's approval`
    }
  }
  c.compensation = comp
  c.timeline.push({ at, by, kind: 'compensation', note, ref: null })
  return comp.status === 'posted'
}

export function assertPending(c: Pick<Complaint, 'number' | 'compensation'>) {
  if (c.compensation?.status !== 'pending_approval') throw new RuleError('COMPENSATION_INVALID_STATE', `There is no compensation waiting for approval on ${c.number}.`)
}

export const validateDecision = (d: { approve: boolean; note: string }): Errors => (!d.approve && short(d.note, 3) ? { note: 'Say why the credit is refused.' } : {})

export function decideCompensation(c: Complaint, d: { approve: boolean; note: string }, by: string, at: string) {
  const k = c.compensation!
  Object.assign(k, { status: d.approve ? 'posted' : 'rejected', decidedBy: by, decidedAt: at })
  const note = (d.approve ? `Credit of ${k.amount} approved and posted to the folio` : `Credit of ${k.amount} refused`) + (d.note.trim() ? `: ${d.note.trim()}` : '')
  c.timeline.push({ at, by, kind: 'compensation', note, ref: null })
}

export const creditDescription = (c: Pick<Complaint, 'number' | 'compensation'>) => `Compensation for ${c.number}: ${c.compensation?.description ?? ''}`

/** Whole hours from receipt to resolution, or null while it is not resolved. */
export function resolutionHours(c: Pick<Complaint, 'receivedAt' | 'resolution'>): number | null {
  if (!c.resolution) return null
  const ms = Date.parse(c.resolution.at.slice(0, 16)) - Date.parse(c.receivedAt)
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms / 3_600_000)) : null
}

/* Incidents */

export type IncidentKind = 'accident' | 'theft' | 'damage' | 'security' | 'medical' | 'fire' | 'other'
export const INCIDENT_KINDS: readonly IncidentKind[] = ['accident', 'theft', 'damage', 'security', 'medical', 'fire', 'other']
export const INCIDENT_KIND_LABEL: Record<IncidentKind, string> = { accident: 'Accident or injury', theft: 'Theft or loss', damage: 'Damage to property', security: 'Security', medical: 'Medical', fire: 'Fire or safety', other: 'Other' }
export type IncidentStatus = 'open' | 'follow_up' | 'closed'
export const INCIDENT_STATUSES: readonly IncidentStatus[] = ['open', 'follow_up', 'closed']
export const INCIDENT_STATUS_LABEL: Record<IncidentStatus, string> = { open: 'Open', follow_up: 'Follow-up', closed: 'Closed' }
export type PersonKind = 'guest' | 'staff' | 'outsider'
export const PERSON_KINDS: readonly PersonKind[] = ['guest', 'staff', 'outsider']
export const PERSON_KIND_LABEL: Record<PersonKind, string> = { guest: 'Guest', staff: 'Staff', outsider: 'Outsider' }

export interface IncidentPerson {
  kind: PersonKind
  name: string
  guestId: string | null
  note: string
}

export interface IncidentEntry {
  at: string
  by: string
  kind: 'logged' | 'follow_up' | 'charge' | 'closed'
  note: string
}

export interface Incident {
  id: string
  number: string
  kind: IncidentKind
  severity: Severity
  villaId: string
  unitId: string | null
  area: string
  occurredAt: string
  bookingId: string | null
  people: IncidentPerson[]
  description: string
  actions: string
  policeCalled: boolean
  doctorCalled: boolean
  policeReport: string
  attachments: Attachment[]
  reportedBy: string
  status: IncidentStatus
  timeline: IncidentEntry[]
  charge: { amount: number; reason: string; bookingId: string; by: string; at: string } | null
  signOff: { by: string; at: string; note: string } | null
}

export type IncidentInput = Pick<Incident, 'kind' | 'severity' | 'villaId' | 'unitId' | 'area' | 'occurredAt' | 'bookingId' | 'people' | 'description' | 'actions' | 'policeCalled' | 'doctorCalled' | 'policeReport' | 'attachments'>

export function validateIncident(input: IncidentInput, today: string): Errors {
  const errors: Errors = {}
  if (!INCIDENT_KINDS.includes(input.kind)) errors.kind = 'Pick the kind of incident.'
  if (!SEVERITIES.includes(input.severity)) errors.severity = 'Pick the severity.'
  if (!input.villaId) errors.villaId = 'Pick the villa.'
  minute(errors, 'occurredAt', input.occurredAt, 'Enter when it happened.', today)
  if (!input.unitId && !input.bookingId && short(input.area, 2)) errors.area = 'Say where it happened.'
  if (short(input.description, 5)) errors.description = 'Describe what happened.'
  input.people.forEach((p, i) => {
    if (short(p.name, 2)) errors[`people.${i}.name`] = 'Name the person.'
    if (!PERSON_KINDS.includes(p.kind)) errors[`people.${i}.kind`] = 'Pick who they are.'
  })
  if (input.attachments.length > MAX_ATTACHMENTS) errors.attachments = 'Attach at most 10 files.'
  return errors
}

export function assertIncidentOpen(i: Pick<Incident, 'number' | 'status'>) {
  if (i.status === 'closed') throw new RuleError('INCIDENT_INVALID_STATE', `${i.number} is closed.`)
}

/** Refusals throw; the amount and reason come back as field errors. */
export function validateIncidentCharge(i: Pick<Incident, 'number' | 'status' | 'kind' | 'bookingId' | 'charge'>, input: { amount: number; reason: string }, bookingCode: string): Errors {
  assertIncidentOpen(i)
  if (i.kind !== 'damage') throw new RuleError('INCIDENT_CHARGE_KIND', 'Only damage to property is charged to a guest.')
  if (!i.bookingId) throw new RuleError('INCIDENT_NO_STAY', "Link the guest's stay before charging the damage.")
  if (i.charge) throw new RuleError('INCIDENT_ALREADY_CHARGED', `${i.number} is already charged to ${bookingCode}.`)
  const errors: Errors = {}
  if (!(Number.isInteger(input.amount) && input.amount > 0)) errors.amount = 'Enter the charge in whole rupiah.'
  if (short(input.reason, 3)) errors.reason = 'Say what was damaged.'
  return errors
}

/** High severity, not closed, logged within the last week: the bell shows it to managers. */
export const urgentIncident = (i: Pick<Incident, 'severity' | 'status' | 'occurredAt'>, weekAgo: string) => i.severity === 'high' && i.status !== 'closed' && i.occurredAt.slice(0, 10) >= weekAgo

/* Safe deposit boxes */

export type SafeBoxSize = 'small' | 'medium' | 'large'
export const SAFE_BOX_SIZES: readonly SafeBoxSize[] = ['small', 'medium', 'large']
export const SAFE_BOX_SIZE_LABEL: Record<SafeBoxSize, string> = { small: 'Small', medium: 'Medium', large: 'Large' }
export type SafeBoxStatus = 'free' | 'in_use' | 'out_of_order'
export const SAFE_BOX_STATUS_LABEL: Record<SafeBoxStatus, string> = { free: 'Free', in_use: 'In use', out_of_order: 'Out of order' }

export interface SafeBox {
  id: string
  villaId: string
  number: string
  size: SafeBoxSize
  status: SafeBoxStatus
  note: string
}

export interface SafeBoxInput {
  villaId: string
  number: string
  size: SafeBoxSize
  note: string
  outOfOrder: boolean
}

export type Signature = 'drawn' | 'paper' | 'none'
export const SIGNATURE_LABEL: Record<Signature, string> = { drawn: 'Signed', paper: 'Signed on paper', none: 'No signature' }
export type BoxEntryKind = 'open' | 'add' | 'take' | 'close' | 'key_lost'
export const BOX_ENTRY_LABEL: Record<BoxEntryKind, string> = { open: 'Opened, key handed', add: 'Added items', take: 'Took items out', close: 'Closed', key_lost: 'Key lost' }

export interface BoxEntry {
  kind: BoxEntryKind
  at: string
  by: string
  signature: Signature
  signatureData: string
  note: string
}

export interface BoxRental {
  id: string
  number: string
  boxId: string
  villaId: string
  bookingId: string
  guestId: string
  items: string
  keyNumber: string
  status: 'open' | 'closed'
  openedAt: string
  openedBy: string
  closedAt: string | null
  closedBy: string | null
  keyReturned: boolean | null
  keyFee: number
  log: BoxEntry[]
}

export interface Signed {
  signature: 'drawn' | 'paper'
  /** PNG data URL of the drawn mark, "" when signed on paper. */
  signatureData: string
}
export interface OpenBoxInput extends Signed {
  boxId: string
  bookingId: string
  items: string
  keyNumber: string
}
export interface BoxAccessInput extends Signed {
  kind: 'add' | 'take'
  note: string
}
export interface CloseBoxInput extends Signed {
  keyReturned: boolean
  keyFee: number
  note: string
}

export function validateSafeBox(input: SafeBoxInput, others: readonly SafeBox[], villaName: string): Errors {
  const errors: Errors = {}
  const number = input.number.trim()
  if (!number || number.length > 8) errors.number = 'Number the box.'
  else if (others.some((b) => b.number.toLowerCase() === number.toLowerCase())) errors.number = `Box ${number} is already at ${villaName}.`
  if (!SAFE_BOX_SIZES.includes(input.size)) errors.size = 'Pick the size.'
  return errors
}

/** The status a box takes from its input; a box in use cannot go out of order. */
export function boxStatusAfter(box: Pick<SafeBox, 'number' | 'status'>, outOfOrder: boolean): SafeBoxStatus {
  if (outOfOrder && box.status === 'in_use') throw new RuleError('SAFE_BOX_IN_USE', `Box ${box.number} is in use; close it first.`)
  return outOfOrder ? 'out_of_order' : box.status === 'in_use' ? 'in_use' : 'free'
}

function checkSigned(errors: Errors, s: Signed) {
  const ok = s.signature === 'paper' || (s.signature === 'drawn' && s.signatureData !== '' && s.signatureData.length <= MAX_SIGNATURE_DATA)
  if (!ok) errors.signature = 'Have the guest sign, or mark it signed on paper.'
}
export const signatureData = (s: Signed) => (s.signature === 'drawn' ? s.signatureData : '')

export function validateOpenBox(box: Pick<SafeBox, 'number' | 'status' | 'villaId'>, stay: { code: string; status: string; villaId: string }, input: OpenBoxInput): Errors {
  if (box.status !== 'free') throw new RuleError('SAFE_BOX_UNAVAILABLE', `Box ${box.number} is ${SAFE_BOX_STATUS_LABEL[box.status].toLowerCase()}.`)
  if (stay.status !== 'checked_in') throw new RuleError('BOOKING_INVALID_STATE', `${stay.code} is not in house; open a box during the stay.`)
  const errors: Errors = {}
  if (stay.villaId !== box.villaId) errors.bookingId = `${stay.code} stays at another villa.`
  if (!input.keyNumber.trim()) errors.keyNumber = 'Enter the key handed to the guest.'
  checkSigned(errors, input)
  return errors
}

export function assertBoxOpen(r: Pick<BoxRental, 'number' | 'status'>) {
  if (r.status !== 'open') throw new RuleError('SAFE_BOX_CLOSED', `${r.number} is closed.`)
}

export function validateBoxAccess(r: Pick<BoxRental, 'number' | 'status'>, input: BoxAccessInput): Errors {
  assertBoxOpen(r)
  const errors: Errors = {}
  if (input.kind !== 'add' && input.kind !== 'take') errors.kind = 'Pick what the guest did.'
  checkSigned(errors, input)
  return errors
}

export function validateCloseBox(r: Pick<BoxRental, 'number' | 'status'>, input: CloseBoxInput): Errors {
  assertBoxOpen(r)
  const errors: Errors = {}
  if (!Number.isInteger(input.keyFee) || input.keyFee < 0) errors.keyFee = 'Enter the key fee in whole rupiah, or zero.'
  else if (input.keyFee > 0 && input.keyReturned) errors.keyFee = 'Charge a fee only for a lost key.'
  checkSigned(errors, input)
  return errors
}

export function closeRental(r: BoxRental, input: CloseBoxInput, by: string, at: string) {
  if (!input.keyReturned) r.log.push({ kind: 'key_lost', at, by, signature: 'none', signatureData: '', note: '' })
  r.log.push({ kind: 'close', at, by, signature: input.signature, signatureData: signatureData(input), note: input.note.trim() })
  Object.assign(r, { status: 'closed', closedAt: at, closedBy: by, keyReturned: input.keyReturned, keyFee: input.keyFee })
}

/** The check-out form's warning for a box still open on the stay. */
export const openBoxWarning = (boxNumber: string) => `Safe box ${boxNumber} is still open for this stay; close it and take back the key.`

/** Money guest relations sends to the folio; billing posts it once per source. */
export interface FolioRequest {
  sourceId: string
  bookingId: string
  kind: 'credit' | 'charge'
  amount: number
  description: string
}
