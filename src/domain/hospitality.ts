import { RuleError } from './errors'
import type { Employee } from './hr'
import type { Operation, UnitKind } from './property'
import type { ServiceKind } from './roomService'

/**
 * The hospitality layer of the contract: a host for each villa stay, the guest's preferences before arrival,
 * the service window housekeeping keeps to, and late check-out. Every rule keys on the unit kind.
 */

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/
/** "HH:MM", or empty when not set. */
const clockOrEmpty = (t: string) => t === '' || CLOCK.test(t)

// Guest preferences

export type Setup = 'bbq' | 'floating_breakfast' | 'private_chef' | 'romantic_dinner' | 'airport_pickup' | 'baby_cot'
export const SETUPS: readonly Setup[] = ['bbq', 'floating_breakfast', 'private_chef', 'romantic_dinner', 'airport_pickup', 'baby_cot']
export const SETUP_LABEL: Record<Setup, string> = {
  bbq: 'Barbecue',
  floating_breakfast: 'Floating breakfast',
  private_chef: 'Private chef',
  romantic_dinner: 'Romantic dinner',
  airport_pickup: 'Airport pickup',
  baby_cot: 'Baby cot',
}
/** Setups that cost money: each becomes a service request to the host, never a charge on its own. */
export const PAID_SETUPS: readonly Setup[] = ['bbq', 'floating_breakfast', 'private_chef', 'romantic_dinner', 'airport_pickup']
/** The service request a paid setup opens. */
export const SETUP_SERVICE_KIND: Record<Setup, ServiceKind> = { bbq: 'other', floating_breakfast: 'other', private_chef: 'other', romantic_dinner: 'other', airport_pickup: 'transfer', baby_cot: 'other' }

export interface GuestPreferences {
  breakfastTime: string
  dietary: string
  setups: readonly Setup[]
  arrivalTime: string
  notes: string
}
export const EMPTY_PREFERENCES: GuestPreferences = { breakfastTime: '', dietary: '', setups: [], arrivalTime: '', notes: '' }
const MAX_DIETARY = 200
const MAX_PREFERENCE_NOTES = 1000

/** A room-kind stay keeps only the arrival time and notes; a villa stay keeps the full set. */
export function preferencesFor(kind: UnitKind, p: GuestPreferences): GuestPreferences {
  const kept = { ...p, dietary: p.dietary.trim(), notes: p.notes.trim(), setups: SETUPS.filter((s) => p.setups.includes(s)) }
  return kind === 'villa' ? kept : { ...EMPTY_PREFERENCES, arrivalTime: kept.arrivalTime, notes: kept.notes }
}

export function validatePreferences(p: GuestPreferences): Partial<Record<keyof GuestPreferences, string>> {
  const errors: Partial<Record<keyof GuestPreferences, string>> = {}
  if (!clockOrEmpty(p.breakfastTime)) errors.breakfastTime = 'A time of day, for example 08:00, or leave it empty.'
  if (!clockOrEmpty(p.arrivalTime)) errors.arrivalTime = 'A time of day, for example 15:30, or leave it empty.'
  if (p.dietary.trim().length > MAX_DIETARY) errors.dietary = `At most ${MAX_DIETARY} characters.`
  if (p.notes.trim().length > MAX_PREFERENCE_NOTES) errors.notes = `At most ${MAX_PREFERENCE_NOTES} characters.`
  if (p.setups.some((s) => !SETUPS.includes(s))) errors.setups = 'Pick setups from the list.'
  return errors
}

/** Paid setups the guest added since the last save: each one opens a request to the host. */
export const addedPaidSetups = (before: Pick<GuestPreferences, 'setups'>, after: Pick<GuestPreferences, 'setups'>): Setup[] =>
  PAID_SETUPS.filter((s) => after.setups.includes(s) && !before.setups.includes(s))

// Service window

export type WindowMode = 'scheduled' | 'window' | 'dnd'
export const WINDOW_MODES: readonly WindowMode[] = ['scheduled', 'window', 'dnd']
export const WINDOW_MODE_LABEL: Record<WindowMode, string> = { scheduled: 'On schedule', window: 'In a window', dnd: 'Do not disturb' }

export interface ServiceWindow {
  mode: WindowMode
  from: string
  to: string
}

/** Rooms are serviced on the housekeeping schedule; villas between 10:00 and 12:00. */
export const defaultServiceWindow = (kind: UnitKind): ServiceWindow => (kind === 'villa' ? { mode: 'window', from: '10:00', to: '12:00' } : { mode: 'scheduled', from: '', to: '' })

