/** Pure chart math: tick scales, smooth paths and arcs. No React. */

const NICE_STEPS = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 7.5, 8, 10]

/** Rounds `max` up to a clean top with `count` equal steps: 5900 over 4 -> 0,1500,3000,4500,6000. */
export function niceScale(max: number, count = 4): { top: number; ticks: number[] } {
  if (max <= 0) return { top: count, ticks: Array.from({ length: count + 1 }, (_, i) => i) }
  const raw = max / count
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const step = (NICE_STEPS.find((s) => s * magnitude >= raw) ?? 10) * magnitude
  return { top: step * count, ticks: Array.from({ length: count + 1 }, (_, i) => i * step) }
}

export interface Point {
  x: number
  y: number
}

/**
 * Monotone cubic path (Fritsch-Carlson): smooth like the reference curves,
 * but never overshoots a data point, so a peak on the line is a real peak.
 */
export function smoothPath(points: readonly Point[]): string {
  const n = points.length
  if (n === 0) return ''
  const p = (i: number) => points[i] as Point
  if (n === 1) return `M${p(0).x},${p(0).y}`
  const dx = (i: number) => p(i + 1).x - p(i).x
  const slope = (i: number) => (p(i + 1).y - p(i).y) / dx(i)
  const tangents: number[] = []
  for (let i = 0; i < n; i++) {
    if (i === 0) tangents.push(slope(0))
    else if (i === n - 1) tangents.push(slope(n - 2))
    else {
      const a = slope(i - 1)
      const b = slope(i)
      tangents.push(a * b <= 0 ? 0 : (2 * a * b) / (a + b))
    }
  }
  let d = `M${p(0).x},${p(0).y}`
  for (let i = 0; i < n - 1; i++) {
    const h = dx(i) / 3
    d += ` C${p(i).x + h},${p(i).y + h * (tangents[i] ?? 0)} ${p(i + 1).x - h},${p(i + 1).y - h * (tangents[i + 1] ?? 0)} ${p(i + 1).x},${p(i + 1).y}`
  }
  return d
}

/** Point on a circle; angle 0 is 12 o'clock, clockwise, in turns (0-1). */
export function polar(cx: number, cy: number, r: number, turn: number): Point {
  const a = turn * Math.PI * 2 - Math.PI / 2
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }
}

/** SVG arc path from `start` to `end` turns. */
export function arcPath(cx: number, cy: number, r: number, start: number, end: number): string {
  const a = polar(cx, cy, r, start)
  const b = polar(cx, cy, r, end)
  const large = end - start > 0.5 ? 1 : 0
  return `M${a.x},${a.y} A${r},${r} 0 ${large} 1 ${b.x},${b.y}`
}

/**
 * Splits a ring into segments with a fixed visual gap. Round caps grow each end by
 * half the stroke, so the gap budget includes the stroke width.
 */
export function ringSegments(values: readonly number[], r: number, stroke: number, gapPx: number) {
  const total = values.reduce((s, v) => s + v, 0)
  const circumference = 2 * Math.PI * r
  const gapTurn = (gapPx + stroke) / circumference
  let cursor = 0
  return values.map((v) => {
    const span = total ? v / total : 0
    const start = cursor
    cursor += span
    const inset = Math.min(gapTurn / 2, span / 2)
    return { start: start + inset, end: start + span - inset, mid: start + span / 2, span }
  })
}
