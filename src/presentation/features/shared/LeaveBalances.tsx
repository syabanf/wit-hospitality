import { LEAVE_KIND_LABEL } from '@/domain/hr'
import type { LeaveBalance } from '@/domain/selfService'
import { plural } from '@/lib/format'

/** One row per leave kind: days left of the year's entitlement, with used and pending days under it. */
export function LeaveBalances({ balances }: { balances: readonly LeaveBalance[] }) {
  return (
    <ul className="space-y-3 text-sm">
      {balances.map((b) => {
        const share = (days: number) => (b.entitlement ? `${Math.min(100, (days / b.entitlement) * 100)}%` : '0%')
        return (
          <li key={b.kind}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-medium">{LEAVE_KIND_LABEL[b.kind]}</span>
              <span className="tabular">{b.left === null ? 'No limit' : `${plural(b.left, 'day')} left`}</span>
            </div>
            {b.entitlement !== null && (
              <div className="mt-1.5 flex h-2 overflow-hidden rounded-full bg-raised" aria-hidden>
                <span className="bg-fg" style={{ width: share(b.used) }} />
                <span className="hatch bg-control" style={{ width: share(b.pending) }} />
              </div>
            )}
            <p className="mt-1 text-xs text-muted">
              {plural(b.used, 'day')} used{b.pending > 0 && `, ${plural(b.pending, 'day')} pending`}
              {b.entitlement !== null && ` of ${b.entitlement} a year`}
            </p>
          </li>
        )
      })}
    </ul>
  )
}
