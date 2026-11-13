import type { IsoDate } from '@/lib/dates'
import { addDays, daysBetween } from '@/lib/dates'
import type { Attachment } from './attachment'
import { RuleError } from './errors'
import type { Employee, LeaveRequest, ShiftAssignment } from './hr'
import type { ExpenseMethod } from './maintenance'
import type { StockLine } from './stock'

/** What a room attendant does in a unit; departure follows a check-out, stayover serves a guest in house. */
export type TaskType = 'departure' | 'stayover' | 'turndown' | 'deep' | 'inspection'
export const TASK_TYPES: readonly TaskType[] = ['departure', 'stayover', 'turndown', 'deep', 'inspection']
export const TASK_TYPE_LABEL: Record<TaskType, string> = { departure: 'Departure clean', stayover: 'Stayover service', turndown: 'Turndown', deep: 'Deep clean', inspection: 'Inspection' }

/** Credits weigh a task against the daily quota; minutes are the standard productivity is measured against. */
export interface TaskStandard {
  credits: number
  minutes: number
}

export interface HousekeepingSettings {
  /** Credits one attendant takes in a day before auto-assign stops giving them rooms. */
  dailyQuota: number
  /** Plan a turndown for every stay in house. */
  turndown: boolean
  standards: Record<TaskType, TaskStandard>
}

export const DEFAULT_HOUSEKEEPING_SETTINGS: HousekeepingSettings = {
  dailyQuota: 8,
  turndown: false,
  standards: {
    departure: { credits: 1, minutes: 45 },
    stayover: { credits: 0.5, minutes: 25 },
    turndown: { credits: 0.25, minutes: 10 },
    deep: { credits: 2, minutes: 120 },
    inspection: { credits: 0.25, minutes: 10 },
  },
}

export function validateHousekeepingSettings(input: HousekeepingSettings): Record<string, string> {
  const errors: Record<string, string> = {}
  if (!(input.dailyQuota >= 1 && input.dailyQuota <= 20)) errors.dailyQuota = 'A daily quota from 1 to 20 credits.'
  for (const type of TASK_TYPES) {
    const s = input.standards[type]
    if (!s || !(s.credits > 0 && s.credits <= 8) || Math.round(s.credits * 4) !== s.credits * 4) errors[`standards.${type}.credits`] = 'Credits in quarters, above 0 and up to 8.'
    if (!s || !Number.isInteger(s.minutes) || s.minutes < 5 || s.minutes > 480) errors[`standards.${type}.minutes`] = 'Whole minutes from 5 to 480.'
  }
  return errors
}

export type TaskStatus = 'pending' | 'in_progress' | 'paused' | 'done' | 'dnd' | 'refused' | 'cancelled'
export const TASK_STATUS_LABEL: Record<TaskStatus, string> = { pending: 'To do', in_progress: 'In progress', paused: 'Paused', done: 'Done', dnd: 'Do not disturb', refused: 'Service refused', cancelled: 'Cancelled' }

export type TaskAction = 'start' | 'pause' | 'resume' | 'done' | 'dnd' | 'refused' | 'cancel'
export const TASK_ACTION_LABEL: Record<TaskAction, string> = { start: 'Start', pause: 'Pause', resume: 'Resume', done: 'Done', dnd: 'Do not disturb', refused: 'Service refused', cancel: 'Cancel' }
const ACTION_FROM: Record<TaskAction, readonly TaskStatus[]> = { start: ['pending'], pause: ['in_progress'], resume: ['paused'], done: ['in_progress', 'paused'], dnd: ['pending'], refused: ['pending'], cancel: ['pending', 'paused'] }
const ACTION_TO: Record<TaskAction, TaskStatus> = { start: 'in_progress', pause: 'paused', resume: 'in_progress', done: 'done', dnd: 'dnd', refused: 'refused', cancel: 'cancelled' }
/** The guest's answer at the door only applies to service in an occupied room. */
const GUEST_ANSWER: readonly TaskType[] = ['stayover', 'turndown']

/** The status moves the task table allows, for the guide's state machine. */
export const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  pending: ['in_progress', 'dnd', 'refused', 'cancelled'],
  in_progress: ['paused', 'done'],
  paused: ['in_progress', 'done', 'cancelled'],
  done: [],
  dnd: [],
  refused: [],
  cancelled: [],
}

