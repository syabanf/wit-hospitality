import { cn } from '@/lib/cn'

/** Barcode meter: thin ticks filled up to the score. Healthy reads ink, weak reads WIT red. */
export function ScoreMeter({ score, label, ticks = 44, className }: { score: number; label: string; ticks?: number; className?: string }) {
  const filled = Math.round((Math.max(0, Math.min(100, score)) / 100) * ticks)
  const fill = score >= 70 ? 'bg-fg' : score >= 40 ? 'bg-warning' : 'bg-accent'
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={score}
      className={cn('flex h-7 min-w-0 flex-1 items-center justify-between gap-px', className)}
    >
      {Array.from({ length: ticks }, (_, i) => (
        <span key={i} className={cn('h-full w-[3px] rounded-full', i < filled ? fill : 'bg-control')} />
      ))}
    </div>
  )
}
