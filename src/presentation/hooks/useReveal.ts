import { useEffect, useRef, useState } from 'react'
import { reducedMotion } from './motion'

/**
 * True once the element has scrolled into view, and from then on. Shown at once without
 * IntersectionObserver or under reduced motion. Spread `{ 'data-reveal': kind, 'data-shown': shown }`
 * on the element and the site styles animate it.
 */
export function useReveal<T extends Element>({ threshold = 0.18, rootMargin = '0px 0px -8% 0px' } = {}) {
  const ref = useRef<T>(null)
  const [shown, setShown] = useState(() => reducedMotion() || typeof IntersectionObserver === 'undefined')
  useEffect(() => {
    const el = ref.current
    if (!el || shown) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return
        setShown(true)
        observer.disconnect()
      },
      { threshold, rootMargin },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [threshold, rootMargin, shown])
  return [ref, shown] as const
}