export const isOpenTask = (t: Pick<RoomTask, 'status'>) => t.status === 'pending' || t.status === 'in_progress' || t.status === 'paused'
/** Closed for the day: cleaned, or the guest kept the door shut. */
export const isClosedTask = (t: Pick<RoomTask, 'status'>) => !isOpenTask(t) && t.status !== 'cancelled'

export function assertTaskAction(t: Pick<RoomTask, 'status' | 'type' | 'number'>, action: TaskAction): TaskStatus {
  if (!ACTION_FROM[action].includes(t.status)) throw new RuleError('TASK_INVALID_STATE', `${t.number} is ${TASK_STATUS_LABEL[t.status].toLowerCase()}; it cannot ${TASK_ACTION_LABEL[action].toLowerCase()} now.`)
  if ((action === 'dnd' || action === 'refused') && !GUEST_ANSWER.includes(t.type)) throw new RuleError('TASK_INVALID_STATE', `${TASK_TYPE_LABEL[t.type]} has no guest to answer the door.`)
  return ACTION_TO[action]
}

/** What the attendant ticks before a task can be done. */
export const TASK_CHECKLIST: Record<TaskType, readonly string[]> = {
  departure: ['Strip the beds and bag the linen', 'Make the beds with fresh linen', 'Clean the bathroom and replace towels', 'Dust, vacuum and mop', 'Restock amenities and minibar', 'Empty the bins'],
  stayover: ['Make the bed', 'Replace used towels', 'Tidy the bathroom', 'Empty the bins'],
  turndown: ['Turn down the bed', 'Close the curtains', 'Fresh water by the bed'],
  deep: ['Move the furniture and clean behind it', 'Wash the curtains and cushions', 'Descale the bathroom', 'Clean the fans and AC grilles', 'Polish the floors'],
  inspection: ['Bed made, linen fresh', 'Bathroom clean, water hot', 'Minibar stocked and cold', 'Amenities and towels in place', 'No damage or broken fittings'],
}

export interface ChecklistTick {
  item: string
  ok: boolean
}

export interface TaskEvent {
  kind: 'created' | 'assigned' | 'note' | 'issue' | 'lost_found' | TaskAction
  by: string
  /** ISO date-time. */
  at: string
  note: string
}

/** Something found in the room: linked to a lost and found record when one exists, otherwise a note on the task. */
export interface LostFoundNote {
  note: string
  ref: string | null
  by: string
  at: string
}

/** One unit's housekeeping job on one day, worked by one room attendant. */
export interface RoomTask {
  id: string
  number: string
  date: IsoDate
  unitId: string
  villaId: string
  type: TaskType
  /** The stay the task serves: the departing guest, or the one in house. */
  bookingId: string | null
  /** Employee id of the room attendant; null until the supervisor or auto-assign gives it out. */
  attendantId: string | null
  status: TaskStatus
  /** Copied from the settings when the task is planned, so a later change keeps history. */
  credits: number
  standardMinutes: number
  startedAt: string | null
  finishedAt: string | null
  /** Set while the clock runs; a pause banks the minutes into `workedMinutes`. */
  runningSince: string | null
  workedMinutes: number
  checklist: readonly ChecklistTick[]
  workOrderIds: readonly string[]
  lostFound: readonly LostFoundNote[]
  note: string
  history: readonly TaskEvent[]
}

export interface TaskInput {
  unitId: string
  date: string
  type: TaskType
  attendantId: string | null
  note: string
}

const DATE = /^\d{4}-\d{2}-\d{2}$/

export function validateTask(input: TaskInput): Partial<Record<keyof TaskInput, string>> {
  const errors: Partial<Record<keyof TaskInput, string>> = {}
  if (!input.unitId) errors.unitId = 'Pick the unit.'
  if (!DATE.test(input.date)) errors.date = 'Pick the day.'
  if (!TASK_TYPES.includes(input.type)) errors.type = 'Pick the task.'
  return errors
}

/** Whole minutes from one ISO date-time to another, never negative. */
export const minutesBetween = (from: string, to: string) => Math.max(0, Math.round((Date.parse(`${to}Z`) - Date.parse(`${from}Z`)) / 60_000))

/** Minutes worked so far, the running stretch included. */
export const taskMinutes = (t: Pick<RoomTask, 'workedMinutes' | 'runningSince'>, now: string) => t.workedMinutes + (t.runningSince ? minutesBetween(t.runningSince, now) : 0)

export interface PlannedTask {
  unitId: string
  villaId: string
  type: TaskType
  bookingId: string | null
}

