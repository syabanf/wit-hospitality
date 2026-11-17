import { describe, expect, it } from 'vitest'
import { acknowledgeProblem, doneProblem, groupByShift, shiftOf, validateLog, type LogEntry } from './logBook'
import { captureProblem, gatewayApprovalCode, holdProblem, preAuthExpired, validatePreAuth, type PreAuth } from './preAuth'
import { discrepancyBlock, discrepancyOf, frontOfficeStay, validateResolve, validateRoomCheck, type RoomCheck } from './roomCheck'

const TODAY = '2026-11-11'

describe('room checks', () => {
  it('finds a sleep, a skip and a person count, and nothing when both sides agree', () => {
    expect(discrepancyOf('vacant', null, true, 2)).toBe('sleep')
    expect(discrepancyOf('out_of_order', null, true, 2)).toBe('sleep')
    expect(discrepancyOf('occupied', 1, false, null)).toBe('skip')
    expect(discrepancyOf('occupied', 3, true, 2)).toBe('persons')
    expect(discrepancyOf('occupied', null, true, 2)).toBeNull()
    expect(discrepancyOf('out_of_order', null, false, null)).toBeNull()
  })

  it('reads the front office from the stay in house on the unit', () => {
    const stays = [
      { unitId: 'u1', unitAssigned: true, status: 'checked_in' as const, checkIn: '2026-11-10' },
      { unitId: 'u2', unitAssigned: true, status: 'confirmed' as const, checkIn: '2026-11-10' },
    ]
    expect(frontOfficeStay(stays, 'u1', TODAY)).toBe(stays[0])
    expect(frontOfficeStay(stays, 'u1', '2026-11-09')).toBeNull()
    expect(frontOfficeStay(stays, 'u2', TODAY)).toBeNull()
  })

  it('checks the round fields', () => {
    expect(validateRoomCheck({ unitId: 'u1', date: '2026-11-12', found: 'occupied', persons: 0, note: '' }, TODAY)).toEqual({ date: '2026-11-12 has not come yet.', persons: 'Enter the guests seen as a whole number from 1, or leave it empty.' })
    expect(validateRoomCheck({ unitId: 'u1', date: TODAY, found: 'vacant', persons: 0, note: '' }, TODAY)).toEqual({})
  })

  it('resolves only an open discrepancy, with an action that fits its kind', () => {
    const check = { id: 'rc', date: TODAY, discrepancy: 'skip', resolution: null } as RoomCheck
    expect(validateResolve(check, 'SK-01', { action: 'guest_out', note: 'ok' })).toEqual({ action: 'Guest out for the night does not settle a skip discrepancy.', note: 'Say what the desk found.' })
    expect(() => validateResolve({ ...check, discrepancy: null }, 'SK-01', { action: 'guest_out', note: 'fine' })).toThrow(expect.objectContaining({ code: 'DISCREPANCY_NONE' }))
    expect(() => validateResolve({ ...check, resolution: { action: 'checked_in', note: 'x', by: 'Kadek', at: '' } }, 'SK-01', { action: 'checked_in', note: 'fine' })).toThrow('SK-01 on 2026-11-11 was resolved by Kadek.')
  })

  it('blocks the audit on open discrepancies unless a manager gives a reason', () => {
    expect(discrepancyBlock(0, null, false, 'Wayan')).toBeNull()
    expect(() => discrepancyBlock(1, null, true, 'Kadek')).toThrow('1 room discrepancy is still open; resolve it before closing the day.')
    expect(() => discrepancyBlock(2, { reason: 'x' }, true, 'Kadek')).toThrow('Give the reason to close the day over open discrepancies.')
    expect(() => discrepancyBlock(2, { reason: 'Guest called' }, false, 'Wayan')).toThrow(expect.objectContaining({ code: 'AUDIT_DISCREPANCIES' }))
    expect(discrepancyBlock(2, { reason: ' Guest called ' }, true, 'Kadek')).toEqual({ by: 'Kadek', reason: 'Guest called' })
  })
})

