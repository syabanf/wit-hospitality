import { cn } from '@/lib/cn'
import { POP, POP_ORDER, type Pop } from './pop'

const SIZE = { sm: 'size-8 text-xs', md: 'size-10 text-sm', lg: 'size-12 text-base' }

/** Initials on a pop colour picked from the name, so one person keeps one colour everywhere. */
export function Avatar({ name, size = 'md', className }: { name: string; size?: keyof typeof SIZE; className?: string }) {
  const initials = name
    .split(/\s+/)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()
  const pop = POP_ORDER[[...name].reduce((s, c) => s + c.charCodeAt(0), 0) % POP_ORDER.length] as Pop
  return (
    <span
      role="img"
      aria-label={name}
      className={cn('inline-grid shrink-0 place-items-center rounded-full font-semibold ring-0', POP[pop], SIZE[size], className)}
    >
      {initials}
    </span>
  )
}
