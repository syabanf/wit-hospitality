import { Check } from 'lucide-react'
import { ROLE_LABEL, type Role } from '@/domain/access'
import type { ApprovalGrant } from '@/domain/finance'
import { cn } from '@/lib/cn'

interface ApprovalChainProps {
  levels: readonly Role[]
  approvals: readonly ApprovalGrant[]
  /** Compact: role chips only, for rows. */
  compact?: boolean
  className?: string
}

/** The signing chain as chips: signed levels are inverted with a tick, the next one is outlined. */
export function ApprovalChain({ levels, approvals, compact = false, className }: ApprovalChainProps) {
  return (
    <ol aria-label="Approval chain" className={cn('flex flex-wrap items-center gap-1.5', className)}>
      {levels.map((role, i) => {
        const grant = approvals[i]
        const next = !grant && approvals.length === i
        return (
          <li
            key={`${role}-${i}`}
            className={cn(
              'inline-flex h-6 items-center gap-1 rounded-full px-2 text-[11px] font-semibold whitespace-nowrap',
              grant ? 'bg-invert text-on-invert' : next ? 'border border-accent text-accent-text' : 'border border-line-strong text-muted',
            )}
            title={grant ? `${grant.by} signed ${grant.on}` : next ? 'Signs next' : 'Later'}
          >
            {grant && <Check aria-hidden className="size-3" strokeWidth={3} />}
            {compact ? ROLE_LABEL[role] : `${i + 1}. ${ROLE_LABEL[role]}`}
          </li>
        )
      })}
    </ol>
  )
}
