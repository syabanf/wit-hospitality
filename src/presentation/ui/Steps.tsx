import { Check } from 'lucide-react'
import { cn } from '@/lib/cn'

export interface Step {
  id: string
  label: string
  hint?: string
  state: 'done' | 'current' | 'upcoming' | 'late'
}

const DOT: Record<Step['state'], string> = {
  done: 'bg-success-soft text-success',
  current: 'bg-invert text-on-invert',
  upcoming: 'bg-raised text-subtle ring-1 ring-line-strong',
  late: 'bg-accent-strong text-white shadow-glow',
}

/** Vertical lifecycle: done steps carry a check, the current one is inverted, a late one is red. */
export function Steps({ steps, label }: { steps: readonly Step[]; label: string }) {
  return (
    <ol aria-label={label} className="space-y-1">
      {steps.map((step, i) => (
        <li key={step.id} aria-current={step.state === 'current' || step.state === 'late' ? 'step' : undefined} className="relative flex gap-3 pb-4 last:pb-0">
          {i < steps.length - 1 && <span aria-hidden className="absolute top-8 bottom-0 left-[15px] w-px bg-line-strong" />}
          <span className={cn('grid size-8 shrink-0 place-items-center rounded-full text-xs font-semibold', DOT[step.state])}>
            {step.state === 'done' ? <Check aria-hidden className="size-4" strokeWidth={3} /> : i + 1}
          </span>
          <div className="pt-1">
            <p className={cn('text-sm font-medium', step.state === 'upcoming' && 'text-muted')}>
              {step.label}
              {step.state === 'late' && <span className="ml-2 text-xs font-semibold text-accent-text">Late</span>}
            </p>
            {step.hint && <p className="text-xs text-muted">{step.hint}</p>}
          </div>
        </li>
      ))}
    </ol>
  )
}
