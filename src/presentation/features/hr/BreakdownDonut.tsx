import { useState, type ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { percent } from '@/lib/format'
import { Donut, type DonutSlice } from '../../charts/Donut'

interface BreakdownDonutProps {
  slices: readonly DonutSlice[]
  label: string
  /** Text in the ring: the total by default. */
  centre?: ReactNode
  format?: (value: number) => string
  size?: number
  /** Stack the legend under the ring instead of beside it. */
  stacked?: boolean
  empty?: string
  className?: string
}

/** A donut with its legend rows; hovering or focusing a row lifts the slice. */
export function BreakdownDonut({ slices, label, centre, format = String, size = 160, stacked = false, empty = 'Nothing to show.', className }: BreakdownDonutProps) {
  const [active, setActive] = useState<string | null>(null)
  const total = slices.reduce((s, x) => s + x.value, 0)
  if (total === 0) return <p className="rounded-panel bg-raised px-4 py-6 text-center text-sm text-muted">{empty}</p>
  return (
    <div className={cn('flex flex-col items-center gap-4', !stacked && 'sm:flex-row sm:items-start', className)}>
      <Donut label={label} size={size} slices={slices} active={active} onActive={setActive} chip={(s) => `${s.label}: ${format(s.value)} (${percent(s.value / total, { digits: 0 })})`}>
        <p className="text-[22px] leading-none font-medium tracking-tight tabular">{centre ?? format(total)}</p>
      </Donut>
      <ul className="w-full min-w-0 flex-1 space-y-1">
        {slices.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              onPointerEnter={() => setActive(s.id)}
              onPointerLeave={() => setActive(null)}
              onFocus={() => setActive(s.id)}
              onBlur={() => setActive(null)}
              className={cn('flex w-full cursor-default items-center gap-2.5 rounded-xl px-2 py-1.5 text-left text-sm transition-colors hover:bg-raised', active === s.id && 'bg-raised')}
            >
              <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ background: s.color }} />
              <span className="min-w-0 flex-1 truncate">{s.label}</span>
              <span className="shrink-0 tabular">{format(s.value)}</span>
              <span className="w-10 shrink-0 text-right text-xs text-muted tabular">{percent(s.value / total, { digits: 0 })}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
