import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/cn'
interface CardProps extends HTMLAttributes<HTMLElement> {
  as?: 'section' | 'div' | 'article'
}

/** White card on the canvas. Nested panels use `bg-raised`; bright surfaces use `POP` from ./pop. */
export function Card({ as: Tag = 'section', className, ...props }: CardProps) {
  return <Tag className={cn('rounded-card border border-line bg-card p-5 shadow-card', className)} {...props} />
}

interface CardHeaderProps {
  title: ReactNode
  /** Small leading icon, rendered before the title. */
  icon?: ReactNode
  action?: ReactNode
  className?: string
  id?: string
}

export function CardHeader({ title, icon, action, className, id }: CardHeaderProps) {
  return (
    <div className={cn('mb-4 flex min-h-10 flex-wrap items-center justify-between gap-3', className)}>
      <h2 id={id} className="flex items-center gap-2 text-lg font-semibold tracking-tight">
        {icon}
        {title}
      </h2>
      {action && <div className="flex items-center gap-2">{action}</div>}
    </div>
  )
}
