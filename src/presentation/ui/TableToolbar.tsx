import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from './Button'

export interface Chip<T extends string> {
  value: T
  label: string
  count?: number
}

interface TableToolbarProps<T extends string> {
  /** Status chips with counts; the first one is usually "All". */
  chips?: readonly Chip<T>[]
  chip?: T
  onChip?: (value: T) => void
  chipLabel?: string
  /** The search field, rendered first on the second row and allowed to grow. */
  search?: ReactNode
  /** Selects and other controls, each 40px tall. */
  filters?: ReactNode
  /** The date range control, kept on its own at the end of the row. */
  date?: ReactNode
  /** Shown when any filter is active. */
  active?: boolean
  onClear?: () => void
  /** "12 of 383 bookings". */
  summary?: ReactNode
}

/**
 * The toolbar above every table: chips with the result count on the first row,
 * search, selects and the date range on the second, one Clear all at the end.
 */
export function TableToolbar<T extends string>({ chips, chip, onChip, chipLabel = 'Filter by status', search, filters, date, active = false, onClear, summary }: TableToolbarProps<T>) {
  return (
    <div className="space-y-3 border-b border-line p-4">
      {(chips || summary) && (
        <div className="flex items-center gap-3">
          {chips && (
            <div role="group" aria-label={chipLabel} className="no-scrollbar -mx-1 flex min-w-0 flex-1 gap-1.5 overflow-x-auto px-1 py-0.5">
              {chips.map((c) => (
                <Button key={c.value} size="sm" variant={chip === c.value ? 'solid' : 'soft'} aria-pressed={chip === c.value} onClick={() => onChip?.(c.value)}>
                  {c.label}
                  {c.count !== undefined && <span className={cn('tabular', chip === c.value ? 'opacity-60' : 'text-muted')}>{c.count}</span>}
                </Button>
              ))}
            </div>
          )}
          {summary && <p className="shrink-0 text-xs text-muted tabular">{summary}</p>}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {search && <div className="min-w-56 flex-1 basis-64">{search}</div>}
        {filters}
        {date}
        {active && onClear && (
          <Button variant="ghost" size="sm" onClick={onClear}>
            <X aria-hidden className="size-3.5" /> Clear all
          </Button>
        )}
      </div>
    </div>
  )
}
