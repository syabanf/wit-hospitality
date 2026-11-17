import { describe, expect, it } from 'vitest'
import type { Attendance, LeaveRequest, Shift, ShiftAssignment } from './hr'
import { checkClockIn, checkClockOut, checkLeaveBalance, checkSwap, clockAction, clockedIn, distanceMeters, leaveBalances, moveSwap, stampGeo, swapAssignments, type ShiftSwap, type SwapWorld, type VillaPoint } from './selfService'

const MORNING: Shift = { id: 'sh-morning', name: 'Morning', start: '07:00', end: '15:00' }
const NIGHT: Shift = { id: 'sh-night', name: 'Night', start: '22:00', end: '06:00' }
const row = (over: Partial<Attendance> = {}): Attendance => ({ id: 'att-1', employeeId: 'e1', date: '2026-11-11', status: 'present', clockIn: '07:00', clockOut: null, lateMinutes: 0, note: '', source: 'self', corrected: false, clockInGeo: null, clockOutGeo: null, ...over })
const code = (fn: () => unknown) => {
  try {
    fn()
  } catch (e) {
    return (e as { code?: string }).code
  }
  return 'none'
}

describe('the clock', () => {
  it('stamps late minutes against the shift start and refuses a second clock-in', () => {
    expect(clockedIn('07:12', MORNING, '', null)).toMatchObject({ status: 'late', lateMinutes: 12, source: 'self' })
    expect(clockedIn('06:55', MORNING, '', null)).toMatchObject({ status: 'present', lateMinutes: 0 })
    expect(code(() => checkClockIn(row(), MORNING, false, ''))).toBe('CLOCK_ALREADY_IN')
    expect(code(() => checkClockIn(row({ clockOut: '15:00' }), MORNING, false, ''))).toBe('CLOCK_ALREADY_OUT')
    expect(code(() => checkClockIn(undefined, MORNING, true, ''))).toBe('CLOCK_ON_LEAVE')
    expect(code(() => checkClockIn(row({ status: 'absent', clockIn: null, source: 'manual' }), MORNING, false, ''))).toBe('CLOCK_DAY_RECORDED')
    expect(code(() => checkClockIn(undefined, null, false, ''))).toBe('CLOCK_NOT_ROSTERED')
    expect(code(() => checkClockIn(undefined, null, false, 'Covering Made'))).toBe('none')
  })

  it('closes today or an overnight shift from yesterday, and needs a clock-in first', () => {
    expect(code(() => checkClockOut(null, undefined))).toBe('CLOCK_NOT_IN')
    expect(code(() => checkClockOut(null, row({ clockOut: '15:02' })))).toBe('CLOCK_ALREADY_OUT')
    const lastNight = row({ id: 'att-0', date: '2026-11-10', clockIn: '22:00' })
    expect(clockAction(undefined, lastNight, NIGHT)).toBe('out')
    expect(clockAction(undefined, lastNight, MORNING)).toBe('in')
    expect(clockAction(row({ clockOut: '15:00' }), undefined, null)).toBe('done')
  })

  it('reads the position against the nearest villa and never needs one', () => {
    const villas: VillaPoint[] = [{ id: 'v1', lat: -8.65, lng: 115.13 }, { id: 'v2', lat: null, lng: null }]
    expect(distanceMeters({ lat: -8.65, lng: 115.13 }, { lat: -8.651, lng: 115.13 })).toBe(111)
    expect(stampGeo({ lat: -8.6505, lng: 115.13 }, villas, 200)).toMatchObject({ villaId: 'v1', place: 'villa', distanceMeters: 56 })
    expect(stampGeo({ lat: -8.66, lng: 115.13 }, villas, 200)?.place).toBe('away')
    expect(stampGeo(null, villas, 200)).toBeNull()
    expect(stampGeo({ lat: 120, lng: 0 }, villas, 200)).toBeNull()
    expect(stampGeo({ lat: -8.65, lng: 115.13 }, villas.slice(1), 200)?.place).toBe('unknown')
  })
})

describe('the leave balance', () => {
  const leave = (kind: LeaveRequest['kind'], days: number, status: LeaveRequest['status'], from = '2026-03-02'): LeaveRequest => ({ id: `${kind}${days}${status}`, number: 'LV', employeeId: 'e1', kind, from, to: from, days, reason: '', status, requestedOn: from, decidedOn: null, decidedBy: '', decisionNote: '' })
  const balances = leaveBalances({ id: 'e1', annualLeaveDays: 12 }, [leave('annual', 4, 'approved'), leave('annual', 2, 'pending'), leave('annual', 5, 'approved', '2025-06-02'), leave('sick', 3, 'approved'), leave('unpaid', 9, 'approved')], '2026')

  it('counts used and pending days per kind in the year, unpaid without a limit', () => {
    expect(balances.find((b) => b.kind === 'annual')).toEqual({ kind: 'annual', entitlement: 12, used: 4, pending: 2, left: 6 })
    expect(balances.find((b) => b.kind === 'sick')).toMatchObject({ entitlement: 12, used: 3, left: 9 })
    expect(balances.find((b) => b.kind === 'unpaid')).toMatchObject({ entitlement: null, used: 9, left: null })
  })

  it('refuses a request past what is left and names the days', () => {
    expect(() => checkLeaveBalance('annual', 7, balances)).toThrow('Only 6 annual leave days are left.')
    expect(code(() => checkLeaveBalance('annual', 7, balances))).toBe('LEAVE_BALANCE_EXCEEDED')
    expect(code(() => checkLeaveBalance('annual', 6, balances))).toBe('none')
    expect(code(() => checkLeaveBalance('unpaid', 30, balances))).toBe('none')
  })
})

