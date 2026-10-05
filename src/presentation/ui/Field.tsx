import type { InputHTMLAttributes, ReactNode, Ref, SelectHTMLAttributes } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/cn'

/** `inset` sits inside a card; `card` sits on the canvas and looks like a small card. */
type FieldTone = 'inset' | 'card'

const TONE: Record<FieldTone, string> = {
  inset: 'border border-line-strong bg-raised',
  card: 'border border-line bg-card shadow-card',
}

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  icon?: ReactNode
  /** Trailing slot, usually an icon button (send). */
  trailing?: ReactNode
  tone?: FieldTone
  ref?: Ref<HTMLInputElement>
}

/** Pill input. 16px text on phones so iOS never zooms into the field. */
export function Input({ icon, trailing, tone = 'inset', className, ref, ...props }: InputProps) {
  return (
    <div
      className={cn(
        'flex h-12 items-center gap-2.5 rounded-full px-4 transition-colors focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent',
        TONE[tone],
        trailing ? 'pr-1.5' : undefined,
        className,
      )}
    >
      {icon && <span className="shrink-0 text-muted">{icon}</span>}
      <input
        ref={ref}
        className="h-full min-w-0 flex-1 bg-transparent text-base text-fg outline-none placeholder:text-muted md:text-sm"
        {...props}
      />
      {trailing}
    </div>
  )
}

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  options: ReadonlyArray<{ value: string; label: string }>
  compact?: boolean
  tone?: FieldTone
}

/** Native select dressed as a pill: accessible, and the phone's own picker opens on touch. */
export function Select({ options, compact = false, tone = 'inset', className, ...props }: SelectProps) {
  return (
    <div className={cn('relative inline-flex shrink-0', className)}>
      <select
        className={cn(
          'w-full cursor-pointer appearance-none rounded-full pr-9 font-medium text-fg outline-none hover:bg-control',
          compact ? 'h-8 pl-3 text-xs' : 'h-10 pl-4 text-base md:text-sm',
          TONE[tone],
        )}
        {...props}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown aria-hidden className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted" />
    </div>
  )
}
