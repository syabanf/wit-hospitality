import { describe, expect, it } from 'vitest'
import { RuleError } from './errors'
import {
  assertCardSigned,
  assertEarlyCheckinOpen,
  cancelPendingCalls,
  earlyCheckinCharge,
  keysAllBack,
  newKey,
  validateCheckInKeys,
  validateIssueKey,
  validateRegistrationCard,
  validateWakeUp,
  wakeUpAfter,
  wakeUpOverdue,
  type EarlyCheckinInput,
  type WakeUpCall,
} from './frontDesk'

const code = (f: () => unknown) => {
  try {
    f()
    return 'ok'
  } catch (e) {
    return e instanceof RuleError ? `${e.code}: ${e.message}` : String(e)
  }
}
const png = { id: 'file-1', name: 'signature.png', type: 'image/png', size: 900, url: '', uploadedBy: 'Guest', uploadedAt: '2026-11-11T14:00:00' }

describe('registration card', () => {
  it('takes a signature drawn on screen or a paper card number', () => {
    expect(validateRegistrationCard({ method: 'screen', signature: png })).toEqual({})
    expect(validateRegistrationCard({ method: 'screen', signature: null })).toEqual({ signature: 'Ask the guest to sign on the screen.' })
    expect(validateRegistrationCard({ method: 'screen', signature: { ...png, type: 'application/pdf' } })).toEqual({ signature: 'The signature must be an image.' })
    expect(validateRegistrationCard({ method: 'paper', cardNumber: '  ' })).toEqual({ cardNumber: 'Enter the number printed on the paper card.' })
    expect(validateRegistrationCard({ method: 'paper', cardNumber: 'x'.repeat(31) })).toEqual({ cardNumber: 'A card number is at most 30 characters.' })
    expect(validateRegistrationCard({ method: 'fax' as never })).toEqual({ method: 'Pick signed on screen or on paper.' })
  })

  it('holds check-in until the card is signed where the property asks', () => {
    expect(code(() => assertCardSigned({ registrationCard: null }, true))).toBe('REGISTRATION_CARD_UNSIGNED: Have the guest sign the registration card before check-in.')
    expect(code(() => assertCardSigned({ registrationCard: null }, false))).toBe('ok')
  })
})

describe('early check-in', () => {
  const room: EarlyCheckinInput = { kind: 'room', operation: 'hotel', fee: 500_000, from: '10:00', checkInTime: '14:00', unitCode: 'SK-01', departure: null }

  it('charges a room the fee and lets a villa in free when nobody left that morning', () => {
    expect(earlyCheckinCharge(room)).toBe(500_000)
    expect(earlyCheckinCharge({ ...room, kind: 'villa', operation: 'villa', fee: 300_000 })).toBe(0)
    expect(earlyCheckinCharge({ ...room, kind: 'villa', operation: 'villa', fee: 300_000, departure: { code: 'BK-1', leavesBy: '09:00', checkedOut: false } })).toBe(300_000)
    expect(earlyCheckinCharge({ ...room, kind: 'villa', operation: 'mixed', departure: { code: 'BK-1', leavesBy: '09:00', checkedOut: false } })).toBe(0)
  })

  it('refuses a time after check-in and a unit the departing guest still holds', () => {
    expect(code(() => earlyCheckinCharge({ ...room, from: '9am' }))).toBe('VALIDATION_ERROR: Enter the time the guest arrives as HH:MM.')
    expect(code(() => earlyCheckinCharge({ ...room, from: '14:00' }))).toBe('VALIDATION_ERROR: Check-in is from 14:00 anyway; early check-in comes before it.')
    expect(code(() => earlyCheckinCharge({ ...room, departure: { code: 'BK-9', leavesBy: '12:00', checkedOut: false } }))).toBe('EARLY_CHECKIN_TAKEN: BK-9 still holds SK-01 until 12:00.')
    expect(earlyCheckinCharge({ ...room, departure: { code: 'BK-9', leavesBy: '12:00', checkedOut: true } })).toBe(500_000)
  })

  it('is set once, before arrival, on a stay with its room', () => {
    const b = { code: 'BK-2', status: 'confirmed' as const, earlyCheckin: null, unitAssigned: true }
    expect(code(() => assertEarlyCheckinOpen(b))).toBe('ok')
    expect(code(() => assertEarlyCheckinOpen({ ...b, status: 'checked_in' }))).toBe('BOOKING_INVALID_STATE: BK-2 is checked in; early check-in is set before arrival.')
    expect(code(() => assertEarlyCheckinOpen({ ...b, earlyCheckin: { from: '11:00', charge: 0 } }))).toBe('BOOKING_INVALID_STATE: BK-2 already arrives early, from 11:00.')
    expect(code(() => assertEarlyCheckinOpen({ ...b, unitAssigned: false }))).toBe('UNIT_UNASSIGNED: Assign a room to BK-2 before setting early check-in.')
  })
})

