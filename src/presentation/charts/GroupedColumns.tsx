import { cn } from '@/lib/cn'
import { niceScale } from './geometry'

export interface GroupSeries {
  id: string
  label: string
  color: string
}

interface GroupedColumnsProps {
  labels: readonly string[]
  series: readonly GroupSeries[]
  /** values[seriesIndex][labelIndex] */
  values: ReadonlyArray<readonly number[]>
  format: (value: number) => string
  className?: string
  label: string
}

/** Thin paired columns (<= 12px each, 2px surface gap, 4px rounded tip) with a tooltip per group. */
export function GroupedColumns({ labels, series, values, format, className, label }: GroupedColumnsProps) {
  const { top, ticks } = niceScale(Math.max(0, ...values.flat()))
  const pct = (v: number) => `${(v / top) * 100}%`

  return (
    <figure aria-label={label} className={cn('flex flex-col', className)}>
      <div className="relative flex min-h-0 flex-1 gap-3">
        <div aria-hidden className="relative w-12 shrink-0 text-right text-xs text-subtle tabular">
          {ticks.map((t) => (
            <span key={t} className="absolute right-0 translate-y-1/2" style={{ bottom: pct(t) }}>
              {format(t)}
            </span>
          ))}
        </div>
        <div className="relative flex min-w-0 flex-1 items-end">
          {ticks.map((t) => (
            <span aria-hidden key={t} className="absolute inset-x-0 h-px bg-line" style={{ bottom: pct(t) }} />
          ))}
          {labels.map((l, i) => (
            <div
              key={l}
              tabIndex={0}
              aria-label={`${l}: ${series.map((s, si) => `${s.label} ${format(values[si]?.[i] ?? 0)}`).join(', ')}`}
              className="group relative flex h-full min-w-0 flex-1 cursor-default items-end justify-center gap-0.5 rounded-lg outline-none hover:bg-raised focus-visible:bg-raised"
            >
              {series.map((s, si) => (
                <span
                  key={s.id}
                  className="relative w-full max-w-3 rounded-t-[4px] transition-[height] duration-300"
                  style={{ height: pct(values[si]?.[i] ?? 0), background: s.color }}
                />
              ))}
              <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 rounded-xl border border-line-strong bg-card px-3 py-2 text-xs whitespace-nowrap shadow-float group-hover:block group-focus-visible:block">
                <p className="mb-1 font-semibold">{l}</p>
                {series.map((s, si) => (
                  <p key={s.id} className="flex items-center justify-between gap-4 text-muted">
                    <span className="flex items-center gap-1.5">
                      <span className="size-2 rounded-full" style={{ background: s.color }} />
                      {s.label}
                    </span>
                    <span className="font-semibold text-fg tabular">{format(values[si]?.[i] ?? 0)}</span>
                  </p>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div aria-hidden className="mt-3 flex gap-0 pl-[60px]">
        {labels.map((l) => (
          <span key={l} className="min-w-0 flex-1 truncate text-center text-xs text-muted">
            {l}
          </span>
        ))}
      </div>
    </figure>
  )
}
