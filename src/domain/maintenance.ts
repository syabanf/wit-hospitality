import { addDays, addMonths, daysBetween, withinRange, type IsoDate } from '@/lib/dates'

export type MaintenanceCategory = 'ac' | 'plumbing' | 'electrical' | 'pool' | 'appliance' | 'structure' | 'garden' | 'pest' | 'other'
export const MAINTENANCE_CATEGORIES: readonly MaintenanceCategory[] = ['ac', 'plumbing', 'electrical', 'pool', 'appliance', 'structure', 'garden', 'pest', 'other']
export const MAINTENANCE_CATEGORY_LABEL: Record<MaintenanceCategory, string> = {
  ac: 'Air conditioning',
  plumbing: 'Plumbing',
  electrical: 'Electrical',
  pool: 'Pool',
  appliance: 'Appliance',
  structure: 'Building',
  garden: 'Garden',
  pest: 'Pest control',
  other: 'Other',
}

export type WorkOrderPriority = 'low' | 'normal' | 'high' | 'urgent'
export const WORK_ORDER_PRIORITIES: readonly WorkOrderPriority[] = ['low', 'normal', 'high', 'urgent']
export const PRIORITY_LABEL: Record<WorkOrderPriority, string> = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' }

export type WorkOrderStatus = 'open' | 'scheduled' | 'in_progress' | 'on_hold' | 'done' | 'verified' | 'cancelled'
export const WORK_ORDER_STATUSES: readonly WorkOrderStatus[] = ['open', 'scheduled', 'in_progress', 'on_hold', 'done', 'verified', 'cancelled']
export const WORK_ORDER_STATUS_LABEL: Record<WorkOrderStatus, string> = {
  open: 'Open',
  scheduled: 'Scheduled',
  in_progress: 'In progress',
  on_hold: 'On hold',
  done: 'Done',
  verified: 'Verified',
  cancelled: 'Cancelled',
}

export const WORK_ORDER_TRANSITIONS: Record<WorkOrderStatus, readonly WorkOrderStatus[]> = {
  open: ['scheduled', 'in_progress', 'cancelled'],
  scheduled: ['in_progress', 'on_hold', 'cancelled'],
  in_progress: ['done', 'on_hold', 'cancelled'],
  on_hold: ['in_progress', 'cancelled'],
  done: ['verified', 'in_progress'],
  verified: [],
  cancelled: [],
}

export const WORK_ORDER_ACTION_LABEL: Record<Exclude<WorkOrderStatus, 'open'>, string> = {
  scheduled: 'Schedule',
  in_progress: 'Start work',
  on_hold: 'Put on hold',
  done: 'Mark done',
  verified: 'Verify',
  cancelled: 'Cancel',
}

export const canTransitionWorkOrder = (w: Pick<WorkOrder, 'status'>, to: WorkOrderStatus) => WORK_ORDER_TRANSITIONS[w.status].includes(to)
/** Statuses still holding the unit or the team: anything not closed. */
export const isOpenWorkOrder = (w: Pick<WorkOrder, 'status'>) => w.status !== 'done' && w.status !== 'verified' && w.status !== 'cancelled'
export const isClosedWorkOrder = (w: Pick<WorkOrder, 'status'>) => w.status === 'done' || w.status === 'verified'

export interface Part {
  name: string
  qty: number
  unitCost: number
}

export type WorkOrderSource = 'manual' | 'preventive' | 'inspection'
export const WORK_ORDER_SOURCE_LABEL: Record<WorkOrderSource, string> = { manual: 'Reported', preventive: 'Preventive plan', inspection: 'Inspection' }

export interface WorkOrderEvent {
  kind: 'created' | 'note' | 'blocked' | 'unblocked' | 'cost' | WorkOrderStatus
  by: string
  on: IsoDate
  note: string
}

