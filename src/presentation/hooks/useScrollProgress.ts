import { useEffect, useRef } from 'react'
import { reducedMotion, viewportProgress } from './motion'

/**
 * Writes the element's progress across the viewport (0 to 1) to its `--p` custom property on each
 * animation frame that follows a scroll, without re-rendering. CSS turns it into a slight parallax.
 * Does nothing under reduced motion.
 */
export function useScrollProgress<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  useEffect(() => {
    const el = ref.current
    if (!el || reducedMotion()) return
    let frame = 0
    const update = () => {
      frame = 0
      const box = el.getBoundingClientRect()
      el.style.setProperty('--p', viewportProgress(box.top, box.height, window.innerHeight).toFixed(3))
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update)
    }
    update()
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    return () => {
      window.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [])
  return ref
}
