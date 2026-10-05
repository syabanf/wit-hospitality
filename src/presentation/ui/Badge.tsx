import type { ReactNode } from 'react'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { cn } from '@/lib/cn'
import { percent } from '@/lib/format'

export type Tone = 'neutral' | 'accent' | 'info' | 'success' | 'warning' | 'danger'

const DOT: Record<Tone, string> = {
  neutral: 'bg-subtle',
  accent: 'bg-accent',
  info: 'bg-info',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
}

/** Soft tint with the tone as text; every pair passes AA in both themes. */
const SOFT: Record<Tone, string> = {
  neutral: 'bg-control text-fg',
  accent: 'bg-accent-soft text-accent-text',
  info: 'bg-info-soft text-info-text',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
}

export function Dot({ tone, className }: { tone: Tone; className?: string }) {
  return <span aria-hidden className={cn('inline-block size-2 shrink-0 rounded-full', DOT[tone], className)} />
}

/** Neutral pill with a coloured dot: record status in lists ("Unpaid", "Paid"). */
export function StatusPill({ tone, children, className }: { tone: Tone; children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-full border border-line-strong bg-raised px-2.5 text-xs font-medium whitespace-nowrap text-fg',
        className,
      )}
    >
      <Dot tone={tone} />
      {children}
    </span>
  )
}

/** Small tag beside a number ("Stable", "Processed"). */
export function Tag({ tone, children, className }: { tone: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex h-5 items-center rounded-md px-1.5 text-[11px] font-semibold', SOFT[tone], className)}>
      {children}
    </span>
  )
}

/** Signed change. `goodWhenUp` flips the colour for costs, where a rise is bad. */
export function Delta({
  value,
  goodWhenUp = true,
  className,
  variant = 'chip',
}: {
  value: number | null
  goodWhenUp?: boolean
  className?: string
  variant?: 'chip' | 'text'
}) {
  if (value === null) return null
  const up = value >= 0
  const tone: Tone = up === goodWhenUp ? 'success' : 'danger'
  const Icon = up ? ArrowUp : ArrowDown
  return (
    <span
      aria-label={`${up ? 'up' : 'down'} ${percent(Math.abs(value))}`}
      className={cn(
        'inline-flex items-center gap-0.5 text-xs font-semibold tabular',
        variant === 'chip' ? cn('h-6 rounded-full px-2', SOFT[tone]) : tone === 'success' ? 'text-success' : 'text-danger',
        className,
      )}
    >
      <Icon aria-hidden className="size-3" strokeWidth={3} />
      {percent(Math.abs(value))}
    </span>
  )
}