describe('card holds', () => {
  const hold: PreAuth = { id: 'pa-1', number: 'PA-1001', bookingId: 'bk', amount: 2_000_000, brand: 'visa', last4: '4242', approvalCode: 'A1', expiresOn: TODAY, status: 'active', takenBy: '', takenAt: '', captured: 0, paymentId: null, closedBy: null, closedAt: null }

  it('checks the hold fields and keeps it to 30 days', () => {
    expect(validatePreAuth({ amount: 0, brand: 'visa', last4: '42', approvalCode: 'a!', expiresOn: '2026-12-20' }, TODAY)).toEqual({
      amount: 'Enter the hold in whole rupiah.',
      last4: 'Enter the last four digits of the card.',
      approvalCode: 'An approval code is 4 to 12 letters or digits.',
      expiresOn: 'A card hold stands at most 30 days.',
    })
    expect(gatewayApprovalCode(1)).toBe('A07919')
  })

  it('takes one hold per stay arriving or in house', () => {
    expect(holdProblem({ id: 'bk', code: 'BK-1', status: 'checked_out' }, [])?.code).toBe('PREAUTH_STAY')
    expect(holdProblem({ id: 'bk', code: 'BK-1', status: 'checked_in' }, [hold])?.message).toBe('BK-1 already holds PA-1001; capture or release it first.')
  })

  it('captures up to the hold and the room balance, never a lapsed hold', () => {
    expect(captureProblem(hold, 2_500_000, 3_000_000, TODAY)).toEqual({ amount: 'Only 2.000.000 is held.' })
    expect(captureProblem(hold, 1_500_000, 1_000_000, TODAY)).toEqual({ amount: 'The room balance is 1.000.000; capture at most that.' })
    expect(captureProblem(hold, 1_000_000, 1_000_000, TODAY)).toEqual({})
    expect(preAuthExpired(hold, '2026-11-12')).toBe(true)
    expect(() => captureProblem(hold, 1, 1, '2026-11-12')).toThrow(expect.objectContaining({ code: 'PREAUTH_EXPIRED' }))
    expect(() => captureProblem({ ...hold, status: 'released' }, 1, 1, TODAY)).toThrow('PA-1001 is released.')
  })
})

describe('log book', () => {
  const entry: LogEntry = { id: 'log-1', at: `${TODAY}T09:00:00`, date: TODAY, shift: 'morning', author: 'Wayan', authorId: 'usr-wayan', category: 'guest', text: 'Taxi', villaId: null, link: null, followUp: true, acknowledgedBy: null, acknowledgedAt: null, doneBy: null, doneAt: null, doneNote: '', shiftId: null }

  it('puts a note in its shift; a night note before 07:00 belongs to the day before', () => {
    expect(shiftOf(`${TODAY}T07:00:00`)).toEqual({ shift: 'morning', date: TODAY })
    expect(shiftOf(`${TODAY}T15:30:00`)).toEqual({ shift: 'afternoon', date: TODAY })
    expect(shiftOf(`${TODAY}T23:10:00`)).toEqual({ shift: 'night', date: TODAY })
    expect(shiftOf(`${TODAY}T02:30:00`)).toEqual({ shift: 'night', date: '2026-11-10' })
  })

  it('checks the entry and the follow-up steps', () => {
    expect(validateLog({ category: 'x' as never, text: 'ok', villaId: null, link: null, followUp: false })).toEqual({ category: 'Pick a category.', text: 'Write what the next shift needs to know.' })
    expect(acknowledgeProblem(entry, 'usr-wayan')?.code).toBe('LOG_OWN_ENTRY')
    expect(acknowledgeProblem({ ...entry, acknowledgedBy: 'Kadek', acknowledgedAt: `${TODAY}T15:10:00` }, 'usr-sari')?.message).toBe('Kadek acknowledged it at 15:10.')
    expect(acknowledgeProblem({ ...entry, followUp: false }, 'usr-sari')?.code).toBe('LOG_NO_FOLLOW_UP')
    expect(() => doneProblem({ ...entry, doneBy: 'Sari', doneAt: `${TODAY}T13:40:00` }, '')).toThrow('Sari marked it done at 13:40.')
  })

  it('groups by day and shift, newest first', () => {
    const groups = groupByShift([entry, { ...entry, id: 'log-2', at: `${TODAY}T16:00:00`, shift: 'afternoon' }, { ...entry, id: 'log-3', at: '2026-11-10T08:00:00', date: '2026-11-10' }])
    expect(groups.map((g) => `${g.date}:${g.shift}`)).toEqual([`${TODAY}:afternoon`, `${TODAY}:morning`, '2026-11-10:morning'])
  })
})
