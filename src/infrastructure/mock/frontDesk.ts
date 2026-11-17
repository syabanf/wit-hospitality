import type { FrontDeskPort } from '@/application/ports'
import { can, ROLE_LABEL, type User } from '@/domain/access'
import type { Booking, CheckInDetails } from '@/domain/booking'
import { findById, RuleError } from '@/domain/errors'
import {
  assertCardOpen,
  assertCardSigned,
  assertCardUnsigned,
  assertEarlyCheckinOpen,
  assertKeysOpen,
  assertWakeUpOpen,
  cancelPendingCalls,
  cardFrom,
  cardSummary,
  closeKey,
  departureOf,
  earlyCheckinCharge,
  keyChargeDescription,
  keysAllBack,
  keysOut,
  newKey,
  newWakeUp,
  outKey,
  validateCheckInKeys,
  validateIssueKey,
  validateOutcome,
  validateRegistrationCard,
  validateReturnFee,
  validateWakeUp,
  wakeUpAfter,
  type CardInput,
  type CardPlace,
  type StayKey,
  type WakeUpInput,
} from '@/domain/frontDesk'
import { unitKindOf } from '@/domain/property'
import type { MockState } from './state'

/** The mock API's helpers the front desk steps need. */
export interface FrontDeskDeps {
  s: MockState
  later: <T>(value: () => T) => Promise<T>
  atomically: <T>(change: () => T) => T
  copy: <T>(v: T) => T
  today: () => string
  clockNow: () => string
  user: () => User
  refuse: (errors: Record<string, string | undefined>) => void
  log: (action: 'update' | 'status', entity: string, entityId: string, summary: string, before?: Record<string, unknown> | null, after?: Record<string, unknown> | null, actor?: User) => void
  /** Posts a fee on the stay's folio on `code`, in its price mode. */
  charge: (b: Booking, code: string, description: string, amount: number, actor: User) => void
}