interface PlanInput {
  date: IsoDate
  units: ReadonlyArray<{ id: string; villaId: string; status: string }>
  /** Stays that occupy a room: checked in, checked out, or confirmed. */
  stays: ReadonlyArray<{ id: string; unitId: string; checkIn: IsoDate; checkOut: IsoDate }>
  /** Units the board shows dirty without a departure on the day. */
  dirty: ReadonlySet<string>
  turndown: boolean
  /** Tasks already on the day; a unit never gets the same task twice. */
  existing: ReadonlyArray<Pick<RoomTask, 'unitId' | 'type'>>
  /** Days between the unit's stayover cleans, from its property; 0 means none. */
  stayoverEvery: (unitId: string) => number
}

/** A guest in house gets a stayover clean every `every` days after arrival; never on the arrival day, never with 0. */
export const stayoverDue = (every: number, checkIn: IsoDate, date: IsoDate) => every > 0 && date > checkIn && daysBetween(checkIn, date) % every === 0

/** The day's work per unit: a departure clean after each check-out or dirty room, stayover service on the property's schedule, turndown for each stay in house. */
export function planTasks({ date, units, stays, dirty, turndown, existing, stayoverEvery }: PlanInput): PlannedTask[] {
  const planned: PlannedTask[] = []
  const has = (unitId: string, type: TaskType) => existing.some((t) => t.unitId === unitId && t.type === type) || planned.some((t) => t.unitId === unitId && t.type === type)
  for (const u of units) {
    if (u.status === 'inactive') continue
    const leaving = stays.find((b) => b.unitId === u.id && b.checkOut === date)
    const staying = stays.find((b) => b.unitId === u.id && b.checkIn < date && date < b.checkOut)
    if ((leaving || dirty.has(u.id)) && !has(u.id, 'departure')) planned.push({ unitId: u.id, villaId: u.villaId, type: 'departure', bookingId: leaving?.id ?? null })
    if (staying && stayoverDue(stayoverEvery(u.id), staying.checkIn, date) && !has(u.id, 'stayover')) planned.push({ unitId: u.id, villaId: u.villaId, type: 'stayover', bookingId: staying.id })
    if (staying && turndown && !has(u.id, 'turndown')) planned.push({ unitId: u.id, villaId: u.villaId, type: 'turndown', bookingId: staying.id })
  }
  return planned
}

/** A room attendant on shift: the villas they serve (allocations and the roster's villa) and their location. */
export interface Attendant {
  id: string
  name: string
  villaIds: readonly string[]
  shiftId: string
}

const isAttendant = (e: Pick<Employee, 'department' | 'position' | 'status'>) => e.status !== 'inactive' && (e.department === 'housekeeping' || /housekeep|room attendant/i.test(e.position))

/** Housekeeping staff the roster puts on a shift that day, less anyone on approved leave. */
export function attendantsOnShift(employees: readonly Employee[], roster: readonly ShiftAssignment[], leaves: readonly LeaveRequest[], date: IsoDate): Attendant[] {
  return employees.filter(isAttendant).flatMap((e) => {
    const shift = roster.find((a) => a.employeeId === e.id && a.date === date)
    if (!shift?.shiftId) return []
    if (leaves.some((l) => l.employeeId === e.id && l.status === 'approved' && l.from <= date && date <= l.to)) return []
    return [{ id: e.id, name: e.name, villaIds: [...new Set([shift.villaId, ...e.allocations.map((a) => a.villaId)])], shiftId: shift.shiftId }]
  })
}

export interface AssignableTask {
  id: string
  villaId: string
  locationId: string
  unitCode: string
  type: TaskType
  credits: number
}

export interface AttendantLoad {
  id: string
  villaIds: readonly string[]
  locationIds: readonly string[]
  /** Credits already assigned that day. */
  credits: number
}

const TYPE_ORDER: Record<TaskType, number> = { departure: 0, deep: 1, stayover: 2, turndown: 3, inspection: 4 }

/**
 * Auto-assign: villas with the most work go first. A villa's tasks go to the attendant who serves it with the most
 * room under the quota, all of them when they fit, so one person keeps one villa; when they do not, the run carries
 * on with the next attendant with room, in unit order. Attendants of the same location stand in when nobody serves
 * the villa. Nobody passes the quota: what is left stays unassigned for the supervisor.
 */
