import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { cn } from '@/lib/cn'
import { Delta } from './Badge'

interface StatTileProps {
  label: string
  value: ReactNode
  /** Relative change against the previous period. */
  change?: number | null
  goodWhenUp?: boolean
  hint?: ReactNode
  /** A tile links to its metric... */
  to?: string
  /** ...or applies a filter in place. */
  onClick?: () => void
  active?: boolean
  className?: string
}

const base = 'block min-w-0 rounded-card border p-5 text-left shadow-card transition-colors'

/** Clickable statistic: a link to the metric's page or an in-place filter (`aria-pressed`). */
export function StatTile({ label, value, change, goodWhenUp = true, hint, to, onClick, active = false, className }: StatTileProps) {
  const body = (
    <>
      <p className="text-sm text-muted">{label}</p>
      <div className="mt-3 flex flex-wrap items-end gap-x-2 gap-y-1">
        <p className="min-w-0 text-[28px] leading-none font-medium tracking-tight break-words tabular">{value}</p>
        {change !== undefined && <Delta value={change} goodWhenUp={goodWhenUp} variant="text" className="mb-0.5" />}
      </div>
      {hint && <p className="mt-2 text-xs text-muted">{hint}</p>}
    </>
  )
  const look = cn(base, active ? 'border-fg bg-raised' : 'border-line bg-card hover:bg-raised', className)
  if (to) {
    return (
      <Link to={to} className={look}>
        {body}
      </Link>
    )
  }
  return (
    <button type="button" aria-pressed={active} onClick={onClick} className={cn(look, 'w-full cursor-pointer active:scale-[0.99]')}>
      {body}
    </button>
  )
}
