import { addDays, type IsoDate } from '@/lib/dates'
import type { Attachment } from './attachment'
import type { Booking } from './booking'
import { RuleError } from './errors'
import type { Operation, UnitKind } from './property'

/**
 * The front desk's standard steps around a stay: the signed registration card, early check-in, the keys
 * handed out and back, and wake-up calls. Each record sits on the booking; see front-desk-sop-contract.md.
 */

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/
type Errors<K extends string> = Partial<Record<K, string>>
const over = (b: Pick<Booking, 'status'>) => b.status === 'checked_out' || b.status === 'cancelled' || b.status === 'no_show'
const statusWords = (status: Booking['status']) => status.replace('_', ' ')

// Property settings

/** Whether a property asks a signed registration card before check-in when it does not say: wherever rooms are sold. */
export const defaultRequireRegistrationCard = (operation: Operation) => operation !== 'villa'
/** Rupiah a property charges for early check-in when it does not say: 500.000 where rooms are sold, villas nothing. */
export const defaultEarlyCheckinFee = (operation: Operation) => (operation === 'villa' ? 0 : 500_000)

// Registration card

export type CardMethod = 'screen' | 'paper'
export type CardPlace = 'desk' | 'precheckin' | 'stay'
export const CARD_PLACE_LABEL: Record<CardPlace, string> = { desk: 'at the desk', precheckin: 'on the online check-in', stay: 'on the stay page' }

export interface RegistrationCard {
  method: CardMethod
  /** The PNG drawn on screen, stored through the files context; null on paper. */
  signature: Attachment | null
  /** The printed card's number; empty when signed on screen. */
  cardNumber: string
  signedAt: string
  /** Who took the signature: a staff name, or "Guest". */
  by: string
  where: CardPlace
}

export interface CardInput {
  method: CardMethod
  signature?: Attachment | null
  cardNumber?: string
}

const MAX_CARD_NUMBER = 30

export function validateRegistrationCard(input: CardInput): Errors<'method' | 'signature' | 'cardNumber'> {
  if (input.method !== 'screen' && input.method !== 'paper') return { method: 'Pick signed on screen or on paper.' }
  if (input.method === 'screen') {
    if (!input.signature?.id) return { signature: 'Ask the guest to sign on the screen.' }
    if (!input.signature.type.startsWith('image/')) return { signature: 'The signature must be an image.' }
    return {}
  }
  const number = (input.cardNumber ?? '').trim()
  if (!number) return { cardNumber: 'Enter the number printed on the paper card.' }
  if (number.length > MAX_CARD_NUMBER) return { cardNumber: `A card number is at most ${MAX_CARD_NUMBER} characters.` }
  return {}
}

/** A stay that is over keeps its card as it is. */
export function assertCardOpen(b: Pick<Booking, 'status'>) {
  if (over(b)) throw new RuleError('BOOKING_INVALID_STATE', 'This stay is over; its registration card no longer changes.')
}

/** One card per stay (CARD_ALREADY_SIGNED). */
export function assertCardUnsigned(b: Pick<Booking, 'code' | 'registrationCard'>) {
  if (b.registrationCard) throw new RuleError('CARD_ALREADY_SIGNED', `${b.code} already has a signed registration card.`)
}

/** The card a valid input gives. */
export const cardFrom = (input: CardInput, by: string, where: CardPlace, at: string): RegistrationCard =>
  input.method === 'screen'
    ? { method: 'screen', signature: { ...input.signature! }, cardNumber: '', signedAt: at, by, where }
    : { method: 'paper', signature: null, cardNumber: (input.cardNumber ?? '').trim(), signedAt: at, by, where }

/** Check-in waits for the card when the property asks for one (REGISTRATION_CARD_UNSIGNED). */
export function assertCardSigned(b: Pick<Booking, 'registrationCard'>, required: boolean) {
  if (required && !b.registrationCard) throw new RuleError('REGISTRATION_CARD_UNSIGNED', 'Have the guest sign the registration card before check-in.')
}

export const cardSummary = (c: RegistrationCard) => (c.method === 'screen' ? 'on screen' : `on paper card ${c.cardNumber}`)

// Early check-in

export interface EarlyCheckin {
  from: string
  charge: number
  by?: string
  at?: string
}

