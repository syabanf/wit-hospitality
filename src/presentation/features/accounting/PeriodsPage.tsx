import { useState } from 'react'
import { Link } from 'react-router'
import { Lock, LockOpen } from 'lucide-react'
import { money } from '@/lib/format'
import { useAccess } from '../../hooks/useAccess'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { StatusPill } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Card, CardHeader } from '../../ui/Card'
import { Input } from '../../ui/Field'
import { CardSkeleton, ErrorState } from '../../ui/States'
import { useToast } from '../../ui/useToast'

/** Month closing: a closed month refuses every posting dated in it until finance reopens it with a reason. */
export default function PeriodsPage() {
  const { accounting } = useServices()
  const { can } = useAccess()
  const toast = useToast()
  const data = useResource('accounting.periods', () => accounting.periods())
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const allowed = can('finance', 'post')

  async function act(month: string, label: string, close: boolean) {
    setBusy(month)
    try {
      if (close) await accounting.closePeriod(month, notes[month] ?? '')
      else await accounting.reopenPeriod(month, notes[month] ?? '')
      toast({ title: close ? `Closed ${label}` : `Reopened ${label}`, description: close ? 'Postings dated in the month are refused now.' : 'Entries can post into the month again.' })
      setNotes((n) => ({ ...n, [month]: '' }))
      data.reload()
    } catch (error) {
      toast({ tone: 'danger', title: `Could not ${close ? 'close' : 'reopen'} ${label}`, description: error instanceof Error ? error.message : undefined })
    } finally {
      setBusy(null)
    }
  }

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={6} />

  return (
    <div className="space-y-4">
      <p className="max-w-2xl text-sm text-muted">Close a month once it has ended and every entry dated in it has posted or been rejected. Posting, reversing or closing payroll into a closed month is refused. Reopening needs a reason and shows in the audit trail.</p>
      <Card aria-labelledby="periods-title">
        <CardHeader id="periods-title" title="Months" />
        <ul className="divide-y divide-line">
          {data.data.map((p) => (
            <li key={p.month} className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0 md:flex-row md:items-center">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 font-medium">
                  {p.label}
                  <StatusPill tone={p.close ? 'neutral' : p.ended ? 'warning' : 'info'}>{p.close ? 'Closed' : p.ended ? 'Open' : 'Current'}</StatusPill>
                </p>
                <p className="text-xs text-muted">
                  <Link to={`/accounting/journals?from=${p.month}-01&to=${p.month}-31`} className="hover:underline">
                    {p.entries} journal entries, {money(p.debits)}
                  </Link>
                  {p.pending > 0 && ` · ${p.pending} waiting for approval`}
                  {p.close && ` · closed ${p.close.closedOn} by ${p.close.closedBy}${p.close.note ? `: ${p.close.note}` : ''}`}
                </p>
              </div>
              {allowed && p.ended && (
                <div className="flex flex-wrap items-center gap-2">
                  <Input className="h-10 w-full md:w-60" aria-label={`${p.close ? 'Reason to reopen' : 'Closing note'} for ${p.label}`} placeholder={p.close ? 'Reason to reopen' : 'Note (optional)'} value={notes[p.month] ?? ''} onChange={(e) => setNotes((n) => ({ ...n, [p.month]: e.target.value }))} />
                  <Button variant={p.close ? 'card' : 'solid'} disabled={busy === p.month} onClick={() => void act(p.month, p.label, !p.close)}>
                    {p.close ? <LockOpen aria-hidden className="size-4" /> : <Lock aria-hidden className="size-4" />}
                    {p.close ? 'Reopen' : 'Close month'}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  )
}
