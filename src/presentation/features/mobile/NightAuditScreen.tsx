import { CircleCheck, ExternalLink, TriangleAlert } from 'lucide-react'
import { shortDay, shortWeekday } from '@/lib/dates'
import { money, plural } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { buttonStyles } from '../../ui/buttonStyles'
import { Skeleton } from '../../ui/States'
import { Screen } from './Screen'

/** The night audit checklist on the phone, read-only: a front desk lead sees what is open and runs the close on the console. */
export function NightAuditScreen() {
  const { nightAudit } = useServices()
  const data = useResource('nightAudit.overview', () => nightAudit.overview())
  const d = data.data

  return (
    <Screen title="Night audit">
      {!d ? (
        <Skeleton className="h-40 rounded-[22px]" />
      ) : (
        <>
          <div className="rounded-[22px] bg-card p-4 shadow-card">
            <p className="text-xs text-muted">Business date</p>
            <p className="mt-1 text-xl font-semibold">
              {shortWeekday(d.businessDate)}, {shortDay(d.businessDate)}
            </p>
            <p className="mt-1 text-xs text-muted">
              Tonight posts {plural(d.tonight.reduce((s, t) => s + t.nights, 0), 'night')} for {money(d.tonight.reduce((s, t) => s + t.amount, 0))}
              {d.audits[0] ? `; last closed ${shortDay(d.audits[0].date)} by ${d.audits[0].ranBy}` : ''}.
            </p>
          </div>
          <ul className="space-y-2">
            {d.checks.map((c) => (
              <li key={c.key} className="flex items-start gap-3 rounded-[22px] bg-card p-3 shadow-card">
                {c.items.length ? <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" /> : <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />}
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold">
                    {c.label} <span className="font-normal text-muted tabular">{c.items.length}</span>
                  </span>
                  <span className="block text-xs text-muted">{c.items.length ? c.items.slice(0, 3).map((i) => i.label).join('; ') : 'Clear'}</span>
                </span>
              </li>
            ))}
          </ul>
          <a href="/night-audit" className={buttonStyles({ variant: 'solid', className: 'w-full' })}>
            <ExternalLink aria-hidden className="size-4" /> Run it on the console
          </a>
        </>
      )}
    </Screen>
  )
}
