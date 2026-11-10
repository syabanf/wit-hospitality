import { useEffect, useState } from 'react'
import { countAt, reducedMotion } from './motion'

/** Counts from zero to `target` once `run` turns true; lands on the target at once under reduced motion. */
export function useCountUp(target: number, run: boolean, { duration = 1600, step = 1 } = {}) {
  const [value, setValue] = useState(0)
  const instant = reducedMotion() || typeof requestAnimationFrame === 'undefined'
  useEffect(() => {
    if (!run || instant) return
    let start: number | null = null
    let frame = requestAnimationFrame(function tick(now) {
      start ??= now
      const elapsed = now - start
      setValue(countAt(target, elapsed, duration, step))
      if (elapsed < duration) frame = requestAnimationFrame(tick)
    })
    return () => cancelAnimationFrame(frame)
  }, [target, run, duration, step, instant])
  return instant && run ? target : value
}
