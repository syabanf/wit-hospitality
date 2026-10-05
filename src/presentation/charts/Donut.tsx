import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { arcPath, polar, ringSegments } from './geometry'

export interface DonutSlice {
  id: string
  label: string
  value: number
  /** A CSS colour, normally `var(--color-series-N)`. */
  color: string
}

interface DonutProps {
  slices: readonly DonutSlice[]
  active: string | null
  onActive: (id: string | null) => void
  /** Text of the chip that floats beside the active slice. */
  chip?: (slice: DonutSlice) => ReactNode
  children?: ReactNode
  size?: number
  stroke?: number
  className?: string
  label: string
}

/**
 * Ring of rounded segments separated by a surface gap. Hovering a segment (or focusing
 * its legend row, which the caller wires to `onActive`) lifts it and shows a chip.
 */
export function Donut({ slices, active, onActive, chip, children, size = 200, stroke = 24, className, label }: DonutProps) {
  const c = size / 2
  const r = c - stroke / 2 - 4
  const segments = ringSegments(
    slices.map((s) => s.value),
    r,
    stroke,
    4,
  )
  const activeIndex = slices.findIndex((s) => s.id === active)
  const activeSlice = slices[activeIndex]
  const activeSegment = segments[activeIndex]
  const chipAt = activeSegment && polar(c, c, r + stroke / 2 + 8, activeSegment.mid)

  return (
    <div className={cn('relative mx-auto aspect-square w-full', className)} style={{ maxWidth: size }}>
      <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} className="size-full overflow-visible">
        {segments.map((seg, i) => {
          const slice = slices[i]
          if (!slice || seg.end <= seg.start) return null
          const isActive = slice.id === active
          return (
            <path
              key={slice.id}
              d={arcPath(c, c, r, seg.start, seg.end)}
              fill="none"
              stroke={slice.color}
              strokeWidth={isActive ? stroke + 6 : stroke}
              strokeLinecap="round"
              opacity={active && !isActive ? 0.45 : 1}
              className="cursor-pointer transition-[opacity,stroke-width] duration-200"
              onPointerEnter={() => onActive(slice.id)}
              onPointerLeave={() => onActive(null)}
            />
          )
        })}
      </svg>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">{children}</div>
      {chip && activeSlice && chipAt && (
        <span
          className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-1/2 animate-fade rounded-lg border border-line-strong bg-card px-2 py-1 text-[11px] font-semibold whitespace-nowrap text-fg shadow-float tabular"
          style={{ left: `${(chipAt.x / size) * 100}%`, top: `${(chipAt.y / size) * 100}%` }}
        >
          <span aria-hidden className="mr-1 inline-block size-1.5 rounded-full align-middle" style={{ background: activeSlice.color }} />
          {chip(activeSlice)}
        </span>
      )}
    </div>
  )
}