/** A repair or service job on a unit, or on a villa's shared equipment when `unitId` is null. */
export interface WorkOrder {
  id: string
  number: string
  villaId: string
  unitId: string | null
  assetId: string | null
  planId: string | null
  source: WorkOrderSource
  category: MaintenanceCategory
  priority: WorkOrderPriority
  title: string
  description: string
  reportedBy: string
  /** Employee id of the technician, or null when a vendor does the job. */
  assigneeId: string | null
  vendorId: string | null
  status: WorkOrderStatus
  createdOn: IsoDate
  scheduledOn: IsoDate | null
  startedOn: IsoDate | null
  finishedOn: IsoDate | null
  verifiedOn: IsoDate | null
  beforePhotos: readonly string[]
  afterPhotos: readonly string[]
  parts: readonly Part[]
  labourCost: number
  vendorCost: number
  /** The maintenance block this job holds on the unit, if any. */
  blockId: string | null
  /** The cash-out entry the cost was recorded as. */
  transactionId: string | null
  history: readonly WorkOrderEvent[]
}

export interface WorkOrderInput {
  villaId: string
  unitId: string | null
  assetId: string | null
  category: MaintenanceCategory
  priority: WorkOrderPriority
  title: string
  description: string
  assigneeId: string | null
  vendorId: string | null
  scheduledOn: string | null
  parts: readonly Part[]
  labourCost: number
  vendorCost: number
  beforePhotos: readonly string[]
  afterPhotos: readonly string[]
}

const DATE = /^\d{4}-\d{2}-\d{2}$/

export function validateWorkOrder(input: WorkOrderInput): Record<string, string> {
  const errors: Record<string, string> = {}
  if (!input.villaId) errors.villaId = 'Pick the villa.'
  if (!MAINTENANCE_CATEGORIES.includes(input.category)) errors.category = 'Pick the category.'
  if (!WORK_ORDER_PRIORITIES.includes(input.priority)) errors.priority = 'Pick the priority.'
  if (input.title.trim().length < 4) errors.title = 'Say what needs fixing.'
  if (input.scheduledOn && !DATE.test(input.scheduledOn)) errors.scheduledOn = 'Pick the date.'
  if (!Number.isInteger(input.labourCost) || input.labourCost < 0) errors.labourCost = 'Whole rupiah, zero or more.'
  if (!Number.isInteger(input.vendorCost) || input.vendorCost < 0) errors.vendorCost = 'Whole rupiah, zero or more.'
  input.parts.forEach((p, i) => {
    if (p.name.trim().length < 2) errors[`parts.${i}.name`] = 'Name the part.'
    if (!Number.isInteger(p.qty) || p.qty < 1) errors[`parts.${i}.qty`] = 'At least one.'
    if (!Number.isInteger(p.unitCost) || p.unitCost < 0) errors[`parts.${i}.unitCost`] = 'Whole rupiah.'
  })
  return errors
}

export const partsCost = (w: Pick<WorkOrder, 'parts'>) => w.parts.reduce((s, p) => s + p.qty * p.unitCost, 0)
export const workOrderCost = (w: Pick<WorkOrder, 'parts' | 'labourCost' | 'vendorCost'>) => partsCost(w) + w.labourCost + w.vendorCost
/** Days from report to finish, for closed jobs. */
export const resolutionDays = (w: Pick<WorkOrder, 'createdOn' | 'finishedOn'>) => (w.finishedOn ? Math.max(0, daysBetween(w.createdOn, w.finishedOn)) : null)