/** The stay leaving the unit on the arrival day, as the early check-in rule reads it. */
export interface Departure {
  code: string
  /** Its late check-out time, else the house check-out time. */
  leavesBy: string
  checkedOut: boolean
}

export interface EarlyCheckinInput {
  kind: UnitKind
  operation: Operation
  fee: number
  from: string
  /** The property's check-in time; early means before it. */
  checkInTime: string
  unitCode: string
  departure: Departure | null
}

/** Early check-in is set on a confirmed stay with its room, once. */
export function assertEarlyCheckinOpen(b: Pick<Booking, 'code' | 'status' | 'earlyCheckin' | 'unitAssigned'>) {
  if (b.status !== 'confirmed') throw new RuleError('BOOKING_INVALID_STATE', `${b.code} is ${statusWords(b.status)}; early check-in is set before arrival.`)
  if (b.earlyCheckin) throw new RuleError('BOOKING_INVALID_STATE', `${b.code} already arrives early, from ${b.earlyCheckin.from}.`)
  if (!b.unitAssigned) throw new RuleError('UNIT_UNASSIGNED', `Assign a room to ${b.code} before setting early check-in.`)
}

/**
 * What early check-in costs, or EARLY_CHECKIN_TAKEN while the departing guest still holds the unit past `from`.
 * A room pays the fee; a villa arrives early for free when nobody left it that morning, and a mixed property never charges its villas.
 */
export function earlyCheckinCharge(i: EarlyCheckinInput): number {
  if (!CLOCK.test(i.from)) throw new RuleError('VALIDATION_ERROR', 'Enter the time the guest arrives as HH:MM.')
  if (i.from >= i.checkInTime) throw new RuleError('VALIDATION_ERROR', `Check-in is from ${i.checkInTime} anyway; early check-in comes before it.`)
  const d = i.departure
  if (d && !d.checkedOut && d.leavesBy > i.from) throw new RuleError('EARLY_CHECKIN_TAKEN', `${d.code} still holds ${i.unitCode} until ${d.leavesBy}.`)
  if (i.kind === 'room') return i.fee
  return d === null || i.operation === 'mixed' ? 0 : i.fee
}

/** The stay that leaves the unit on `b`'s arrival morning, or null. */
export function departureOf(b: Pick<Booking, 'id' | 'unitId' | 'checkIn'>, bookings: readonly Booking[], checkOutTime: string): Departure | null {
  const d = bookings.find((x) => x.id !== b.id && x.unitAssigned && x.unitId === b.unitId && x.checkOut === b.checkIn && x.status !== 'cancelled' && x.status !== 'no_show' && x.status !== 'draft')
  return d ? { code: d.code, leavesBy: d.lateCheckout?.until ?? checkOutTime, checkedOut: d.status === 'checked_out' } : null
}

// Keys

export type KeyKind = 'card' | 'key' | 'code'
export const KEY_KINDS: readonly KeyKind[] = ['card', 'key', 'code']
export const KEY_KIND_LABEL: Record<KeyKind, string> = { card: 'Key card', key: 'Physical key', code: 'Access code' }
export type KeyReason = 'check_in' | 'extra' | 'replacement'
export const KEY_REASON_LABEL: Record<KeyReason, string> = { check_in: 'At check-in', extra: 'Extra key', replacement: 'Replacement' }
export type KeyStatus = 'out' | 'returned' | 'lost' | 'not_returned'
export const KEY_STATUS_LABEL: Record<KeyStatus, string> = { out: 'Out', returned: 'Returned', lost: 'Lost', not_returned: 'Not returned' }

export interface StayKey {
  id: string
  number: string
  kind: KeyKind
  reason: KeyReason
  /** The lost key this one replaces. */
  replaces: string | null
  issuedAt: string
  issuedBy: string
  status: KeyStatus
  closedAt: string | null
  closedBy: string | null
  /** Rupiah charged when the key closed lost or not returned. */
  charge: number
}

export interface KeyHanded {
  number: string
  kind: KeyKind
}

export interface IssueKeyInput extends KeyHanded {
  reason: 'extra' | 'replacement'
  replacesKeyId?: string | null
  fee?: number
}

