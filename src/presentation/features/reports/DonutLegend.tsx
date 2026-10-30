import { useState, type ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { Donut, type DonutSlice } from '../../charts/Donut'

interface DonutLegendProps {
  slices: readonly DonutSlice[]
  format: (value: number) => string
  /** Centre text: the total by default. */
  centre?: ReactNode
  /** Clicking a legend row; the row reads pressed while `picked` matches it. */
  onPick?: (id: string) => void
  picked?: string | null
  size?: number
  label: string
  className?: string
}

/** A donut beside its legend; hovering either side lifts the slice. */
export function DonutLegend({ slices, format, centre, onPick, picked = null, size = 170, label, className }: DonutLegendProps) {
  const [active, setActive] = useState<string | null>(null)
  const total = slices.reduce((s, x) => s + x.value, 0)
  if (slices.length === 0 || total === 0) return <p className="rounded-panel bg-raised px-4 py-6 text-center text-sm text-muted">Nothing to draw yet.</p>
  return (
    <div className={cn('flex flex-col items-center gap-5 sm:flex-row sm:items-start', className)}>
      <Donut label={label} size={size} slices={slices} active={active} onActive={setActive} chip={(s) => `${s.label}: ${format(s.value)} (${Math.round((s.value / total) * 100)}%)`}>
        {centre ?? (
          <>
            <p className="text-[22px] leading-none font-medium tracking-tight tabular">{format(total)}</p>
            <p className="mt-1 text-xs text-muted">total</p>
          </>
        )}
      </Donut>
      <ul className="w-full min-w-0 space-y-1 stagger">
        {slices.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              aria-pressed={onPick ? picked === s.id : undefined}
              onClick={() => onPick?.(s.id)}
              onPointerEnter={() => setActive(s.id)}
              onPointerLeave={() => setActive(null)}
              onFocus={() => setActive(s.id)}
              onBlur={() => setActive(null)}
              className={cn('flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left text-sm transition-colors hover:bg-raised', (active === s.id || picked === s.id) && 'bg-raised', !onPick && 'cursor-default')}
            >
              <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ background: s.color }} />
              <span className="min-w-0 flex-1 truncate">{s.label}</span>
              <span className="shrink-0 font-medium tabular">{format(s.value)}</span>
              <span className="w-10 shrink-0 text-right text-xs text-muted tabular">{Math.round((s.value / total) * 100)}%</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