describe('keys', () => {
  const card = newKey([], { number: 'C-0101', kind: 'card' }, 'check_in', null, 'Wayan', '2026-11-11T14:00:00')

  it('needs a key at check-in, or the older tick', () => {
    expect(validateCheckInKeys([], false, 'room')).toEqual({ keys: 'Record the room key card handed over.' })
    expect(validateCheckInKeys(undefined, false, 'villa')).toEqual({ keys: 'Record the keys or access code handed over.' })
    expect(validateCheckInKeys(undefined, true, 'room')).toEqual({})
    expect(validateCheckInKeys([{ number: 'C-1', kind: 'card' }, { number: 'c-1', kind: 'card' }], false, 'room')).toEqual({ keys: 'c-1 is already out on this stay.' })
  })

  it('checks an extra key and a replacement against the keys out', () => {
    const b = { keys: [card] }
    expect(validateIssueKey({ number: 'C-0102', kind: 'card', reason: 'extra' }, b)).toEqual({})
    expect(validateIssueKey({ number: 'C-0101', kind: 'card', reason: 'extra' }, b)).toEqual({ number: 'C-0101 is already out on this stay.' })
    expect(validateIssueKey({ number: '', kind: 'badge' as never, reason: 'replacement', replacesKeyId: 'key-9', fee: -1 }, b)).toEqual({
      number: 'Enter the key number, card id or code.',
      kind: 'Pick a key card, a physical key or an access code.',
      replacesKeyId: 'Pick the key this one replaces.',
      fee: 'Enter the fee in whole rupiah, or zero.',
    })
  })

  it('reads the keys back unless one closed not returned', () => {
    expect(keysAllBack({ keys: [{ ...card, status: 'returned' }] }, false)).toBe(true)
    expect(keysAllBack({ keys: [{ ...card, status: 'not_returned' }] }, true)).toBe(false)
    expect(keysAllBack({ keys: [] }, false)).toBe(false)
  })
})

describe('wake-up calls', () => {
  const stay = { checkIn: '2026-11-10', checkOut: '2026-11-13' }
  const call: WakeUpCall = { id: 'wk-1', date: '2026-11-12', time: '06:00', note: '', repeatDaily: true, status: 'pending', by: 'Wayan', at: '2026-11-11T20:00:00', log: [] }

  it('rings on a morning of the stay, today or later', () => {
    expect(validateWakeUp({ date: '2026-11-13', time: '06:00', note: '', repeatDaily: false }, stay, '2026-11-11')).toEqual({})
    expect(validateWakeUp({ date: '2026-11-14', time: '6', note: 'x'.repeat(201), repeatDaily: false }, stay, '2026-11-11')).toEqual({
      date: 'Pick a day of the stay, from 2026-11-10 to 2026-11-13.',
      time: 'Enter the time as HH:MM.',
      note: 'Keep the note to 200 characters.',
    })
    expect(validateWakeUp({ date: '2026-11-10', time: '06:00', note: '', repeatDaily: false }, stay, '2026-11-11')).toEqual({ date: 'Pick today or a later day.' })
  })

  it('rolls a daily call on until check-out, retries no answer and refuses a closed call', () => {
    const next = wakeUpAfter(call, 'done', stay.checkOut, 'Wayan', '2026-11-12T06:01:00')
    expect([next.date, next.status, next.log.length]).toEqual(['2026-11-13', 'pending', 1])
    expect(wakeUpAfter(next, 'done', stay.checkOut, 'Wayan', 'x').status).toBe('done')
    expect(wakeUpAfter(call, 'no_answer', stay.checkOut, 'Wayan', 'x')).toMatchObject({ status: 'pending', date: '2026-11-12' })
    const cancelled = wakeUpAfter(call, 'cancelled', stay.checkOut, 'Wayan', 'x')
    expect(code(() => wakeUpAfter(cancelled, 'done', stay.checkOut, 'Wayan', 'x'))).toBe('WAKE_UP_CLOSED: This wake-up call is cancelled already.')
  })

  it('cancels pending calls when the stay ends and marks a missed one overdue', () => {
    expect(cancelPendingCalls([call], 'now')?.[0]).toMatchObject({ status: 'cancelled', log: [{ outcome: 'cancelled', by: 'System' }] })
    expect(wakeUpOverdue(call, '2026-11-12', '06:30')).toBe(true)
    expect(wakeUpOverdue(call, '2026-11-12', '05:30')).toBe(false)
    expect(wakeUpOverdue(call, '2026-11-13', '05:00')).toBe(true)
  })
})
