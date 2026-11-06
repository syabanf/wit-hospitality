import { Link } from 'react-router'
import { UsersRound } from 'lucide-react'
import type { BookingView } from '@/application/views'
import { cn } from '@/lib/cn'

const CHIP = 'inline-flex h-5 max-w-full items-center gap-1 rounded-md bg-info-soft px-1.5 text-[11px] font-semibold text-info-text'

/**
 * The group a stay belongs to, linking to it; nothing for a stay booked on its own. `plain` drops the
 * link where the chip already sits inside one, like a row card.
 */
export function GroupChip({ group, to, plain = false, className }: { group: BookingView['group']; to?: string; plain?: boolean; className?: string }) {
  if (!group) return null
  const body = (
    <>
      <UsersRound aria-hidden className="size-3 shrink-0" />
      <span className="truncate">{group.name}</span>
    </>
  )
  if (plain) return <span className={cn(CHIP, className)}>{body}</span>
  return (
    <Link to={to ?? `/bookings/groups/${group.id}`} title={`${group.code} ${group.name}`} onClick={(e) => e.stopPropagation()} className={cn(CHIP, 'hover:underline', className)}>
      {body}
    </Link>
  )
}
