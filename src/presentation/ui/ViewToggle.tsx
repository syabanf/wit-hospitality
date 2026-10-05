import { LayoutGrid, Table2 } from 'lucide-react'
import { cn } from '@/lib/cn'
import type { Layout } from '../hooks/useLayout'

const OPTIONS: ReadonlyArray<{ value: Layout; label: string; icon: typeof LayoutGrid }> = [
  { value: 'cards', label: 'Cards', icon: LayoutGrid },
  { value: 'table', label: 'Table', icon: Table2 },
]

/** Pill switch between the card layout and the table layout of a page. */
export function ViewToggle({ value, onChange, className, cardsLabel = 'Cards' }: { value: Layout; onChange: (layout: Layout) => void; className?: string; cardsLabel?: string }) {
  return (
    <div role="group" aria-label="Layout" className={cn('inline-flex shrink-0 items-center gap-0.5 rounded-full border border-line-strong bg-raised p-1', className)}>
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'flex h-8 cursor-pointer items-center gap-1.5 rounded-full px-3 text-sm whitespace-nowrap transition-colors',
            value === o.value ? 'bg-invert font-medium text-on-invert' : 'text-muted hover:text-fg',
          )}
        >
          <o.icon aria-hidden className="size-4" />
          {o.value === 'cards' ? cardsLabel : o.label}
        </button>
      ))}
    </div>
  )
}