export function autoAssign(tasks: readonly AssignableTask[], attendants: readonly AttendantLoad[], quota: number): Array<{ taskId: string; attendantId: string }> {
  const load = new Map(attendants.map((a) => [a.id, a.credits]))
  const room = (id: string) => quota - (load.get(id) ?? 0)
  const byVilla = new Map<string, AssignableTask[]>()
  for (const t of tasks) byVilla.set(t.villaId, [...(byVilla.get(t.villaId) ?? []), t])
  const total = (list: readonly AssignableTask[]) => list.reduce((s, t) => s + t.credits, 0)
  const villas = [...byVilla.entries()].sort(([a, x], [b, y]) => total(y) - total(x) || a.localeCompare(b))
  const result: Array<{ taskId: string; attendantId: string }> = []
  for (const [villaId, list] of villas) {
    const sorted = [...list].sort((a, b) => a.unitCode.localeCompare(b.unitCode) || TYPE_ORDER[a.type] - TYPE_ORDER[b.type])
    const serving = attendants.filter((a) => a.villaIds.includes(villaId))
    const locationId = sorted[0]?.locationId ?? ''
    const pool = serving.length ? serving : attendants.filter((a) => a.locationIds.includes(locationId))
    const ranked = () => [...pool].sort((a, b) => room(b.id) - room(a.id) || a.id.localeCompare(b.id))
    const whole = ranked().find((a) => room(a.id) >= total(sorted))
    let current = whole?.id ?? ranked()[0]?.id
    for (const t of sorted) {
      if (!current || room(current) < t.credits) current = ranked().find((a) => room(a.id) >= t.credits)?.id
      if (!current) continue
      load.set(current, (load.get(current) ?? 0) + t.credits)
      result.push({ taskId: t.id, attendantId: current })
    }
  }
  return result
}

/** Credits per attendant on the day, from every task not cancelled. */
export function creditsByAttendant(tasks: ReadonlyArray<Pick<RoomTask, 'attendantId' | 'credits' | 'status'>>): Map<string, number> {
  const out = new Map<string, number>()
  for (const t of tasks) if (t.attendantId && t.status !== 'cancelled') out.set(t.attendantId, (out.get(t.attendantId) ?? 0) + t.credits)
  return out
}

/** Days in a row, up to `today`, that a stay kept the door shut on its stayover service. */
export function dndStreak(tasks: ReadonlyArray<Pick<RoomTask, 'bookingId' | 'type' | 'date' | 'status'>>, bookingId: string, today: IsoDate): number {
  const days = new Map(tasks.filter((t) => t.bookingId === bookingId && t.type === 'stayover' && t.date <= today).map((t) => [t.date, t.status]))
  const latest = [...days.keys()].sort().at(-1)
  let streak = 0
  for (let day = latest; day && days.get(day) === 'dnd'; day = addDays(day, -1)) streak++
  return streak
}
export const DND_ALERT_DAYS = 3

/** Pieces of each linen item one room of a type holds; the par is that many sets per room. */
export interface LinenPar {
  groupId: string
  sets: number
  lines: readonly StockLine[]
}

export function validateLinenPar(input: Pick<LinenPar, 'sets' | 'lines'>): Record<string, string> {
  const errors: Record<string, string> = {}
  if (!Number.isInteger(input.sets) || input.sets < 1 || input.sets > 6) errors.sets = 'Sets from 1 to 6.'
  if (input.lines.some((l) => !l.itemId || !Number.isInteger(l.quantity) || l.quantity < 1)) errors.lines = 'Whole pieces from 1 for each item.'
  else if (new Set(input.lines.map((l) => l.itemId)).size !== input.lines.length) errors.lines = 'Add each item once.'
  return errors
}

/** Soiled linen a villa holds, bagged from departure cleans and waiting for the laundry. */
export interface LinenCount {
  villaId: string
  itemId: string
  quantity: number
}

export type LaundryStatus = 'out' | 'returned'
export const LAUNDRY_STATUS_LABEL: Record<LaundryStatus, string> = { out: 'At laundry', returned: 'Returned' }

export interface LaundryLine {
  itemId: string
  sent: number
  /** Back clean and fit to use. */
  returned: number
  /** Back but past use; written off with the missing pieces. */
  damaged: number
}

export const missingOf = (l: Pick<LaundryLine, 'sent' | 'returned' | 'damaged'>) => Math.max(0, l.sent - l.returned - l.damaged)