describe('shift swaps', () => {
  const asg = (employeeId: string, date: string, shiftId: string | null, villaId = 'v1'): ShiftAssignment => ({ id: `${employeeId}${date}`, employeeId, date, shiftId, villaId })
  const person = (id: string, villaId = 'v1') => ({ id, name: id.toUpperCase(), status: 'active' as const, allocations: [{ villaId, percent: 100 }] })
  const world = (over: Partial<SwapWorld> = {}): SwapWorld => ({
    today: '2026-11-11',
    requester: person('a'),
    counterpart: person('b'),
    assignments: [asg('a', '2026-11-13', 'sh-morning'), asg('b', '2026-11-13', null), asg('b', '2026-11-14', 'sh-night'), asg('a', '2026-11-14', null), asg('a', '2026-11-11', 'sh-morning')],
    leaves: [],
    shifts: [MORNING, NIGHT],
    swaps: [],
    villaName: () => 'Villa One',
    ...over,
  })

  it('refuses past shifts, a coworker elsewhere, leave, a double shift and an open swap', () => {
    expect(code(() => checkSwap({ date: '2026-11-11', counterDate: null }, world()))).toBe('SWAP_PAST_SHIFT')
    expect(code(() => checkSwap({ date: '2026-11-13', counterDate: null }, world({ counterpart: person('b', 'v2') })))).toBe('SWAP_NOT_COWORKER')
    expect(code(() => checkSwap({ date: '2026-11-13', counterDate: null }, world({ leaves: [{ employeeId: 'b', status: 'approved', from: '2026-11-12', to: '2026-11-13' }] })))).toBe('SWAP_ON_LEAVE')
    expect(code(() => checkSwap({ date: '2026-11-13', counterDate: null }, world({ assignments: [asg('a', '2026-11-13', 'sh-morning'), asg('b', '2026-11-13', 'sh-night')] })))).toBe('SWAP_DOUBLE_SHIFT')
    const open = { id: 'sw-1', number: 'SW-501', requesterId: 'a', date: '2026-11-13', counterpartId: 'c', counterDate: null, status: 'offered' } as ShiftSwap
    expect(code(() => checkSwap({ date: '2026-11-13', counterDate: null }, world({ swaps: [open] })))).toBe('SWAP_OPEN_EXISTS')
    expect(code(() => checkSwap({ date: '2026-11-13', counterDate: null }, world({ swaps: [open] }), 'sw-1'))).toBe('none')
  })

  it('swaps the two cells on approval', () => {
    const { mine, theirs } = checkSwap({ date: '2026-11-13', counterDate: '2026-11-14' }, world())
    expect(swapAssignments({ requesterId: 'a', counterpartId: 'b', date: '2026-11-13', counterDate: '2026-11-14' }, mine, theirs)).toEqual([
      { employeeId: 'a', date: '2026-11-13', shiftId: null, villaId: 'v1' },
      { employeeId: 'b', date: '2026-11-13', shiftId: 'sh-morning', villaId: 'v1' },
      { employeeId: 'b', date: '2026-11-14', shiftId: null, villaId: 'v1' },
      { employeeId: 'a', date: '2026-11-14', shiftId: 'sh-night', villaId: 'v1' },
    ])
  })

  it('lets the coworker answer, the requester cancel and the roster editor decide', () => {
    const swap = { number: 'SW-501', requesterId: 'a', requesterName: 'A', counterpartId: 'b', counterpartName: 'B', status: 'offered' } as ShiftSwap
    const actor = (employeeId: string | null, mayApprove = false) => ({ employeeId, mayApprove, roleLabel: 'Staff' })
    expect(code(() => moveSwap(swap, 'accept', actor('a'), ''))).toBe('FORBIDDEN')
    expect(moveSwap(swap, 'accept', actor('b'), '')).toBe('accepted')
    expect(code(() => moveSwap(swap, 'approve', actor(null, true), ''))).toBe('SWAP_NOT_ACCEPTED')
    expect(code(() => moveSwap({ ...swap, status: 'accepted' }, 'approve', actor('b'), ''))).toBe('FORBIDDEN')
    expect(moveSwap({ ...swap, status: 'accepted' }, 'approve', actor(null, true), '')).toBe('approved')
    expect(code(() => moveSwap({ ...swap, status: 'declined' }, 'cancel', actor('a'), ''))).toBe('SWAP_INVALID_STATE')
  })
})