const MAX_KEY_NUMBER = 30
export const keysOut = (b: Pick<Booking, 'keys'>) => (b.keys ?? []).filter((k) => k.status === 'out')

function keyProblems(k: KeyHanded, taken: readonly string[]): Errors<'number' | 'kind'> {
  const errors: Errors<'number' | 'kind'> = {}
  const number = k.number.trim()
  if (!number) errors.number = 'Enter the key number, card id or code.'
  else if (number.length > MAX_KEY_NUMBER) errors.number = `A key number is at most ${MAX_KEY_NUMBER} characters.`
  else if (taken.some((x) => x.toLowerCase() === number.toLowerCase())) errors.number = `${number} is already out on this stay.`
  if (!KEY_KINDS.includes(k.kind)) errors.kind = 'Pick a key card, a physical key or an access code.'
  return errors
}

const feeProblem = (fee: number | undefined) => (fee !== undefined && (!Number.isInteger(fee) || fee < 0) ? 'Enter the fee in whole rupiah, or zero.' : undefined)

/** The keys a check-in hands over: at least one, or the older "keys handed" tick (field `keys`). */
export function validateCheckInKeys(keys: readonly KeyHanded[] | undefined, keysHanded: boolean, kind: UnitKind): Errors<'keys'> {
  if (keys?.length) {
    const taken: string[] = []
    for (const k of keys) {
      const problem = Object.values(keyProblems(k, taken))[0]
      if (problem) return { keys: problem }
      taken.push(k.number.trim())
    }
    return {}
  }
  if (keysHanded) return {}
  return { keys: kind === 'room' ? 'Record the room key card handed over.' : 'Record the keys or access code handed over.' }
}

export function validateIssueKey(input: IssueKeyInput, b: Pick<Booking, 'keys'>): Errors<'number' | 'kind' | 'reason' | 'replacesKeyId' | 'fee'> {
  const out = keysOut(b)
  const errors: Errors<'number' | 'kind' | 'reason' | 'replacesKeyId' | 'fee'> = keyProblems(input, out.map((k) => k.number))
  if (input.reason !== 'extra' && input.reason !== 'replacement') errors.reason = 'Pick why the key goes out.'
  if (input.reason === 'replacement' && !out.some((k) => k.id === input.replacesKeyId)) errors.replacesKeyId = 'Pick the key this one replaces.'
  const fee = feeProblem(input.fee)
  if (fee) errors.fee = fee
  return errors
}

export const validateReturnFee = (fee: number | undefined): Errors<'fee'> => ({ fee: feeProblem(fee) })

/** Keys go out and come back while the guest is in house. */
export function assertKeysOpen(b: Pick<Booking, 'code' | 'status'>) {
  if (b.status !== 'checked_in') throw new RuleError('BOOKING_INVALID_STATE', `${b.code} is not in house; keys go out at check-in and during the stay.`)
}

/** The next key id on the stay. */
const nextKeyId = (keys: readonly StayKey[]) => `key-${keys.length + 1}`

export function newKey(keys: readonly StayKey[], k: KeyHanded, reason: KeyReason, replaces: string | null, by: string, at: string): StayKey {
  return { id: nextKeyId(keys), number: k.number.trim(), kind: k.kind, reason, replaces, issuedAt: at, issuedBy: by, status: 'out', closedAt: null, closedBy: null, charge: 0 }
}

/** The key that is out, or KEY_NOT_OUT. */
export function outKey(b: Pick<Booking, 'keys'>, keyId: string): StayKey {
  const key = (b.keys ?? []).find((k) => k.id === keyId)
  if (!key) throw new RuleError('NOT_FOUND', 'That key was not found on this stay.')
  if (key.status !== 'out') throw new RuleError('KEY_NOT_OUT', `${key.number} is not out.`)
  return key
}

export function closeKey(key: StayKey, status: Exclude<KeyStatus, 'out'>, charge: number, by: string, at: string): StayKey {
  return { ...key, status, charge, closedAt: at, closedBy: by }
}

/** Whether the keys came back: none closed not returned, or `ticked` on a stay without a key record. */
export const keysAllBack = (b: Pick<Booking, 'keys'>, ticked: boolean) => (b.keys?.length ? !b.keys.some((k) => k.status === 'not_returned') : ticked)

