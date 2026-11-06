import type { Attachment } from './attachment'
import { addDays, type IsoDate } from '@/lib/dates'

export type LostStatus = 'found' | 'stored' | 'contacted' | 'returned' | 'disposed' | 'donated'
export const LOST_STATUSES: readonly LostStatus[] = ['found', 'stored', 'contacted', 'returned', 'disposed', 'donated']
export const LOST_STATUS_LABEL: Record<LostStatus, string> = { found: 'Found', stored: 'Stored', contacted: 'Guest contacted', returned: 'Returned', disposed: 'Disposed', donated: 'Donated' }

/** Logged, put away, the owner told, then back to them; unclaimed items leave after the holding period. */
export const LOST_TRANSITIONS: Record<LostStatus, readonly LostStatus[]> = {
  found: ['stored', 'contacted', 'returned'],
  stored: ['contacted', 'returned', 'disposed', 'donated'],
  contacted: ['returned', 'stored', 'disposed', 'donated'],
  returned: [],
  disposed: [],
  donated: [],
}
export const isClosedLost = (s: LostStatus) => LOST_TRANSITIONS[s].length === 0

export type ReturnMethod = 'pickup' | 'courier'
export const RETURN_METHOD_LABEL: Record<ReturnMethod, string> = { pickup: 'Picked up', courier: 'Courier' }

export interface LostReturn {
  method: ReturnMethod
  to: string
  courier: string
  tracking: string
}

export interface LostEvent {
  status: LostStatus
  by: string
  at: string
  note: string
}

export interface LostItem {
  id: string
  number: string
  foundOn: IsoDate
  villaId: string
  unitId: string | null
  /** Where in the villa or room, in the finder's words. */
  where: string
  description: string
  photos: readonly Attachment[]
  foundBy: string
  guestId: string | null
  bookingId: string | null
  /** Shelf or locker it sits in once stored. */
  storage: string
  status: LostStatus
  returned: LostReturn | null
  history: readonly LostEvent[]
}

export interface LostItemInput {
  foundOn: IsoDate
  villaId: string
  unitId: string | null
  where: string
  description: string
  photos: readonly Attachment[]
  guestId: string | null
  bookingId: string | null
  storage: string
}

export interface LostMove {
  to: LostStatus
  note: string
  /** Required when the item goes back to its owner. */
  returned?: LostReturn
}

export interface LostFoundSettings {
  /** Days an unclaimed item is held before it may be disposed of or donated. */
  holdDays: number
}
export const DEFAULT_LOST_FOUND: LostFoundSettings = { holdDays: 90 }

export function validateLostItem(input: LostItemInput, today: IsoDate): Partial<Record<keyof LostItemInput, string>> {
  const errors: Partial<Record<keyof LostItemInput, string>> = {}
  if (!input.villaId) errors.villaId = 'Pick the villa.'
  if (!input.foundOn) errors.foundOn = 'Enter the day it was found.'
  else if (input.foundOn > today) errors.foundOn = 'The day cannot be in the future.'
  if (input.description.trim().length < 3) errors.description = 'Describe the item.'
  if (input.where.trim().length < 2) errors.where = 'Say where it was found.'
  return errors
}

export const holdUntil = (item: Pick<LostItem, 'foundOn'>, settings: LostFoundSettings) => addDays(item.foundOn, settings.holdDays)

export function validateLostMove(item: LostItem, move: LostMove, today: IsoDate, settings: LostFoundSettings): string | null {
  if (!LOST_TRANSITIONS[item.status].includes(move.to)) return `A ${LOST_STATUS_LABEL[item.status].toLowerCase()} item cannot become ${LOST_STATUS_LABEL[move.to].toLowerCase()}.`
  if (move.to === 'returned') {
    const r = move.returned
    if (!r || r.to.trim().length < 2) return 'Say who received the item.'
    if (r.method === 'courier' && (!r.courier.trim() || !r.tracking.trim())) return 'Enter the courier and the tracking number.'
  }
  if ((move.to === 'disposed' || move.to === 'donated') && today < holdUntil(item, settings)) return `Hold the item until ${holdUntil(item, settings)}; the holding period is ${settings.holdDays} days.`
  return null
}
