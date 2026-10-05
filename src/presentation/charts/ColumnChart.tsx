import { useRef, type KeyboardEvent, type ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { niceScale } from './geometry'

export interface ColumnDatum {
  key: string
  label: string
  value: number
  /** Drawn as a short cap line; omitted when the series has no target. */
  target?: number
}

interface ColumnChartProps {
  data: readonly ColumnDatum[]
  selected: string | null
  onSelect: (key: string) => void
  format: (value: number) => string
  /** Axis tick text; defaults to the plain number. */
  tick?: (value: number) => string
  /** Chip on top of the selected column, usually its change against the column before. */
  badge?: (datum: ColumnDatum, index: number) => ReactNode
  showTargets?: boolean
  showAxis?: boolean
  /** `card` on a card; `pop` on a pop surface, where marks take white and ink. */
  surface?: 'card' | 'pop'
  className?: string
  label: string
}

/**
 * Hatched capsule columns with one selected column in the accent.
 * Each column is a radio button: click or arrow keys move the selection.
 */
export function ColumnChart({
  data,
  selected,
  onSelect,
  format,
  tick = (v) => v.toLocaleString('en-US'),
  badge,
  showTargets = false,
  showAxis = true,
  surface = 'card',
  className,
  label,
}: ColumnChartProps) {
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const max = Math.max(0, ...data.map((d) => Math.max(d.value, showTargets ? (d.target ?? 0) : 0)))
  const { top, ticks } = niceScale(max)
  const pct = (v: number) => `${Math.max(0, Math.min(100, (v / top) * 100))}%`
  const onCard = surface === 'card'

  function onKeyDown(e: KeyboardEvent, index: number) {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    if (!step) return
    e.preventDefault()
    const next = Math.max(0, Math.min(data.length - 1, index + step))
    const datum = data[next]
    if (!datum) return
    onSelect(datum.key)
    refs.current[next]?.focus()
  }

  return (
    <figure className={cn('flex flex-col', className)}>
      <div className="flex min-h-0 flex-1 gap-3">
        {showAxis && (
          <div aria-hidden className={cn('relative w-14 shrink-0 text-right text-[11px] tabular', onCard ? 'text-subtle' : 'opacity-60')}>
            {ticks.map((t) => (
              <span key={t} className="absolute right-0 translate-y-1/2" style={{ bottom: pct(t) }}>
                {tick(t)}
              </span>
            ))}
          </div>
        )}
        <div role="radiogroup" aria-label={label} className="flex min-w-0 flex-1 items-end gap-1.5 sm:gap-2.5">
          {data.map((d, i) => {
            const active = d.key === selected
            const tall = d.value / top > 0.22
            return (
              <button
                key={d.key}
                ref={(el) => {
                  refs.current[i] = el
                }}
                type="button"
                role="radio"
                aria-checked={active}
                aria-label={`${d.label}: ${format(d.value)}${d.target !== undefined && showTargets ? `, target ${format(d.target)}` : ''}`}
                tabIndex={active || (selected === null && i === 0) ? 0 : -1}
                onClick={() => onSelect(d.key)}
                onKeyDown={(e) => onKeyDown(e, i)}
                className="group relative flex h-full min-w-0 flex-1 cursor-pointer items-end justify-center outline-none"
              >
                <span
                  className={cn(
                    'relative flex w-full max-w-14 flex-col items-center justify-between rounded-[14px] transition-[height,background-color] duration-300 group-focus-visible:outline-2 group-focus-visible:outline-offset-2 group-focus-visible:outline-accent',
                    onCard &&
                      (active
                        ? 'bg-linear-to-b from-accent to-accent-strong shadow-glow'
                        : 'hatch border border-line-strong bg-raised group-hover:bg-control'),
                    !onCard && (active ? 'bg-white' : 'hatch bg-white/30 group-hover:bg-white/45'),
                  )}
                  style={{ height: `max(${pct(d.value)}, 12px)` }}
                >
                  {active && badge && (
                    <span
                      className={cn(
                        'mt-1.5 max-w-full truncate rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular',
                        onCard ? 'bg-white/90 text-ink' : 'bg-ink text-white',
                      )}
                    >
                      {badge(d, i)}
                    </span>
                  )}
                  {active && tall && onCard && (
                    <span className="mb-2 hidden px-1 text-xs font-semibold text-white tabular sm:block">{format(d.value)}</span>
                  )}
                </span>
                {active && !onCard && (
                  <span
                    className="pointer-events-none absolute left-1/2 z-10 -translate-x-1/2 -translate-y-2 rounded-lg bg-ink px-2 py-1 text-xs font-semibold whitespace-nowrap text-white tabular"
                    style={{ bottom: pct(d.value) }}
                  >
                    {format(d.value)}
                  </span>
                )}
                {showTargets && d.target !== undefined && !active && (
                  <span
                    aria-hidden
                    className={cn(
                      'pointer-events-none absolute left-1/2 h-[3px] w-[40%] max-w-6 -translate-x-1/2 translate-y-1/2 rounded-full',
                      onCard ? 'bg-fg/85' : 'bg-ink/70',
                    )}
                    style={{ bottom: pct(d.target) }}
                  />
                )}
                {!active && (
                  <span
                    aria-hidden
                    className="pointer-events-none absolute left-1/2 z-10 -translate-x-1/2 -translate-y-2 rounded-lg bg-invert px-2 py-1 text-xs font-semibold whitespace-nowrap text-on-invert opacity-0 shadow-float transition-opacity group-hover:opacity-100"
                    style={{ bottom: pct(d.value) }}
                  >
                    {format(d.value)}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </div>
      <div aria-hidden className={cn('mt-3 flex gap-1.5 sm:gap-2.5', showAxis && 'pl-[68px]')}>
        {data.map((d) => (
          <span
            key={d.key}
            className={cn(
              'min-w-0 flex-1 truncate text-center text-xs sm:text-sm',
              onCard && (d.key === selected ? 'font-medium text-fg' : 'text-muted'),
              !onCard && (d.key === selected ? 'mx-auto max-w-12 rounded-full bg-ink py-0.5 text-white' : 'opacity-75'),
            )}
          >
            {d.label}
          </span>
        ))}
      </div>
    </figure>
  )
}
