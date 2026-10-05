import { withinRange, type IsoDate } from '@/lib/dates'

export type ServiceKind = 'cleaning' | 'towels' | 'maintenance' | 'minibar' | 'laundry' | 'transfer' | 'other'
export const SERVICE_KINDS: readonly ServiceKind[] = ['cleaning', 'towels', 'maintenance', 'minibar', 'laundry', 'transfer', 'other']
export const SERVICE_KIND_LABEL: Record<ServiceKind, string> = {
  cleaning: 'Room cleaning',
  towels: 'Towels and amenities',
  maintenance: 'Maintenance',
  minibar: 'Minibar refill',
  laundry: 'Laundry',
  transfer: 'Airport transfer',
  other: 'Other',
}

export type ServiceStatus = 'open' | 'in_progress' | 'done' | 'cancelled'
export const SERVICE_STATUSES: readonly ServiceStatus[] = ['open', 'in_progress', 'done', 'cancelled']
export const SERVICE_STATUS_LABEL: Record<ServiceStatus, string> = { open: 'Open', in_progress: 'In progress', done: 'Done', cancelled: 'Cancelled' }

export type ServicePriority = 'normal' | 'urgent'

/** A guest or housekeeping request against one unit, optionally tied to the stay. */
export interface ServiceRequest {
  id: string
  number: string
  unitId: string
  bookingId: string | null
  kind: ServiceKind
  priority: ServicePriority
  note: string
  /** Rupiah the guest pays for it; zero when included in the stay. */
  charge: number
  status: ServiceStatus
  assignee: string
  requestedOn: IsoDate
  /** Minutes since midnight, for ordering the day. */
  requestedAt: number
  doneOn: IsoDate | null
  /** Set when the charge was recorded in the cashbox. */
  transactionId: string | null
}

export interface ServiceRequestInput {
  unitId: string
  bookingId: string | null
  kind: ServiceKind
  priority: ServicePriority
  note: string
  charge: number
}

export const canEditRequest = (r: Pick<ServiceRequest, 'status'>) => r.status === 'open' || r.status === 'in_progress'

export const SERVICE_TRANSITIONS: Record<ServiceStatus, readonly ServiceStatus[]> = {
  open: ['in_progress', 'done', 'cancelled'],
  in_progress: ['done', 'cancelled'],
  done: [],
  cancelled: [],
}

export const canTransitionService = (r: Pick<ServiceRequest, 'status'>, to: ServiceStatus) => SERVICE_TRANSITIONS[r.status].includes(to)
export const nextServiceStep = (r: Pick<ServiceRequest, 'status'>): 'in_progress' | 'done' | null =>
  r.status === 'open' ? 'in_progress' : r.status === 'in_progress' ? 'done' : null
export const SERVICE_ACTION_LABEL: Record<Exclude<ServiceStatus, 'open'>, string> = { in_progress: 'Start', done: 'Mark done', cancelled: 'Cancel request' }

export function validateServiceRequest(input: ServiceRequestInput): Partial<Record<keyof ServiceRequestInput, string>> {
  const errors: Partial<Record<keyof ServiceRequestInput, string>> = {}
  if (!input.unitId) errors.unitId = 'Pick the unit.'
  if (!SERVICE_KINDS.includes(input.kind)) errors.kind = 'Pick what the guest needs.'
  if (!Number.isInteger(input.charge) || input.charge < 0) errors.charge = 'Enter the charge in whole rupiah, or zero.'
  if (input.kind === 'other' && input.note.trim().length < 3) errors.note = 'Say what is needed.'
  return errors
}

export interface ServiceFilter {
  status?: ServiceStatus | 'all'
  kind?: ServiceKind | 'all'
  unitId?: string
  query?: string
  from?: string
  to?: string
}

export function filterRequests<T extends ServiceRequest & { unitCode: string; guestName: string | null }>(list: readonly T[], f: ServiceFilter): T[] {
  const q = (f.query ?? '').trim().toLowerCase()
  return list.filter((r) => {
    if (f.status && f.status !== 'all' && r.status !== f.status) return false
    if (f.kind && f.kind !== 'all' && r.kind !== f.kind) return false
    if (f.unitId && r.unitId !== f.unitId) return false
    if (!withinRange(r.requestedOn, f.from, f.to)) return false
    if (q && ![r.number, r.unitCode, r.guestName ?? '', r.note, r.assignee, SERVICE_KIND_LABEL[r.kind]].some((v) => v.toLowerCase().includes(q))) return false
    return true
  })
}

/** Live work first, urgent before normal, then the oldest request. */
export function sortRequests<T extends ServiceRequest>(list: readonly T[]): T[] {
  const rank: Record<ServiceStatus, number> = { in_progress: 0, open: 1, done: 2, cancelled: 3 }
  return [...list].sort(
    (a, b) =>
      rank[a.status] - rank[b.status] ||
      (a.priority === 'urgent' ? 0 : 1) - (b.priority === 'urgent' ? 0 : 1) ||
      (a.status === 'done' || a.status === 'cancelled' ? b.requestedOn.localeCompare(a.requestedOn) || b.requestedAt - a.requestedAt : a.requestedOn.localeCompare(b.requestedOn) || a.requestedAt - b.requestedAt),
  )
}

export const clockLabel = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
