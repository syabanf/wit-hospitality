import { useState } from 'react'
import { Link } from 'react-router'
import { CircleCheck, MoonStar, TriangleAlert } from 'lucide-react'
import { AUDIT_CHECK_LABEL, AUDIT_CHECKS } from '@/domain/nightAudit'
import { fullDay, shortDay } from '@/lib/dates'
import { money, plural } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { StatusPill } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Card, CardHeader } from '../../ui/Card'
import { CardSkeleton, ErrorState } from '../../ui/States'
import { StatTile } from '../../ui/StatTile'
import { useToast } from '../../ui/useToast'
import { Input } from '../../ui/Field'
import { Field } from '../../ui/Form'

/**
 * The close of the business day: the checklist with links to fix each item, what tonight posts, the
 * run itself and the audits before it. The business date runs apart from the calendar date.
 */
export default function NightAuditPage() {
  const { nightAudit } = useServices()
  const toast = useToast()
  const data = useResource('nightAudit.overview', () => nightAudit.overview())
  const [running, setRunning] = useState(false)
  const [reason, setReason] = useState('')

  async function run() {
    setRunning(true)
    try {
      const blocked = (data.data?.checks.find((c) => c.key === 'discrepancies')?.items.length ?? 0) > 0
      const audit = await nightAudit.run(blocked ? { reason } : null)
      toast({ title: `Closed ${fullDay(audit.date)}`, description: `${plural(audit.nights, 'night')} posted for ${money(audit.roomRevenue)}${audit.noShows.length ? `, ${plural(audit.noShows.length, 'no-show')} marked` : ''}. The business date moved to the next day.` })
      setReason('')
      data.reload()
    } catch (error) {
      toast({ tone: 'danger', title: 'Could not run the night audit', description: error instanceof Error ? error.message : undefined })
    } finally {
      setRunning(false)
    }
  }

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={8} />
  const { businessDate, today, checks, tonight, audits, problem, canRun, mayOverride } = data.data
  const discrepancies = checks.find((c) => c.key === 'discrepancies')?.items.length ?? 0
  const open = checks.reduce((s, c) => s + c.items.length, 0)
  const last = audits[0]

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 min-[1360px]:grid-cols-4">
        <StatTile className="col-span-2 min-[1360px]:col-span-1" label="Business date" value={shortDay(businessDate)} hint={businessDate === today ? 'Same as the calendar date' : `Calendar date ${shortDay(today)}`} />
        <StatTile label="Stays to post tonight" value={tonight.length} hint={plural(tonight.reduce((s, t) => s + t.nights, 0), 'night')} />
        <StatTile label="Room revenue tonight" value={money(tonight.reduce((s, t) => s + t.amount, 0))} hint="On the ROOM code" to="/reports/revenue-codes" />
        <StatTile label="Last audit" value={last ? shortDay(last.date) : 'None'} hint={last ? `${last.ranBy}, ${plural(last.nights, 'night')}` : 'Not run yet'} />
      </div>

      <Card aria-labelledby="na-run">
        <CardHeader
          id="na-run"
          title={`Close ${fullDay(businessDate)}`}
          icon={<MoonStar aria-hidden className="size-4" />}
          action={
            canRun && (
              <Button variant="accent" loading={running} disabled={problem !== null} onClick={() => void run()}>
                Run the night audit
              </Button>
            )
          }
        />
        <ol className="list-inside list-decimal space-y-1 text-sm text-body">
          <li>Arrivals still not checked in are marked no-show; the cancellation policy keeps what they paid.</li>
          <li>Every stay in house gets tonight’s room on its folio on the ROOM code, at the night’s list or staff rate less its share of the discount, and on its receivable; a master-billed group’s nights go to its master folio.</li>
          <li>The business date moves to the next day. A date runs once.</li>
        </ol>
        {problem && <p className="mt-3 text-sm text-muted" role="status">{problem.message}</p>}
        {!problem && canRun && discrepancies > 0 && (
          <div className="mt-4 rounded-panel bg-warning-soft p-3.5 text-sm text-warning">
            <p className="font-semibold">
              {discrepancies === 1 ? '1 room discrepancy is' : `${discrepancies} room discrepancies are`} still open. <Link to="/front-office/discrepancies" className="underline">Resolve them</Link> before closing the day.
            </p>
            {mayOverride ? (
              <Field label="Or close the day anyway, with the reason" htmlFor="na-override" className="mt-3">
                <Input id="na-override" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Guest confirmed by phone, staying until tomorrow" />
              </Field>
            ) : (
              <p className="mt-1 text-xs">Only a villa manager or someone who approves bookings may close the day over them.</p>
            )}
          </div>
        )}
        {!canRun && <p className="mt-3 text-sm text-muted">Managers and front desk leads run the audit; you can read the checklist.</p>}
      </Card>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {checks.map((c) => (
          <Card key={c.key} aria-labelledby={`na-${c.key}`}>
            <CardHeader
              id={`na-${c.key}`}
              title={c.label}
              icon={c.items.length ? <TriangleAlert aria-hidden className="size-4 text-warning" /> : <CircleCheck aria-hidden className="size-4 text-success" />}
              action={<StatusPill tone={c.items.length ? 'warning' : 'success'}>{c.items.length ? c.items.length : 'Clear'}</StatusPill>}
            />
            <p className="mb-2 text-xs text-muted">{c.hint}</p>
            {c.items.length > 0 && (
              <ul className="divide-y divide-line text-sm">
                {c.items.slice(0, 8).map((item) => (
                  <li key={`${item.to}-${item.label}`} className="py-2">
                    <Link to={item.to} className="hover:underline">
                      {item.label}
                    </Link>
                  </li>
                ))}
                {c.items.length > 8 && <li className="py-2 text-xs text-muted">and {c.items.length - 8} more</li>}
              </ul>
            )}
          </Card>
        ))}
      </div>
      <p className="text-xs text-muted">{open === 0 ? 'Nothing waits on the desk.' : `${plural(open, 'item')} on the checklist. Only arrivals change when the audit runs; the rest are for the desk.`}</p>

      <Card aria-labelledby="na-history">
        <CardHeader id="na-history" title="Audit history" action={<span className="text-xs text-muted">{plural(audits.length, 'audit')}</span>} />
        <div className="-mx-1 overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-line-strong text-left text-xs tracking-wide text-muted uppercase">
                <th scope="col" className="px-1 py-2 font-medium">Business date</th>
                <th scope="col" className="px-1 py-2 text-right font-medium">Nights</th>
                <th scope="col" className="px-1 py-2 text-right font-medium">Room revenue</th>
                <th scope="col" className="px-1 py-2 font-medium">No-shows</th>
                <th scope="col" className="px-1 py-2 font-medium">Open on the checklist</th>
                <th scope="col" className="px-1 py-2 font-medium">Run by</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {audits.map((a) => (
                <tr key={a.id}>
                  <td className="px-1 py-2.5 whitespace-nowrap">{shortDay(a.date)}</td>
                  <td className="px-1 py-2.5 text-right tabular">{a.nights}</td>
                  <td className="px-1 py-2.5 text-right whitespace-nowrap tabular">{money(a.roomRevenue)}</td>
                  <td className="px-1 py-2.5">{a.noShows.length ? a.noShows.join(', ') : <span className="text-muted">None</span>}</td>
                  <td className="px-1 py-2.5 text-xs text-muted">
                    {AUDIT_CHECKS.filter((k) => a.checks[k] > 0)
                      .map((k) => `${a.checks[k]} ${AUDIT_CHECK_LABEL[k].toLowerCase()}`)
                      .join(', ') || 'Clear'}
                  </td>
                  <td className="px-1 py-2.5 text-muted">
                    <span className="whitespace-nowrap">{a.ranBy}</span>
                    {a.override && <span className="block text-xs">Over open discrepancies: {a.override.reason}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}