/** Lifecycle for the record page; a cancelled job ends after its last real step. */
export function workOrderSteps(w: WorkOrder, fmt: (iso: IsoDate) => string) {
  const order: WorkOrderStatus[] = ['open', 'scheduled', 'in_progress', 'done', 'verified']
  const dates: Partial<Record<WorkOrderStatus, IsoDate | null>> = { open: w.createdOn, scheduled: w.scheduledOn, in_progress: w.startedOn, done: w.finishedOn, verified: w.verifiedOn }
  const position = w.status === 'on_hold' ? 2 : w.status === 'cancelled' ? -1 : order.indexOf(w.status)
  const steps = order.map((s, i) => {
    const when = dates[s]
    const state: 'done' | 'current' | 'upcoming' | 'late' = i < position ? 'done' : i === position ? (w.status === 'on_hold' ? 'late' : 'current') : 'upcoming'
    return { id: s, label: s === 'in_progress' && w.status === 'on_hold' ? 'On hold' : WORK_ORDER_STATUS_LABEL[s], hint: when ? fmt(when) : undefined, state }
  })
  if (w.status === 'cancelled') return [...steps.filter((s) => dates[s.id as WorkOrderStatus]).map((s) => ({ ...s, state: 'done' as const })), { id: 'cancelled', label: 'Cancelled', hint: undefined, state: 'late' as const }]
  return steps
}

export interface WorkOrderFilter {
  status?: WorkOrderStatus | 'all' | 'active'
  priority?: WorkOrderPriority | ''
  category?: MaintenanceCategory | ''
  villaId?: string
  unitId?: string
  locationId?: string
  assigneeId?: string
  vendorId?: string
  query?: string
  from?: string
  to?: string
}

export function filterWorkOrders<T extends WorkOrder & { locationId: string; unitCode: string; assigneeName: string; vendorName: string }>(list: readonly T[], f: WorkOrderFilter): T[] {
  const q = (f.query ?? '').trim().toLowerCase()
  return list.filter((w) => {
    if (f.status === 'active' && !isOpenWorkOrder(w)) return false
    if (f.status && f.status !== 'all' && f.status !== 'active' && w.status !== f.status) return false
    if (f.priority && w.priority !== f.priority) return false
    if (f.category && w.category !== f.category) return false
    if (f.unitId && w.unitId !== f.unitId) return false
    if (f.villaId && w.villaId !== f.villaId) return false
    if (f.locationId && w.locationId !== f.locationId) return false
    if (f.assigneeId && w.assigneeId !== f.assigneeId) return false
    if (f.vendorId && w.vendorId !== f.vendorId) return false
    if (!withinRange(w.createdOn, f.from, f.to)) return false
    if (q && ![w.number, w.title, w.description, w.unitCode, w.assigneeName, w.vendorName].some((v) => v.toLowerCase().includes(q))) return false
    return true
  })
}

/** Most urgent first, then the oldest open job; closed jobs newest first. */
export function sortWorkOrders<T extends WorkOrder>(list: readonly T[]): T[] {
  const rank: Record<WorkOrderPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 }
  return [...list].sort((a, b) => {
    const openA = isOpenWorkOrder(a) ? 0 : 1
    const openB = isOpenWorkOrder(b) ? 0 : 1
    if (openA !== openB) return openA - openB
    if (openA === 0) return rank[a.priority] - rank[b.priority] || a.createdOn.localeCompare(b.createdOn)
    return (b.finishedOn ?? b.createdOn).localeCompare(a.finishedOn ?? a.createdOn)
  })
}

export type AssetStatus = 'in_service' | 'under_repair' | 'retired'
export const ASSET_STATUSES: readonly AssetStatus[] = ['in_service', 'under_repair', 'retired']
export const ASSET_STATUS_LABEL: Record<AssetStatus, string> = { in_service: 'In service', under_repair: 'Under repair', retired: 'Retired' }

/** Equipment in a unit, or shared by a villa when `unitId` is null. */
export interface Asset {
  id: string
  code: string
  name: string
  category: MaintenanceCategory
  villaId: string
  unitId: string | null
  brand: string
  model: string
  serial: string
  purchasedOn: IsoDate | null
  purchaseCost: number
  warrantyUntil: IsoDate | null
  status: AssetStatus
  notes: string
}

export type AssetInput = Omit<Asset, 'id'>

