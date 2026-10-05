import { useState, type KeyboardEvent, type PointerEvent } from 'react'
import { cn } from '@/lib/cn'
import { useSize } from '../hooks/useSize'
import { niceScale, smoothPath } from './geometry'

export interface LineSeries {
  id: string
  label: string
  values: readonly number[]
  /** A CSS colour, normally `var(--color-series-N)`. */
  color: string
  /** Draws a 10% wash under the line. Give it to one series at most. */
  area?: boolean
  /** Thin, undotted context line beside the emphasised one. */
  muted?: boolean
}

interface LineChartProps {
  labels: readonly string[]
  series: readonly LineSeries[]
  format: (value: number) => string
  /** Axis tick text; defaults to the plain number. */
  tick?: (value: number) => string
  height?: number
  /** Fixed scale top; defaults to a clean value above the data. */
  max?: number
  /** `pop` draws the grid and text in the surface's own text colour. */
  surface?: 'card' | 'pop'
  /** Colour of the 2px ring around each dot: the surface the chart sits on. */
  ring?: string
  label: string
  className?: string
}

const PAD = { top: 12, right: 10, bottom: 28, left: 40 }

/** Smooth lines with dots, hairline grid, and a crosshair tooltip on hover or arrow keys. */
export function LineChart({
  labels,
  series,
  format,
  tick = String,
  height = 240,
  max,
  surface = 'card',
  ring = 'var(--color-card)',
  label,
  className,
}: LineChartProps) {
  const [ref, { width }] = useSize<HTMLDivElement>()
  const [index, setIndex] = useState<number | null>(null)
  const onCard = surface === 'card'

  const dataMax = Math.max(0, ...series.flatMap((s) => s.values))
  const { top, ticks } = max === undefined ? niceScale(dataMax) : niceScale(max)
  const plotW = Math.max(0, width - PAD.left - PAD.right)
  const plotH = height - PAD.top - PAD.bottom
  const stepX = labels.length > 1 ? plotW / (labels.length - 1) : 0
  const x = (i: number) => PAD.left + i * stepX
  const y = (v: number) => PAD.top + (1 - v / top) * plotH
  const baseline = PAD.top + plotH

  function onPointerMove(e: PointerEvent<SVGRectElement>) {
    const box = e.currentTarget.getBoundingClientRect()
    const i = Math.round((e.clientX - box.left) / (stepX || 1))
    setIndex(Math.max(0, Math.min(labels.length - 1, i)))
  }

  function onKeyDown(e: KeyboardEvent) {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    if (!step) return
    e.preventDefault()
    setIndex((i) => Math.max(0, Math.min(labels.length - 1, (i ?? -1) + step)))
  }

  const tipLeft = index === null ? 0 : x(index)
  const describe = (i: number) =>
    `${labels[i]}: ${series.map((s) => `${s.label} ${format(s.values[i] ?? 0)}`).join(', ')}`

  return (
    <div ref={ref} className={cn('relative w-full', className)} style={{ height }}>
      {width > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={label}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onBlur={() => setIndex(null)}
          className="block overflow-visible rounded-lg outline-none focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
        >
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={PAD.left}
                x2={width - PAD.right}
                y1={y(t)}
                y2={y(t)}
                className={onCard ? 'stroke-line' : 'stroke-current'}
                strokeOpacity={onCard ? 1 : 0.2}
                strokeWidth={1}
              />
              <text
                x={PAD.left - 10}
                y={y(t)}
                dy="0.32em"
                textAnchor="end"
                className={cn('text-[11px] tabular', onCard ? 'fill-subtle' : 'fill-current opacity-60')}
              >
                {tick(t)}
              </text>
            </g>
          ))}
          {labels.map((l, i) => (
            <text
              key={l}
              x={x(i)}
              y={height - 6}
              textAnchor="middle"
              className={cn('text-[11px]', onCard ? (i === index ? 'fill-fg' : 'fill-subtle') : 'fill-current opacity-70')}
            >
              {l}
            </text>
          ))}
          {index !== null && (
            <line
              x1={x(index)}
              x2={x(index)}
              y1={PAD.top}
              y2={baseline}
              className={onCard ? 'stroke-line-strong' : 'stroke-current'}
              strokeOpacity={onCard ? 1 : 0.35}
              strokeWidth={1}
            />
          )}
          {series.map((s) => {
            const pts = s.values.map((v, i) => ({ x: x(i), y: y(v) }))
            const d = smoothPath(pts)
            const last = pts.at(-1)
            return (
              <g key={s.id}>
                {s.area && last && (
                  <path d={`${d} L${last.x},${baseline} L${PAD.left},${baseline} Z`} fill={s.color} opacity={0.1} />
                )}
                <path
                  d={d}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={s.muted ? 1.5 : 2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  opacity={s.muted ? 0.6 : 1}
                />
                {!s.muted &&
                  pts.map((p, i) => (
                    <circle
                      key={i}
                      cx={p.x}
                      cy={p.y}
                      r={i === index ? 6 : 4}
                      fill={s.color}
                      stroke={ring}
                      strokeWidth={2}
                    />
                  ))}
              </g>
            )
          })}
          <rect
            x={PAD.left - stepX / 2}
            y={0}
            width={plotW + stepX}
            height={height}
            fill="transparent"
            onPointerMove={onPointerMove}
            onPointerLeave={() => setIndex(null)}
          />
        </svg>
      )}
      {index !== null && (
        <div
          aria-hidden
          className="pointer-events-none absolute top-0 z-10 min-w-28 -translate-x-1/2 rounded-xl border border-line-strong bg-card px-3 py-2 text-xs shadow-float"
          style={{ left: Math.max(60, Math.min(width - 60, tipLeft)) }}
        >
          <p className="mb-1 font-semibold text-fg">{labels[index]}</p>
          {series.map((s) => (
            <p key={s.id} className="flex items-center justify-between gap-3 text-muted">
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-0.5 w-3 rounded-full" style={{ background: s.color }} />
                {s.label}
              </span>
              <span className="font-semibold text-fg tabular">{format(s.values[index] ?? 0)}</span>
            </p>
          ))}
        </div>
      )}
      <p aria-live="polite" className="sr-only">
        {index === null ? '' : describe(index)}
      </p>
    </div>
  )
}
