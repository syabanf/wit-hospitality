import { describe, expect, it } from 'vitest'
import { countAt, easeOutCubic, panelEdges, viewportProgress } from './motion'

describe('motion helpers', () => {
  it('eases from 0 to 1 and clamps outside', () => {
    expect(easeOutCubic(0)).toBe(0)
    expect(easeOutCubic(1)).toBe(1)
    expect(easeOutCubic(2)).toBe(1)
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5)
  })

  it('counts up in steps and lands on the target', () => {
    expect(countAt(3_200_000, 0, 1600, 10_000)).toBe(0)
    const mid = countAt(3_200_000, 800, 1600, 10_000)
    expect(mid % 10_000).toBe(0)
    expect(mid).toBeGreaterThan(1_600_000)
    expect(countAt(3_215_000, 1600, 1600, 10_000)).toBe(3_215_000)
    expect(countAt(7, 10, 0)).toBe(7)
  })

  it('reads progress across the viewport', () => {
    expect(viewportProgress(800, 400, 800)).toBe(0)
    expect(viewportProgress(-400, 400, 800)).toBe(1)
    expect(viewportProgress(200, 400, 800)).toBe(0.5)
    expect(viewportProgress(-2000, 400, 800)).toBe(1)
  })

  it('splits a row so the open panel takes its share and the edges meet', () => {
    const edges = panelEdges(5, 2)
    expect(edges[0]).toEqual({ left: 0, right: 90 })
    expect(edges[2]).toEqual({ left: 20, right: 20 })
    expect(edges[4]).toEqual({ left: 90, right: 0 })
    for (let i = 1; i < edges.length; i++) expect((edges[i]?.left ?? 0) + (edges[i - 1]?.right ?? 0)).toBeCloseTo(100)
    expect(panelEdges(1, 0)).toEqual([{ left: 0, right: 0 }])
  })
})