export function validateAsset(input: AssetInput, assets: readonly Asset[], excludeId?: string): Record<string, string> {
  const errors: Record<string, string> = {}
  if (!/^[A-Z0-9-]{3,24}$/.test(input.code)) errors.code = 'Capital letters, digits and dashes, 3 to 24 long.'
  else if (assets.some((a) => a.code === input.code && a.id !== excludeId)) errors.code = `${input.code} is already used.`
  if (input.name.trim().length < 2) errors.name = 'Name the asset.'
  if (!input.villaId) errors.villaId = 'Pick the villa.'
  if (!MAINTENANCE_CATEGORIES.includes(input.category)) errors.category = 'Pick the category.'
  if (input.purchasedOn && !DATE.test(input.purchasedOn)) errors.purchasedOn = 'Pick the date.'
  if (input.warrantyUntil && !DATE.test(input.warrantyUntil)) errors.warrantyUntil = 'Pick the date.'
  if (input.purchasedOn && input.warrantyUntil && input.warrantyUntil < input.purchasedOn) errors.warrantyUntil = 'The warranty ends before the purchase.'
  if (!Number.isInteger(input.purchaseCost) || input.purchaseCost < 0) errors.purchaseCost = 'Whole rupiah, zero or more.'
  return errors
}

export const underWarranty = (a: Pick<Asset, 'warrantyUntil'>, today: IsoDate) => Boolean(a.warrantyUntil && a.warrantyUntil >= today)

export interface Vendor {
  id: string
  name: string
  trade: MaintenanceCategory
  contact: string
  phone: string
  email: string
  rateNote: string
  active: boolean
}

export type VendorInput = Omit<Vendor, 'id'>

export function validateVendor(input: VendorInput, vendors: readonly Vendor[], excludeId?: string): Record<string, string> {
  const errors: Record<string, string> = {}
  if (input.name.trim().length < 2) errors.name = 'Enter the vendor name.'
  else if (vendors.some((v) => v.name.toLowerCase() === input.name.trim().toLowerCase() && v.id !== excludeId)) errors.name = `${input.name.trim()} already exists.`
  if (!MAINTENANCE_CATEGORIES.includes(input.trade)) errors.trade = 'Pick the trade.'
  if (input.phone && !/^\+?[\d\s-]{7,}$/.test(input.phone)) errors.phone = 'Enter a phone number with the country code.'
  if (input.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) errors.email = 'Enter a valid email address.'
  return errors
}

export type IntervalUnit = 'days' | 'months'

/** A recurring job: the console opens a work order when it falls due. */
export interface PreventivePlan {
  id: string
  title: string
  category: MaintenanceCategory
  villaId: string
  unitId: string | null
  assetId: string | null
  every: number
  unit: IntervalUnit
  nextDue: IsoDate
  lastDoneOn: IsoDate | null
  checklist: readonly string[]
  assigneeId: string | null
  vendorId: string | null
  estimatedCost: number
  active: boolean
}

export type PlanInput = Omit<PreventivePlan, 'id' | 'lastDoneOn'>

export function validatePlan(input: PlanInput): Record<string, string> {
  const errors: Record<string, string> = {}
  if (input.title.trim().length < 4) errors.title = 'Name the job.'
  if (!input.villaId) errors.villaId = 'Pick the villa.'
  if (!MAINTENANCE_CATEGORIES.includes(input.category)) errors.category = 'Pick the category.'
  if (!Number.isInteger(input.every) || input.every < 1) errors.every = 'At least 1.'
  else if (input.unit === 'days' && input.every > 365) errors.every = 'At most 365 days; use months.'
  else if (input.unit === 'months' && input.every > 24) errors.every = 'At most 24 months.'
  if (!DATE.test(input.nextDue)) errors.nextDue = 'Pick the next due date.'
  if (!Number.isInteger(input.estimatedCost) || input.estimatedCost < 0) errors.estimatedCost = 'Whole rupiah, zero or more.'
  if (input.checklist.some((c) => c.trim().length < 2)) errors.checklist = 'Each checklist line needs text.'
  return errors
}

