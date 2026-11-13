import { describe, expect, it } from 'vitest'
import { assertTaskAction, autoAssign, dndStreak, linenLevels, missingOf, planTasks, validateHousekeepingSettings, validateLaundryReturn, DEFAULT_HOUSEKEEPING_SETTINGS, type AssignableTask } from './housekeeping'

const task = (id: string, villaId: string, unitCode: string, credits = 1): AssignableTask => ({ id, villaId, locationId: villaId === 'v3' ? 'l2' : 'l1', unitCode, type: 'departure', credits })

describe('housekeeping rules', () => {
  it('plans a departure after each check-out or dirty room and stayover service for each stay in house', () => {
    const units = [
      { id: 'u1', villaId: 'v1', status: 'active' },
      { id: 'u2', villaId: 'v1', status: 'active' },
      { id: 'u3', villaId: 'v1', status: 'active' },
      { id: 'u4', villaId: 'v1', status: 'inactive' },
    ]
    const stays = [
      { id: 'b1', unitId: 'u1', checkIn: '2026-10-01', checkOut: '2026-10-05' },
      { id: 'b2', unitId: 'u2', checkIn: '2026-10-03', checkOut: '2026-10-07' },
    ]
    const planned = planTasks({ date: '2026-10-05', units, stays, dirty: new Set(['u3', 'u4']), turndown: true, existing: [{ unitId: 'u3', type: 'departure' }], stayoverEvery: () => 1 })
    expect(planned.map((p) => `${p.unitId}:${p.type}:${p.bookingId}`)).toEqual(['u1:departure:b1', 'u2:stayover:b2', 'u2:turndown:b2'])
  })

  it('keeps a villa with one attendant, stops at the quota and lets the location stand in', () => {
    const tasks = [task('a', 'v1', 'A-01'), task('b', 'v1', 'A-02'), task('c', 'v1', 'A-03'), task('d', 'v2', 'B-01', 2), task('e', 'v3', 'C-01')]
    const attendants = [
      { id: 'x', villaIds: ['v1'], locationIds: ['l1'], credits: 0 },
      { id: 'y', villaIds: ['v1', 'v2'], locationIds: ['l1'], credits: 3 },
    ]
    const given = autoAssign(tasks, attendants, 4)
    const to = Object.fromEntries(given.map((g) => [g.taskId, g.attendantId]))
    // v1 goes whole to x; B-01 does not fit y, the one who serves v2; nobody works in l2, so C-01 stays open too.
    expect(to).toEqual({ a: 'x', b: 'x', c: 'x' })
    expect(autoAssign([task('d', 'v2', 'B-01', 1)], attendants, 4)).toEqual([{ taskId: 'd', attendantId: 'y' }])
    // Nobody serves v9, so the attendant of the same location with the most room takes it.
    expect(autoAssign([task('f', 'v9', 'Z-01')], attendants, 4)).toEqual([{ taskId: 'f', attendantId: 'x' }])
  })

  it('splits a villa in unit order when nobody can take all of it', () => {
    const tasks = [task('a', 'v1', 'A-01', 2), task('b', 'v1', 'A-02', 2), task('c', 'v1', 'A-03', 2)]
    const attendants = [
      { id: 'x', villaIds: ['v1'], locationIds: ['l1'], credits: 0 },
      { id: 'y', villaIds: ['v1'], locationIds: ['l1'], credits: 2 },
    ]
    expect(autoAssign(tasks, attendants, 4)).toEqual([
      { taskId: 'a', attendantId: 'x' },
      { taskId: 'b', attendantId: 'x' },
      { taskId: 'c', attendantId: 'y' },
    ])
  })

  it('lets only stayover and turndown take the guest’s answer, and only from the right state', () => {
    expect(assertTaskAction({ status: 'pending', type: 'stayover', number: 'HK-1' }, 'dnd')).toBe('dnd')
    expect(() => assertTaskAction({ status: 'pending', type: 'departure', number: 'HK-1' }, 'dnd')).toThrow(expect.objectContaining({ code: 'TASK_INVALID_STATE' }))
    expect(() => assertTaskAction({ status: 'done', type: 'stayover', number: 'HK-1' }, 'start')).toThrow(expect.objectContaining({ code: 'TASK_INVALID_STATE' }))
    expect(assertTaskAction({ status: 'paused', type: 'deep', number: 'HK-1' }, 'done')).toBe('done')
  })

  it('counts do not disturb days in a row up to today', () => {
    const t = (date: string, status: 'dnd' | 'done') => ({ bookingId: 'b1', type: 'stayover' as const, date, status })
    expect(dndStreak([t('2026-10-02', 'dnd'), t('2026-10-03', 'dnd'), t('2026-10-04', 'dnd')], 'b1', '2026-10-04')).toBe(3)
    expect(dndStreak([t('2026-10-02', 'dnd'), t('2026-10-03', 'done'), t('2026-10-04', 'dnd')], 'b1', '2026-10-04')).toBe(1)
  })

  it('places linen: clean is what is owned less rooms, soiled and laundry, with a shortfall when it runs out', () => {
    const [level] = linenLevels({ itemIds: ['towel'], inUse: () => 16, par: () => 48, owned: () => 40, soiled: () => 10, laundry: () => 20, discarded: () => 2 })
    expect(level).toMatchObject({ clean: 0, short: 6, par: 48, owned: 40 })
    expect(missingOf({ sent: 16, returned: 13, damaged: 1 })).toBe(2)
  })

  it('validates the settings and a laundry return', () => {
    expect(validateHousekeepingSettings(DEFAULT_HOUSEKEEPING_SETTINGS)).toEqual({})
    expect(validateHousekeepingSettings({ ...DEFAULT_HOUSEKEEPING_SETTINGS, dailyQuota: 0 }).dailyQuota).toBeDefined()
    const batch = { sentOn: '2026-10-03', lines: [{ itemId: 'towel', sent: 10, returned: 0, damaged: 0 }] }
    expect(validateLaundryReturn(batch, { returnedOn: '2026-10-04', lines: [{ itemId: 'towel', returned: 9, damaged: 2 }], cost: 0, method: 'cash', reference: '', attachments: [] }).lines).toBe('More came back than was sent.')
  })
})