/** The registration card, early check-in, keys and wake-up calls, as the API's reservation context runs them. */
export function createFrontDesk(d: FrontDeskDeps) {
  const { s, later, atomically, copy, today, clockNow, user, refuse, log } = d
  const booking = (id: string) => findById(s.bookings, id, 'booking')

  function editor() {
    const me = user()
    if (!can(s.permissions, me.role, 'booking', 'edit')) throw new RuleError('FORBIDDEN', `${ROLE_LABEL[me.role]} cannot edit in Bookings.`)
    return me
  }

  /** Signs the stay's card in the actor's name, from the desk or one of the guest's pages. */
  function signCard(b: Booking, input: CardInput, actor: User, where: CardPlace) {
    assertCardOpen(b)
    refuse(validateRegistrationCard(input))
    assertCardUnsigned(b)
    b.registrationCard = cardFrom(input, actor.name, where, clockNow())
    log('update', 'booking', b.code, `Signed the registration card of ${b.code} ${cardSummary(b.registrationCard)}`, null, { method: input.method }, actor)
  }

  function bookWakeUp(b: Booking, input: WakeUpInput, actor: User) {
    assertWakeUpOpen(b)
    refuse(validateWakeUp(input, b, today()))
    const call = newWakeUp(b.wakeUpCalls ?? [], input, actor.name, clockNow())
    b.wakeUpCalls = [...(b.wakeUpCalls ?? []), call]
    log('update', 'booking', b.code, `Booked a wake-up call for ${b.code} on ${call.date} at ${call.time}${call.repeatDaily ? ', daily' : ''}`, null, { date: call.date, time: call.time }, actor)
    return call
  }

  function setKey(b: Booking, key: StayKey) {
    b.keys = (b.keys ?? []).map((k) => (k.id === key.id ? key : k))
  }

  function chargeKey(b: Booking, key: StayKey, actor: User) {
    if (key.charge > 0) d.charge(b, 'DMG', keyChargeDescription(key), key.charge, actor)
  }

  const port: FrontDeskPort = {
    signCard: (id, input) =>
      later(() => {
        const b = booking(id)
        signCard(b, input, editor(), 'desk')
        return copy(b)
      }),
    earlyCheckin: (id, from) =>
      later(() =>
        atomically(() => {
          const me = editor()
          const b = booking(id)
          assertEarlyCheckinOpen(b)
          const { villa, unit } = s.catalog().place(b.unitId)
          const charge = earlyCheckinCharge({
            kind: unitKindOf(s.catalog(), b.unitId),
            operation: villa.operation,
            fee: villa.earlyCheckinFee,
            from,
            checkInTime: villa.checkInTime,
            unitCode: unit.code,
            departure: departureOf(b, s.bookings, villa.checkOutTime),
          })
          b.earlyCheckin = { from, charge, by: me.name, at: clockNow() }
          if (charge > 0) d.charge(b, 'EARLY', `Early check-in from ${from}`, charge, me)
          log('update', 'booking', b.code, `Gave ${b.code} early check-in from ${from}${charge ? `, charged ${charge}` : ', free'}`, null, { from, charge }, me)
          return copy({ booking: b, charge })
        }),
      ),
    issueKey: (id, input) =>
      later(() =>
        atomically(() => {
          const me = editor()
          const b = booking(id)
          assertKeysOpen(b)
          refuse(validateIssueKey(input, b))
          const at = clockNow()
          if (input.reason === 'replacement') {
            const lost = closeKey(outKey(b, input.replacesKeyId ?? ''), 'lost', input.fee ?? 0, me.name, at)
            setKey(b, lost)
            chargeKey(b, lost, me)
          }
          const key = newKey(b.keys ?? [], input, input.reason, input.reason === 'replacement' ? (input.replacesKeyId ?? null) : null, me.name, at)
          b.keys = [...(b.keys ?? []), key]
          log('update', 'booking', b.code, `Gave ${b.code} ${input.reason === 'replacement' ? 'a replacement' : 'an extra'} key ${key.number}`, null, { number: key.number, kind: key.kind }, me)
          return copy(b)
        }),
      ),
    returnKey: (id, keyId, returned, fee) =>
      later(() =>
        atomically(() => {
          const me = editor()
          const b = booking(id)
          assertKeysOpen(b)
          refuse(validateReturnFee(fee))
          const key = closeKey(outKey(b, keyId), returned ? 'returned' : 'not_returned', returned ? 0 : (fee ?? 0), me.name, clockNow())
          setKey(b, key)
          chargeKey(b, key, me)
          log('update', 'booking', b.code, returned ? `Took back key ${key.number} from ${b.code}` : `Marked key ${key.number} of ${b.code} not returned${key.charge ? `, charged ${key.charge}` : ''}`, null, { status: key.status }, me)
          return copy(b)
        }),
      ),
    bookWakeUp: (id, input) =>
      later(() => {
        const b = booking(id)
        bookWakeUp(b, input, editor())
        return copy(b)
      }),
    wakeUpOutcome: (id, callId, outcome) =>
      later(() => {
        const me = editor()
        const b = booking(id)
        assertWakeUpOpen(b)
        refuse(validateOutcome(outcome))
        const call = (b.wakeUpCalls ?? []).find((c) => c.id === callId)
        if (!call) throw new RuleError('NOT_FOUND', 'That wake-up call was not found on this stay.')
        const next = wakeUpAfter(call, outcome, b.checkOut, me.name, clockNow())
        b.wakeUpCalls = (b.wakeUpCalls ?? []).map((c) => (c.id === callId ? next : c))
        log('update', 'booking', b.code, `Wake-up call for ${b.code} on ${call.date} at ${call.time}: ${outcome.replace('_', ' ')}`, null, { outcome }, me)
        return copy(b)
      }),
  }

  return {
    port,
    signCard,
    bookWakeUp,
    /** Check-in: the card when the property asks for it, then the keys handed over. */
    checkIn(b: Booking, details: CheckInDetails, actor: User) {
      refuse(validateCheckInKeys(details.keys, details.keysHanded, unitKindOf(s.catalog(), b.unitId)))
      assertCardSigned(b, s.catalog().place(b.unitId).villa.requireRegistrationCard)
      const at = clockNow()
      for (const k of details.keys ?? []) b.keys = [...(b.keys ?? []), newKey(b.keys ?? [], k, 'check_in', null, actor.name, at)]
      return { ...details, keysHanded: details.keysHanded || Boolean(details.keys?.length), ...(details.keys ? { keys: details.keys.map((k) => ({ number: k.number.trim(), kind: k.kind })) } : {}) }
    },
    assertCardSigned: (b: Booking) => assertCardSigned(b, s.catalog().place(b.unitId).villa.requireRegistrationCard),
    /**
     * A stay that ends closes its keys still out and cancels its pending wake-up calls. Answers whether the keys
     * came back: none closed not returned, or `ticked` on a stay without a key record.
     */
    endStay(b: Booking, actor: User, ticked = true) {
      const at = clockNow()
      for (const k of keysOut(b)) setKey(b, closeKey(k, 'not_returned', 0, actor.name, at))
      b.wakeUpCalls = cancelPendingCalls(b.wakeUpCalls, at)
      return keysAllBack(b, ticked)
    },
  }
}
