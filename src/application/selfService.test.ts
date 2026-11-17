import { beforeEach, describe, expect, it } from 'vitest'
import { fixedClock } from '@/infrastructure/clock'
import { createMockPorts } from '@/infrastructure/mock'
import { createServices, type Services } from './services'

const TODAY = '2026-11-11'
let s: Services
const signIn = (who: string) => s.access.login({ email: `${who}@balivillas.id`, password: 'villa123' })
const boot = (time: string) => {
  s = createServices(createMockPorts(fixedClock(TODAY, time), 0))
}

beforeEach(() => boot('07:10'))

describe('the employee clock', () => {
  it('clocks a staff member in and out with the server time and refuses a second press', async () => {
    await signIn('wayan')
    const before = await s.people.home()
    expect(before.clock?.action).toBe('in')
    const shift = before.clock?.shift
    const row = await s.selfService.clockIn({ reason: shift ? '' : 'Covering a shift', geo: { lat: -8.6478, lng: 115.1385 } })
    expect(row.clockIn).toBe('07:10')
    expect(row.source).toBe('self')
    expect(row.lateMinutes).toBe(shift ? Math.max(0, 7 * 60 + 10 - (Number(shift.start.slice(0, 2)) * 60 + Number(shift.start.slice(3)))) : 0)
    await expect(s.selfService.clockIn({ reason: '', geo: null })).rejects.toMatchObject({ code: 'CLOCK_ALREADY_IN' })
    expect((await s.people.home()).clock?.action).toBe('out')
    const out = await s.selfService.clockOut(null)
    expect(out.clockOut).toBe('07:10')
    await expect(s.selfService.clockOut(null)).rejects.toMatchObject({ code: 'CLOCK_ALREADY_OUT' })
    expect((await s.people.home()).clock?.action).toBe('done')
  })

  it('marks a clocked row corrected when HR edits it', async () => {
    await signIn('wayan')
    const row = await s.selfService.clockIn({ reason: 'Covering', geo: null })
    await signIn('nia')
    await s.hr.recordAttendance({ employeeId: row.employeeId, date: row.date, status: 'present', clockIn: '07:00', clockOut: null, note: 'Bike trouble' })
    const fixed = (await s.hr.attendance()).rows.find((r) => r.id === row.id)
    expect(fixed).toMatchObject({ source: 'self', corrected: true, clockIn: '07:00' })
  })

  it('lets HR change the radius within bounds and refuses staff', async () => {
    await signIn('nia')
    await expect(s.selfService.saveAttendanceSettings({ radiusMeters: 5 })).rejects.toMatchObject({ errors: { radiusMeters: expect.any(String) } })
    expect((await s.selfService.saveAttendanceSettings({ radiusMeters: 300 })).radiusMeters).toBe(300)
    await signIn('wayan')
    await expect(s.selfService.saveAttendanceSettings({ radiusMeters: 250 })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

describe('shift swaps', () => {
  it('walks a swap from offer to approval and swaps the roster', async () => {
    await signIn('wayan')
    const home = await s.people.home()
    const offered = home.swaps.find((x) => x.status === 'offered' && x.counterpartId === home.employee?.id)
    expect(offered).toBeDefined()
    if (!offered) return
    await expect(s.selfService.moveSwap(offered.id, 'approve')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect((await s.selfService.moveSwap(offered.id, 'accept')).status).toBe('accepted')
    await signIn('nia')
    await expect(s.selfService.moveSwap(offered.id, 'reject', '')).rejects.toMatchObject({ errors: { note: 'Say why.' } })
    expect((await s.selfService.moveSwap(offered.id, 'approve')).status).toBe('approved')
    const roster = await s.hr.roster(offered.date)
    const cell = (id: string) => roster.rows.find((r) => r.employee.id === id)?.cells.find((c) => c?.date === offered.date)?.shiftId
    expect(cell(offered.counterpartId)).toBe(offered.shiftId)
    expect(cell(offered.requesterId)).toBe(offered.counterShiftId)
  })

  it('refuses a past shift and a second open swap on the same shift', async () => {
    await signIn('wayan')
    const home = await s.people.home()
    const me = home.team.find((m) => m.id === home.employee?.id)
    const coworker = home.team.find((m) => m.id !== home.employee?.id)
    await expect(s.selfService.requestSwap({ date: TODAY, counterpartId: coworker?.id ?? '', counterDate: null, note: '' })).rejects.toMatchObject({ code: 'SWAP_PAST_SHIFT' })
    const day = me?.days.find((d) => d.shift && d.date > TODAY && !home.swaps.some((x) => x.date === d.date || x.counterDate === d.date))
    const free = home.team.find((m) => m.id !== me?.id && !m.days.find((d) => d.date === day?.date)?.shift)
    expect(day && free).toBeTruthy()
    if (!day || !free) return
    const swap = await s.selfService.requestSwap({ date: day.date, counterpartId: free.id, counterDate: null, note: 'Ceremony' })
    expect(swap.status).toBe('offered')
    await expect(s.selfService.requestSwap({ date: day.date, counterpartId: free.id, counterDate: null, note: '' })).rejects.toMatchObject({ code: 'SWAP_OPEN_EXISTS' })
  })
})

describe('the employee home', () => {
  it('serves a staff member the leave balance per kind and the villa team, names and shifts only', async () => {
    await signIn('wayan')
    const home = await s.people.home()
    expect(home.leaveBalances.map((b) => b.kind)).toEqual(['annual', 'sick', 'permission', 'unpaid'])
    expect(home.team.length).toBeGreaterThan(1)
    expect(Object.keys(home.team[0] ?? {}).sort()).toEqual(['days', 'id', 'name', 'position'])
    expect(home.attendance.monthRows.every((r) => r.employeeId === home.employee?.id)).toBe(true)
    const annual = home.leaveBalances[0]
    await expect(s.people.requestLeave({ kind: 'annual', from: '2026-12-01', to: '2026-12-31', reason: 'Long trip' })).rejects.toMatchObject({ code: 'LEAVE_BALANCE_EXCEEDED', message: expect.stringContaining(`${annual?.left}`) })
  })
})