export const keyChargeDescription = (key: StayKey) => (key.status === 'lost' ? `Lost key ${key.number}` : `Key not returned: ${key.number}`)

// Wake-up calls

export type WakeUpStatus = 'pending' | 'done' | 'cancelled'
export type WakeUpOutcome = 'done' | 'no_answer' | 'cancelled'
export const WAKE_UP_OUTCOMES: readonly WakeUpOutcome[] = ['done', 'no_answer', 'cancelled']
export const WAKE_UP_OUTCOME_LABEL: Record<WakeUpOutcome, string> = { done: 'Done', no_answer: 'No answer', cancelled: 'Cancelled' }

export interface WakeUpLog {
  date: IsoDate
  outcome: WakeUpOutcome
  by: string
  at: string
}

export interface WakeUpCall {
  id: string
  date: IsoDate
  time: string
  note: string
  repeatDaily: boolean
  status: WakeUpStatus
  by: string
  at: string
  log: WakeUpLog[]
}

export interface WakeUpInput {
  date: IsoDate
  time: string
  note: string
  repeatDaily: boolean
}

const MAX_WAKE_NOTE = 200
export const SYSTEM_ACTOR = 'System'

export function assertWakeUpOpen(b: Pick<Booking, 'status'>) {
  if (over(b)) throw new RuleError('BOOKING_INVALID_STATE', 'This stay is over; its wake-up calls no longer change.')
}

export function validateWakeUp(input: WakeUpInput, b: Pick<Booking, 'checkIn' | 'checkOut'>, today: IsoDate): Errors<'date' | 'time' | 'note'> {
  const errors: Errors<'date' | 'time' | 'note'> = {}
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || input.date < b.checkIn || input.date > b.checkOut) errors.date = `Pick a day of the stay, from ${b.checkIn} to ${b.checkOut}.`
  else if (input.date < today) errors.date = 'Pick today or a later day.'
  if (!CLOCK.test(input.time)) errors.time = 'Enter the time as HH:MM.'
  if (input.note.trim().length > MAX_WAKE_NOTE) errors.note = `Keep the note to ${MAX_WAKE_NOTE} characters.`
  return errors
}

export function newWakeUp(calls: readonly WakeUpCall[], input: WakeUpInput, by: string, at: string): WakeUpCall {
  return { id: `wk-${calls.length + 1}`, date: input.date, time: input.time, note: input.note.trim(), repeatDaily: input.repeatDaily, status: 'pending', by, at, log: [] }
}

export const validateOutcome = (outcome: string): Errors<'outcome'> => (WAKE_UP_OUTCOMES.includes(outcome as WakeUpOutcome) ? {} : { outcome: 'Pick done, no answer or cancel.' })

/**
 * The call after an outcome: done rolls a daily call to the next morning until the stay ends, no answer keeps it
 * pending for a retry, cancel ends it. A call that is not pending refuses (WAKE_UP_CLOSED).
 */
export function wakeUpAfter(call: WakeUpCall, outcome: WakeUpOutcome, checkOut: IsoDate, by: string, at: string): WakeUpCall {
  if (call.status !== 'pending') throw new RuleError('WAKE_UP_CLOSED', `This wake-up call is ${call.status} already.`)
  const log = [...call.log, { date: call.date, outcome, by, at }]
  if (outcome === 'no_answer') return { ...call, log }
  if (outcome === 'cancelled') return { ...call, status: 'cancelled', log }
  const next = addDays(call.date, 1)
  return call.repeatDaily && next <= checkOut ? { ...call, date: next, log } : { ...call, status: 'done', log }
}

/** A stay that ends cancels the calls still pending, in the system's name. */
export const cancelPendingCalls = (calls: readonly WakeUpCall[] | undefined, at: string): WakeUpCall[] | undefined =>
  calls?.map((c) => (c.status === 'pending' ? { ...c, status: 'cancelled' as const, log: [...c.log, { date: c.date, outcome: 'cancelled' as const, by: SYSTEM_ACTOR, at }] } : c))

/** A pending call is overdue once its morning or its time has passed. */
export const wakeUpOverdue = (call: Pick<WakeUpCall, 'date' | 'time' | 'status'>, today: IsoDate, now: string) => call.status === 'pending' && (call.date < today || (call.date === today && call.time < now))
