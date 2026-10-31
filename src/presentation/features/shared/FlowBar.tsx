import { Link } from 'react-router'
import { Check, X } from 'lucide-react'
import type { FlowRef, FlowStep } from '@/domain/flow'
import { cn } from '@/lib/cn'

const ROUTE: Record<FlowRef['kind'], (id: string) => string> = {
  booking: (id) => `/bookings/${id}`,
  transaction: (id) => `/finance/transactions/${id}`,
  workOrder: (id) => `/maintenance/work-orders/${id}`,
  payroll: (id) => `/payroll/${id}`,
  unit: (id) => `/property/units/${id}`,
}

const DOT: Record<FlowStep['state'], string> = {
  done: 'bg-success-soft text-success',
  current: 'bg-invert text-on-invert',
  upcoming: 'bg-raised text-subtle ring-1 ring-line-strong',
  blocked: 'bg-accent-strong text-white',
}

/** One line across the top of a record page: where it sits in its flow, each step linking to the record it leads to. */
export function FlowBar({ steps, label, compact = false }: { steps: readonly FlowStep[]; label: string; compact?: boolean }) {
  return (
    <ol aria-label={label} className={cn('flex flex-wrap items-center gap-x-1 gap-y-2', !compact && 'mb-4 rounded-card border border-line bg-card px-4 py-3 shadow-card')}>
      {steps.map((s, i) => {
        const body = (
          <>
            <span className={cn('grid shrink-0 place-items-center rounded-full font-semibold', compact ? 'size-5 text-[10px]' : 'size-6 text-[11px]', DOT[s.state])}>
              {s.state === 'done' ? <Check aria-hidden className="size-3" strokeWidth={3} /> : s.state === 'blocked' ? <X aria-hidden className="size-3" strokeWidth={3} /> : i + 1}
            </span>
            <span className={cn(compact ? 'text-xs' : 'text-sm', s.state === 'upcoming' ? 'text-muted' : 'font-medium', s.ref && 'underline-offset-2 group-hover:underline')}>{s.label}</span>
          </>
        )
        return (
          <li key={s.id} aria-current={s.state === 'current' || s.state === 'blocked' ? 'step' : undefined} className="flex items-center gap-1">
            {s.ref ? (
              <Link to={ROUTE[s.ref.kind](s.ref.id)} title={`Open ${s.ref.label}`} className="group flex items-center gap-1.5 rounded-full py-0.5 pr-2">
                {body}
              </Link>
            ) : (
              <span className="flex items-center gap-1.5 py-0.5 pr-2">{body}</span>
            )}
            {i < steps.length - 1 && <span aria-hidden className={cn('h-px w-4', s.state === 'done' ? 'bg-success' : 'bg-line-strong')} />}
          </li>
        )
      })}
    </ol>
  )
}