/** The next due date after a job finished on `from`. */
export const advanceDue = (plan: Pick<PreventivePlan, 'every' | 'unit'>, from: IsoDate) => (plan.unit === 'days' ? addDays(from, plan.every) : addMonths(from, plan.every))

export type PlanState = 'overdue' | 'due' | 'later' | 'paused'
export const PLAN_STATE_LABEL: Record<PlanState, string> = { overdue: 'Overdue', due: 'Due soon', later: 'Scheduled', paused: 'Paused' }

export function planState(plan: Pick<PreventivePlan, 'nextDue' | 'active'>, today: IsoDate, horizonDays = 7): PlanState {
  if (!plan.active) return 'paused'
  if (plan.nextDue < today) return 'overdue'
  if (plan.nextDue <= addDays(today, horizonDays)) return 'due'
  return 'later'
}

export const intervalLabel = (plan: Pick<PreventivePlan, 'every' | 'unit'>) => `Every ${plan.every} ${plan.unit === 'days' ? (plan.every === 1 ? 'day' : 'days') : plan.every === 1 ? 'month' : 'months'}`

export type HousekeepingState = 'dirty' | 'cleaning' | 'inspected' | 'ready' | 'out_of_order'
export const HOUSEKEEPING_STATES: readonly HousekeepingState[] = ['dirty', 'cleaning', 'inspected', 'ready', 'out_of_order']
export const HOUSEKEEPING_LABEL: Record<HousekeepingState, string> = { dirty: 'Dirty', cleaning: 'Cleaning', inspected: 'Inspected', ready: 'Ready', out_of_order: 'Out of order' }

/** Forward moves on the board; a failed inspection sends the room back to dirty. */
export const HOUSEKEEPING_TRANSITIONS: Record<HousekeepingState, readonly HousekeepingState[]> = {
  dirty: ['cleaning'],
  cleaning: ['inspected', 'dirty'],
  inspected: ['ready', 'dirty'],
  ready: ['dirty'],
  out_of_order: ['dirty'],
}
export const canMoveHousekeeping = (from: HousekeepingState, to: HousekeepingState) => HOUSEKEEPING_TRANSITIONS[from].includes(to)
export const nextHousekeeping = (state: HousekeepingState): HousekeepingState | null => (state === 'dirty' ? 'cleaning' : state === 'cleaning' ? 'inspected' : state === 'inspected' ? 'ready' : null)
export const HOUSEKEEPING_ACTION: Partial<Record<HousekeepingState, string>> = { cleaning: 'Start cleaning', inspected: 'Inspect', ready: 'Release' }

export type InspectionItem = 'bed' | 'bathroom' | 'minibar' | 'amenities' | 'damage'
export const INSPECTION_ITEMS: readonly InspectionItem[] = ['bed', 'bathroom', 'minibar', 'amenities', 'damage']
export const INSPECTION_LABEL: Record<InspectionItem, string> = { bed: 'Bed made, linen fresh', bathroom: 'Bathroom clean, water hot', minibar: 'Minibar stocked and cold', amenities: 'Amenities and towels in place', damage: 'No damage or broken fittings' }
/** The trade a failed check item goes to when it raises a work order. */
export const INSPECTION_CATEGORY: Record<InspectionItem, MaintenanceCategory> = { bed: 'other', bathroom: 'plumbing', minibar: 'appliance', amenities: 'other', damage: 'structure' }

export interface InspectionResult {
  item: InspectionItem
  ok: boolean
}

/** Where a unit stands for the next guest. */
export interface HousekeepingRecord {
  unitId: string
  state: HousekeepingState
  updatedOn: IsoDate
  updatedBy: string
  note: string
  lastInspection: { on: IsoDate; by: string; results: readonly InspectionResult[] } | null
}

/** Out of order wins while an open job blocks the unit; a unit without a record is ready. */
export function effectiveHousekeeping(record: HousekeepingRecord | undefined, blockedByWork: boolean, inactive: boolean): HousekeepingState {
  if (inactive || blockedByWork) return 'out_of_order'
  return record?.state ?? 'ready'
}
