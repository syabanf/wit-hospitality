import type { ReactNode } from 'react'
import { RotateCw } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from './Button'

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('animate-pulse rounded-panel bg-raised', className)} />
}

/** A card-sized placeholder while a resource loads. */
export function CardSkeleton({ className, lines = 3 }: { className?: string; lines?: number }) {
  return (
    <div role="status" aria-label="Loading" className={cn('rounded-card border border-line bg-card p-5 shadow-card', className)}>
      <Skeleton className="mb-5 h-6 w-32" />
      <div className="space-y-3">
        {Array.from({ length: lines }, (_, i) => (
          <Skeleton key={i} className={cn('h-10', i === lines - 1 && 'w-2/3')} />
        ))}
      </div>
    </div>
  )
}

export function ErrorState({ error, onRetry, className }: { error: Error; onRetry: () => void; className?: string }) {
  return (
    <div role="alert" className={cn('flex flex-col items-start gap-3 rounded-panel bg-danger-soft p-4', className)}>
      <p className="text-sm text-fg">
        <span className="font-semibold">Could not load this.</span> <span className="text-body">{error.message}</span>
      </p>
      <Button size="sm" variant="soft" onClick={onRetry}>
        <RotateCw aria-hidden className="size-3.5" />
        Try again
      </Button>
    </div>
  )
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-panel border border-dashed border-line-strong px-6 py-10 text-center">
      <p className="font-medium">{title}</p>
      {children && <p className="max-w-xs text-sm text-muted">{children}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}
