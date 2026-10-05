import { describe, expect, it } from 'vitest'
import { niceScale, ringSegments, smoothPath } from './geometry'

describe('chart geometry', () => {
  it('picks clean ticks', () => {
    expect(niceScale(5900)).toEqual({ top: 6000, ticks: [0, 1500, 3000, 4500, 6000] })
    expect(niceScale(210, 4).top).toBe(240)
    expect(niceScale(0).ticks).toHaveLength(5)
  })

  it('draws a path through every point', () => {
    const d = smoothPath([
      { x: 0, y: 10 },
      { x: 10, y: 0 },
      { x: 20, y: 10 },
    ])
    expect(d.startsWith('M0,10')).toBe(true)
    expect(d.endsWith('20,10')).toBe(true)
    expect(smoothPath([])).toBe('')
  })

  it('keeps segments in order with a gap between them', () => {
    const [a, b] = ringSegments([1, 1], 50, 10, 4)
    expect(a?.start).toBeGreaterThan(0)
    expect(a?.end).toBeLessThan(0.5)
    expect(b?.start).toBeGreaterThan(0.5)
    expect(a?.mid).toBe(0.25)
  })
})
