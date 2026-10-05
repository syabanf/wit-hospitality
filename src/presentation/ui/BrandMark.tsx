import { cn } from '@/lib/cn'

/**
 * The product mark: one half in the current text colour, one half WIT red.
 * Set the text colour from the surface (white on the ink rail, fg on the canvas).
 * Swap the paths for a client logo; keep the 32px box.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" role="img" aria-label="WIT Console" className={cn('size-8', className)}>
      <path d="M5 8l10 8-10 8z" className="fill-current" />
      <path d="M27 8l-10 8 10 8z" className="fill-accent" />
    </svg>
  )
}