/** Soiled linen out with a laundry vendor and back; the vendor's bill is a cash-out through approval. */
export interface LaundryBatch {
  id: string
  number: string
  villaId: string
  vendor: string
  status: LaundryStatus
  sentOn: IsoDate
  returnedOn: IsoDate | null
  lines: readonly LaundryLine[]
  cost: number
  method: ExpenseMethod
  reference: string
  attachments: readonly Attachment[]
  transactionId: string | null
  /** Stock write-offs posted for missing and damaged pieces. */
  writeOffs: readonly string[]
  sentBy: string
  returnedBy: string
  note: string
}

export interface LaundrySendInput {
  villaId: string
  vendor: string
  sentOn: string
  lines: readonly StockLine[]
  note: string
}

export function validateLaundrySend(input: LaundrySendInput): Partial<Record<keyof LaundrySendInput, string>> {
  const errors: Partial<Record<keyof LaundrySendInput, string>> = {}
  if (!input.villaId) errors.villaId = 'Pick the villa.'
  if (input.vendor.trim().length < 2) errors.vendor = 'Name the laundry.'
  if (!DATE.test(input.sentOn)) errors.sentOn = 'Pick the day it left.'
  const lines = input.lines.filter((l) => l.quantity > 0)
  if (lines.length === 0) errors.lines = 'Count at least one item.'
  else if (lines.some((l) => !Number.isInteger(l.quantity))) errors.lines = 'Whole pieces only.'
  return errors
}

export interface LaundryReturnInput {
  returnedOn: string
  lines: ReadonlyArray<Pick<LaundryLine, 'itemId' | 'returned' | 'damaged'>>
  cost: number
  method: ExpenseMethod
  reference: string
  attachments: readonly Attachment[]
}

export function validateLaundryReturn(batch: Pick<LaundryBatch, 'lines' | 'sentOn'>, input: LaundryReturnInput): Partial<Record<keyof LaundryReturnInput, string>> {
  const errors: Partial<Record<keyof LaundryReturnInput, string>> = {}
  if (!DATE.test(input.returnedOn)) errors.returnedOn = 'Pick the day it came back.'
  else if (input.returnedOn < batch.sentOn) errors.returnedOn = 'It came back before it left.'
  for (const l of batch.lines) {
    const back = input.lines.find((x) => x.itemId === l.itemId)
    if (!back || !Number.isInteger(back.returned) || !Number.isInteger(back.damaged) || back.returned < 0 || back.damaged < 0) errors.lines = 'Count what came back, whole pieces.'
    else if (back.returned + back.damaged > l.sent) errors.lines = 'More came back than was sent.'
  }
  if (!Number.isInteger(input.cost) || input.cost < 0) errors.cost = 'Whole rupiah, zero or more.'
  if (input.method !== 'cash' && input.method !== 'bank_transfer') errors.method = 'Pick how the laundry is paid.'
  return errors
}

export interface LinenLevel {
  itemId: string
  /** Pieces dressing the rooms: one set per active unit. */
  inUse: number
  clean: number
  soiled: number
  laundry: number
  discarded: number
  /** What the villa store holds on its books: everything not written off. */
  owned: number
  /** The par: sets per room times the pieces in use. */
  par: number
  /** Pieces the counts cannot place in the store: more is dressing rooms, soiled or out than the villa owns. */
  short: number
}

interface LevelInput {
  itemIds: readonly string[]
  /** Pieces in use per item across the villa's rooms, and the par: those pieces times each room type's sets. */
  inUse: (itemId: string) => number
  par: (itemId: string) => number
  owned: (itemId: string) => number
  soiled: (itemId: string) => number
  laundry: (itemId: string) => number
  discarded: (itemId: string) => number
}

/** Clean in store is what the villa owns less what dresses the rooms, waits soiled and is out at the laundry. */
export function linenLevels({ itemIds, inUse, par, owned, soiled, laundry, discarded }: LevelInput): LinenLevel[] {
  return itemIds.map((itemId) => {
    const free = owned(itemId) - inUse(itemId) - soiled(itemId) - laundry(itemId)
    return { itemId, inUse: inUse(itemId), clean: Math.max(0, free), soiled: soiled(itemId), laundry: laundry(itemId), discarded: discarded(itemId), owned: owned(itemId), par: par(itemId), short: Math.max(0, -free) }
  })
}

/** Owned against the par, as a share; 1 is fully stocked. */
export const parCoverage = (l: Pick<LinenLevel, 'owned' | 'par'>) => (l.par > 0 ? Math.round((l.owned / l.par) * 100) / 100 : 1)
