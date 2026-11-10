/** The pure parts of the scroll and count animations, so they test without a browser. */

const clamp = (v: number, min = 0, max = 1) => Math.min(max, Math.max(min, v))

/** Fast start, soft landing. */
export const easeOutCubic = (t: number) => 1 - (1 - clamp(t)) ** 3

/** What a count-up shows `elapsed` ms into `duration`: eased, rounded down to `step`, exact at the end. */
export function countAt(target: number, elapsed: number, duration: number, step = 1): number {
  if (duration <= 0 || elapsed >= duration) return target
  const value = target * easeOutCubic(elapsed / duration)
  return Math.floor(value / step) * step
}

/**
 * How far a box has crossed the viewport: 0 while its top is at the bottom edge, 1 once its bottom
 * passes the top edge. `top` is its distance from the viewport top, as getBoundingClientRect gives it.
 */
export const viewportProgress = (top: number, height: number, viewport: number) => (viewport + height > 0 ? clamp((viewport - top) / (viewport + height)) : 0)

/**
 * The clip edges of each panel in a row where the open one takes `openShare` of the width and the
 * rest split what is left. Percent of the row: `left` from the left edge, `right` from the right.
 */
export function panelEdges(count: number, open: number, openShare = 0.6): Array<{ left: number; right: number }> {
  if (count <= 0) return []
  const rest = count > 1 ? (1 - openShare) / (count - 1) : 0
  const widths = Array.from({ length: count }, (_, i) => (count === 1 ? 1 : i === open ? openShare : rest))
  let start = 0
  return widths.map((w) => {
    const edge = { left: round(start * 100), right: round((1 - start - w) * 100) }
    start += w
    return edge
  })
}
const round = (v: number) => Math.max(0, Math.round(v * 100) / 100)

export const reducedMotion = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
