import { describe, expect, it } from 'vitest'
import { buckets, change, periodRange } from './dashboard'

describe('dashboard periods', () => {
  it('ends the current range tomorrow and compares with the same length before it', () => {
    expect(periodRange('7d', '2026-10-05')).toEqual({
      current: { from: '2026-09-29', to: '2026-10-06' },
      previous: { from: '2026-09-22', to: '2026-09-29' },
    })
  })

  it('buckets a week by day and a month by week, the last bucket cut at the range end', () => {
    const { current } = periodRange('30d', '2026-10-05')
    const weeks = buckets(current, '30d')
    expect(weeks).toHaveLength(5)
    expect(weeks.at(-1)).toMatchObject({ from: '2026-09-29', to: '2026-10-06' })
    expect(weeks[0]).toMatchObject({ from: '2026-09-06', to: '2026-09-08' })
    expect(buckets(periodRange('7d', '2026-10-05').current, '7d').map((b) => b.label)).toEqual(['Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun', 'Mon'])
  })

  it('takes a custom range and compares with the same length before it', () => {
    expect(periodRange('30d', '2026-10-05', { from: '2026-09-01', to: '2026-09-10' })).toEqual({
      current: { from: '2026-09-01', to: '2026-09-11' },
      previous: { from: '2026-08-22', to: '2026-09-01' },
    })
    expect(buckets({ from: '2026-09-01', to: '2026-09-11' }, '30d')).toHaveLength(10)
  })

  it('has no change against nothing', () => {
    expect(change(10, 0)).toBeNull()
    expect(change(12, 10)).toBeCloseTo(0.2)
  })
})
