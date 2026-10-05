import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

/** Record title ending in the WIT red period. A trailing period in the text ("Edward S.") is dropped first. */
export function Headline({ children, className }: { children: string; className?: string }) {
  return (
    <h2 className={cn('text-2xl font-bold tracking-tight', className)}>
      {children.replace(/\.$/, '')}
      <span className="text-accent">.</span>
    </h2>
  )
}

/** Small raised tiles of label and value under a record's hero. */
export function FactGrid({ facts, className }: { facts: ReadonlyArray<readonly [string, ReactNode]>; className?: string }) {
  return (
    <dl className={cn('grid gap-3', className)}>
      {facts.map(([label, value]) => (
        <div key={label} className="rounded-panel bg-raised p-3">
          <dt className="text-xs text-muted">{label}</dt>
          <dd className="mt-1 font-medium tabular">{value}</dd>
        </div>
      ))}
    </dl>
  )
}