export function validateServiceWindow(w: ServiceWindow): Partial<Record<keyof ServiceWindow, string>> {
  const errors: Partial<Record<keyof ServiceWindow, string>> = {}
  if (!WINDOW_MODES.includes(w.mode)) errors.mode = 'Pick when housekeeping may come in.'
  if (w.mode !== 'window') return errors
  if (!CLOCK.test(w.from)) errors.from = 'A time of day, for example 10:00.'
  if (!CLOCK.test(w.to)) errors.to = 'A time of day, for example 12:00.'
  else if (CLOCK.test(w.from) && w.to <= w.from) errors.to = 'The window ends after it starts.'
  return errors
}

/** Only a window keeps its times. */
export const cleanWindow = (w: ServiceWindow): ServiceWindow => (w.mode === 'window' ? { ...w } : { mode: w.mode, from: '', to: '' })

export const windowLabel = (w: ServiceWindow) => (w.mode === 'window' ? `${w.from} to ${w.to}` : WINDOW_MODE_LABEL[w.mode])

interface Hosted {
  hostId?: string | null
  preferences?: GuestPreferences
  serviceWindow?: ServiceWindow
}
/** What the guest asked for; empty on a stay saved before preferences existed. */
export const preferencesOf = (b: Hosted): GuestPreferences => b.preferences ?? EMPTY_PREFERENCES
/** The stay's window, else the kind's default. */
export const windowOf = (b: Hosted, kind: UnitKind): ServiceWindow => b.serviceWindow ?? defaultServiceWindow(kind)

const DND_OVERRIDE_MIN = 3
/**
 * A task for a do-not-disturb stay does not start (TASK_DND), unless a supervisor overrides it with a reason.
 */
export function assertMayEnter(window: ServiceWindow, override: { supervisor: boolean; reason: string }) {
  if (window.mode !== 'dnd') return
  if (override.reason.trim().length < DND_OVERRIDE_MIN) throw new RuleError('TASK_DND', 'The guest asked not to be disturbed.')
  if (!override.supervisor) throw new RuleError('TASK_DND', 'The guest asked not to be disturbed. Only a housekeeping supervisor may go in.')
}

// Host

/** Who may host a villa: an active or probation employee allocated to it. */
export const hostCandidates = (employees: readonly Employee[], villaId: string) =>
  employees.filter((e) => e.status !== 'inactive' && e.allocations.some((a) => a.villaId === villaId)).sort((a, b) => a.name.localeCompare(b.name))

/** A host must work at the villa (HOST_NOT_ALLOCATED); a room-kind unit has none. */
export function assertHost(hostId: string | null | undefined, kind: UnitKind, villaId: string, employees: readonly Employee[]) {
  if (!hostId) return
  if (kind !== 'villa') throw new RuleError('VALIDATION_ERROR', 'A hotel room has no host; hosts serve villas.')
  const e = employees.find((x) => x.id === hostId)
  if (!e || !hostCandidates([e], villaId).length) throw new RuleError('HOST_NOT_ALLOCATED', `${e?.name ?? 'That employee'} is not allocated to this villa. Allocate them in HR first.`)
}

// Late check-out

/** Rupiah a property charges for late check-out when it does not say: a hotel 500.000, villas nothing. */
export const defaultLateCheckoutFee = (operation: Operation) => (operation === 'villa' ? 0 : 500_000)

export interface LateCheckout {
  until: string
  charge: number
}

export interface LateCheckoutInput {
  kind: UnitKind
  operation: Operation
  fee: number
  until: string
  /** The property's check-out time; late means after it. */
  checkOutTime: string
  /** When the next guest arrives in the unit on the departure day, or null with no arrival. */
  nextArrival: string | null
}

/**
 * What late check-out costs, or LATE_CHECKOUT_TAKEN when the next guest arrives before `until`.
 * A villa is free with no arrival that day; a room pays the fee, and a mixed property never charges its villas.
 */
export function lateCheckoutCharge(i: LateCheckoutInput): number {
  if (!CLOCK.test(i.until)) throw new RuleError('VALIDATION_ERROR', 'Pick the time the guest leaves, for example 16:00.')
  if (i.until <= i.checkOutTime) throw new RuleError('VALIDATION_ERROR', `Check-out is ${i.checkOutTime} anyway; late check-out runs past it.`)
  if (i.nextArrival !== null && i.nextArrival < i.until) throw new RuleError('LATE_CHECKOUT_TAKEN', `The next guest arrives at ${i.nextArrival}, before ${i.until}.`)
  if (i.kind === 'room') return i.fee
  return i.nextArrival === null || i.operation === 'mixed' ? 0 : i.fee
}
