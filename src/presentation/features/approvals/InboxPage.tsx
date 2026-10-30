import { useState, type FormEvent, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router'
import { CircleCheck, RotateCcw, Search, ShieldCheck, XCircle } from 'lucide-react'
import type { TransactionAction } from '@/application/ports'
import type { TransactionView } from '@/application/views'
import { ROLE_LABEL, type Role } from '@/domain/access'
import { TRANSACTION_STATUS_LABEL } from '@/domain/finance'
import { cn } from '@/lib/cn'
import { shortDay } from '@/lib/dates'
import { money, moneyCompact } from '@/lib/format'
import { ColumnChart } from '../../charts/ColumnChart'
import { seriesColor } from '../../charts/colors'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { StatusPill } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { buttonStyles } from '../../ui/buttonStyles'
import { Card, CardHeader } from '../../ui/Card'
import { Input, Select } from '../../ui/Field'
import { Field } from '../../ui/Form'
import { fieldErrors } from '../../ui/fieldErrors'
import { Popover } from '../../ui/Popover'
import { CardSkeleton, ErrorState } from '../../ui/States'
import { StatTile } from '../../ui/StatTile'
import { TableToolbar } from '../../ui/TableToolbar'
import { useToast } from '../../ui/useToast'
import { DonutLegend } from '../reports/DonutLegend'
import { TRANSACTION_TONE } from '../shared/tones'
import { ApprovalChain } from './ApprovalChain'

const AMOUNT_OPTIONS = [
  { value: '', label: 'Any amount' },
  { value: '5000000', label: 'From Rp 5 jt' },
  { value: '25000000', label: 'From Rp 25 jt' },
]
const LEVEL_ROLES: readonly Role[] = ['manager', 'finance', 'owner', 'management']
const FILTER_KEYS = ['villa', 'account', 'q', 'min', 'next'] as const

const amount = (t: TransactionView) => (
  <span className={cn('shrink-0 font-semibold tabular', t.kind === 'cash_out' && 'text-muted')}>
    {t.kind === 'cash_out' ? '-' : '+'}
    {money(t.amount)}
  </span>
)

/** A note popover around an action; `required` refuses an empty note. */
function NoteAction({ label, icon, variant, required, busy, onSubmit }: { label: string; icon: ReactNode; variant: 'accent' | 'card' | 'soft'; required: boolean; busy: boolean; onSubmit: (note: string) => Promise<boolean> }) {
  const [error, setError] = useState<string | undefined>()
  return (
    <Popover
      align="right"
      className="w-72 p-4"
      trigger={(props) => (
        <Button {...props} size="sm" variant={variant} loading={busy}>
          {icon} {label}
        </Button>
      )}
    >
      {(close) => (
        <form
          onSubmit={(e: FormEvent<HTMLFormElement>) => {
            e.preventDefault()
            const note = String(new FormData(e.currentTarget).get('note') ?? '').trim()
            if (required && note.length < 3) {
              setError('Say why.')
              return
            }
            setError(undefined)
            void onSubmit(note).then((ok) => ok && close())
          }}
          className="space-y-3"
        >
          <Field label={required ? 'Reason' : 'Note (optional)'} htmlFor={`note-${label}`} error={error}>
            <Input id={`note-${label}`} name="note" placeholder={required ? 'What has to change' : 'For the record'} />
          </Field>
          <Button type="submit" size="sm" variant={variant === 'card' ? 'solid' : variant}>
            {label}
          </Button>
        </form>
      )}
    </Popover>
  )
}

/** What waits for the signed-in person, what waits for others, and what came back rejected. */
export default function InboxPage() {
  const { finance } = useServices()
  const toast = useToast()
  const data = useResource('finance.inbox', () => finance.inbox())
  const [busy, setBusy] = useState<string | null>(null)
  const [params, setParams] = useSearchParams()
  const [villaPick, setVillaPick] = useState<string | null>(null)
  const villa = params.get('villa') ?? ''
  const account = params.get('account') ?? ''
  const query = params.get('q') ?? ''
  const min = Number(params.get('min')) || 0
  const next = params.get('next') ?? ''

  function update(patch: Partial<Record<(typeof FILTER_KEYS)[number], string>>) {
    const search = new URLSearchParams(params)
    for (const [k, v] of Object.entries(patch)) {
      if (v) search.set(k, v)
      else search.delete(k)
    }
    setParams(search, { replace: true })
  }

  async function act(t: TransactionView, to: TransactionAction, note: string) {
    setBusy(`${t.id}:${to}`)
    try {
      const next = await finance.transition(t.id, to, note)
      const label = to === 'approved' ? (next.status === 'approved' ? `Approved ${t.number}` : `Signed ${t.number}`) : to === 'rejected' ? `Rejected ${t.number}` : to === 'posted' ? `Posted ${t.number}` : `Resubmitted ${t.number}`
      toast({ title: label, description: next.status === 'submitted' && next.nextApprover ? `Now with ${ROLE_LABEL[next.nextApprover]}` : undefined })
      data.reload()
      return true
    } catch (error) {
      toast({ tone: 'danger', title: `Could not update ${t.number}`, description: fieldErrors(error).form ?? Object.values(fieldErrors(error))[0] })
      return false
    } finally {
      setBusy(null)
    }
  }

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={8} />
  const d = data.data
  const everything = [...d.mine, ...d.others, ...d.rejected]
  const q = query.trim().toLowerCase()
  const villaName = (t: TransactionView) => t.villa?.name ?? t.location.name
  const keep = (t: TransactionView) =>
    (!villa || villaName(t) === villa) &&
    (!villaPick || villaName(t) === villaPick) &&
    (!account || t.accountName === account) &&
    t.amount >= min &&
    (!next || (next === 'post' ? t.status === 'approved' : t.nextApprover === next)) &&
    (!q || [t.number, t.description, t.createdBy].some((v) => v.toLowerCase().includes(q)))
  const mine = d.mine.filter(keep)
  const others = d.others.filter(keep)
  const rejected = d.rejected.filter(keep)
  const villas = [...new Set(everything.map(villaName))].sort()
  const accounts = [...new Set(everything.map((t) => t.accountName))].sort()
  const sumOf = (rows: readonly TransactionView[]) => rows.reduce((s, t) => s + t.amount, 0)
  const pending = [...d.mine, ...d.others]
  const byVilla = villas.map((name) => ({ key: name, label: name, value: sumOf(pending.filter((t) => villaName(t) === name)) })).filter((v) => v.value > 0)
  const queue = [
    { id: 'mine', label: 'Waiting for you', value: sumOf(d.mine.filter((t) => t.status === 'submitted')), color: seriesColor(1) },
    { id: 'others', label: 'Waiting for others', value: sumOf(d.others.filter((t) => t.status === 'submitted')), color: seriesColor(2) },
    { id: 'post', label: 'Approved, ready to post', value: sumOf(pending.filter((t) => t.status === 'approved')), color: seriesColor(3) },
    { id: 'rejected', label: 'Rejected', value: sumOf(d.rejected), color: seriesColor(0) },
  ].filter((s) => s.value > 0)
  const filtering = !!villa || !!account || !!query || min > 0 || !!next || !!villaPick

  const row = (t: TransactionView, actions: ReactNode) => (
    <li key={t.id} className="py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <Link to={`/finance/transactions/${t.id}`} className="block truncate text-sm font-medium hover:underline">
            {t.description}
          </Link>
          <p className="truncate text-xs text-muted">
            <span className="font-mono">{t.number}</span> · {shortDay(t.date)} · {t.accountName} · {t.villa?.name ?? t.location.name} · by {t.createdBy}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <ApprovalChain levels={t.levels} approvals={t.approvals} compact />
            {t.status === 'approved' && <StatusPill tone={TRANSACTION_TONE.approved}>Ready to post</StatusPill>}
          </div>
        </div>
        <div className="flex flex-col items-end gap-2">
          {amount(t)}
          <div className="flex flex-wrap justify-end gap-1.5">{actions}</div>
        </div>
      </div>
    </li>
  )

  const list = (rows: readonly TransactionView[], actions: (t: TransactionView) => ReactNode, empty: string) =>
    rows.length === 0 ? <p className="rounded-panel bg-raised px-4 py-6 text-center text-sm text-muted">{empty}</p> : <ul className="divide-y divide-line stagger">{rows.map((t) => row(t, actions(t)))}</ul>

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-muted">
          Entries climb their chain one signature at a time. You sign as {ROLE_LABEL[d.role]}; the author of an entry never signs it.
        </p>
        <Link to="/master/approval-rules" className={buttonStyles({ variant: 'card' })}>
          <ShieldCheck aria-hidden className="size-4" /> Approval rules
        </Link>
      </div>
      <div className="grid grid-cols-1 gap-3 stagger sm:grid-cols-3">
        <StatTile label="Waiting for you" value={mine.length} hint={money(sumOf(mine))} to="/approvals" />
        <StatTile label="With others" value={others.length} hint={money(sumOf(others))} to="/finance/approvals" />
        <StatTile label="Rejected" value={rejected.length} hint="Fix and resubmit" to="/finance/transactions?status=rejected" />
      </div>
      <div className="grid grid-cols-1 gap-4 stagger xl:grid-cols-2">
        <Card aria-labelledby="queue-title">
          <CardHeader id="queue-title" title="Queue by status" />
          <DonutLegend label="Queue by status" format={moneyCompact} slices={queue} centre={<p className="text-[22px] leading-none font-medium tracking-tight tabular">{everything.length}</p>} />
        </Card>
        <Card aria-labelledby="villa-chart-title">
          <CardHeader id="villa-chart-title" title="Pending amount by villa" action={villaPick && <Button size="sm" variant="soft" onClick={() => setVillaPick(null)}>Show all</Button>} />
          {byVilla.length === 0 ? (
            <p className="rounded-panel bg-raised px-4 py-6 text-center text-sm text-muted">Nothing is pending.</p>
          ) : (
            <ColumnChart label="Pending amount by villa" className="h-48" data={byVilla} selected={villaPick} onSelect={(key) => setVillaPick(villaPick === key ? null : key)} format={money} tick={moneyCompact} />
          )}
        </Card>
      </div>
      <Card className="p-0" aria-label="Inbox filters">
        <TableToolbar
          summary={`${mine.length + others.length + rejected.length} of ${everything.length} entries`}
          search={<Input className="h-10" icon={<Search className="size-4" />} placeholder="Number, description or author" aria-label="Search the inbox" value={query} onChange={(e) => update({ q: e.target.value })} />}
          filters={
            <>
              <Select aria-label="Villa" value={villa} options={[{ value: '', label: 'All villas' }, ...villas.map((v) => ({ value: v, label: v }))]} onChange={(e) => update({ villa: e.target.value })} />
              <Select aria-label="Account" value={account} options={[{ value: '', label: 'All accounts' }, ...accounts.map((a) => ({ value: a, label: a }))]} onChange={(e) => update({ account: e.target.value })} />
              <Select aria-label="Amount" value={min ? String(min) : ''} options={AMOUNT_OPTIONS} onChange={(e) => update({ min: e.target.value })} />
              <Select aria-label="Waiting for" value={next} options={[{ value: '', label: 'Any level' }, ...LEVEL_ROLES.map((r) => ({ value: r, label: `Waiting for ${ROLE_LABEL[r]}` })), { value: 'post', label: 'Ready to post' }]} onChange={(e) => update({ next: e.target.value })} />
            </>
          }
          active={filtering}
          onClear={() => {
            setVillaPick(null)
            setParams({}, { replace: true })
          }}
        />
      </Card>
      <Card aria-labelledby="mine-title">
        <CardHeader id="mine-title" title="For you" />
        {list(
          mine,
          (t) =>
            t.status === 'approved' ? (
              <Button size="sm" variant="accent" loading={busy === `${t.id}:posted`} onClick={() => void act(t, 'posted', '')}>
                <CircleCheck aria-hidden className="size-3.5" /> Post
              </Button>
            ) : (
              <>
                <NoteAction label="Reject" icon={<XCircle aria-hidden className="size-3.5" />} variant="soft" required busy={busy === `${t.id}:rejected`} onSubmit={(note) => act(t, 'rejected', note)} />
                <NoteAction label={`Sign level ${t.approvals.length + 1}`} icon={<ShieldCheck aria-hidden className="size-3.5" />} variant="accent" required={false} busy={busy === `${t.id}:approved`} onSubmit={(note) => act(t, 'approved', note)} />
              </>
            ),
          'Nothing waits for your signature.',
        )}
      </Card>
      <Card aria-labelledby="others-title">
        <CardHeader id="others-title" title="Waiting for others" />
        {list(
          others,
          (t) => (
            <span className="text-xs text-muted">{t.status === 'approved' ? 'Finance posts it' : t.nextApprover ? `${ROLE_LABEL[t.nextApprover]} signs next` : TRANSACTION_STATUS_LABEL[t.status]}</span>
          ),
          'The queue is empty.',
        )}
      </Card>
      <Card aria-labelledby="rejected-title">
        <CardHeader id="rejected-title" title="Rejected" />
        {list(
          rejected,
          (t) => (
            <>
              <span className="max-w-64 truncate text-xs text-danger" title={t.rejectionReason ?? ''}>
                {t.rejectionReason}
              </span>
              {t.createdById === d.userId && (
                <Button size="sm" variant="soft" loading={busy === `${t.id}:submitted`} onClick={() => void act(t, 'submitted', '')}>
                  <RotateCcw aria-hidden className="size-3.5" /> Resubmit
                </Button>
              )}
            </>
          ),
          'Nothing was rejected.',
        )}
      </Card>
    </div>
  )
}
