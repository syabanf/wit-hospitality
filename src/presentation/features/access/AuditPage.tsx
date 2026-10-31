import { useState } from 'react'
import { useSearchParams } from 'react-router'
import { ChevronDown, ChevronUp, Search } from 'lucide-react'
import { AUDIT_ACTION_LABEL, AUDIT_ACTIONS, ROLE_LABEL, type AuditAction, type AuditEntry } from '@/domain/access'
import { addDays, eachDay, shortDay } from '@/lib/dates'
import { ColumnChart } from '../../charts/ColumnChart'
import { seriesColor } from '../../charts/colors'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { StatusPill } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Card, CardHeader } from '../../ui/Card'
import { DateRangeFilter } from '../../ui/DateRangeFilter'
import { Input, Select } from '../../ui/Field'
import { ListTable } from '../../ui/ListTable'
import { CardSkeleton, EmptyState, ErrorState } from '../../ui/States'
import { StatTile } from '../../ui/StatTile'
import { TableToolbar } from '../../ui/TableToolbar'
import { DonutLegend } from '../reports/DonutLegend'
import { AUDIT_TONE, timeOf } from './tones'

const ACTION_SLOT: Record<AuditAction, number> = { create: 3, update: 2, delete: 1, status: 4, approve: 3, reject: 1, login: 5, logout: 0, denied: 1 }

type ActionChip = AuditAction | 'all'

const fmt = (v: unknown) => (typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? ''))

function Diff({ entry }: { entry: AuditEntry }) {
  const keys = [...new Set([...Object.keys(entry.before ?? {}), ...Object.keys(entry.after ?? {})])]
  if (keys.length === 0) return <p className="text-xs text-muted">No field values were recorded for this change.</p>
  return (
    <dl className="grid grid-cols-[auto_1fr_1fr] gap-x-4 gap-y-1 text-xs">
      <dt className="font-semibold text-muted">Field</dt>
      <dt className="font-semibold text-muted">Before</dt>
      <dt className="font-semibold text-muted">After</dt>
      {keys.map((k) => (
        <div key={k} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="min-w-0 break-words">{fmt(entry.before?.[k])}</dd>
          <dd className="min-w-0 font-medium break-words">{fmt(entry.after?.[k])}</dd>
        </div>
      ))}
    </dl>
  )
}

/** Every create, edit, status change, approval and sign-in, newest first, with before and after values. */
export default function AuditPage() {
  const { access, clock } = useServices()
  const data = useResource('access.audit', () => access.audit())
  const [params, setParams] = useSearchParams()
  const [open, setOpen] = useState<string | null>(null)
  const action = (AUDIT_ACTIONS.find((a) => a === params.get('action')) ?? 'all') as ActionChip
  const entity = params.get('entity') ?? ''
  const userId = params.get('user') ?? ''
  const query = params.get('q') ?? ''
  const from = params.get('from') ?? undefined
  const to = params.get('to') ?? undefined

  function update(next: Record<string, string | undefined>) {
    const search = new URLSearchParams(params)
    for (const [k, v] of Object.entries(next)) {
      if (v && v !== 'all') search.set(k, v)
      else search.delete(k)
    }
    search.delete('page')
    setParams(search, { replace: true })
  }

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={8} />
  const d = data.data
  const rows = access.filterAudit(d.entries, { action, entity: entity || undefined, userId: userId || undefined, query, from, to })
  const today = clock.today()
  const count = (a: AuditAction) => d.entries.filter((e) => e.action === a).length
  const detail = open ? rows.find((e) => e.id === open) : undefined
  const days = eachDay(addDays(today, -13), addDays(today, 1))
  const perDay = days.map((date) => ({ key: date, label: shortDay(date).replace(/^\w+ /, ''), value: d.entries.filter((e) => e.at.startsWith(date) && (action === 'all' || e.action === action)).length }))
  const dayPicked = from && from === to && days.includes(from) ? from : null
  const byAction = AUDIT_ACTIONS.map((a) => ({ id: a, label: AUDIT_ACTION_LABEL[a], value: rows.filter((e) => e.action === a).length, color: seriesColor(ACTION_SLOT[a]) })).filter((s) => s.value > 0)

  return (
    <div className="space-y-4">
      <p className="max-w-xl text-sm text-muted">Who did what, when, to which record. Approvals, rejections, posted money and refused attempts all land here; nothing is ever removed.</p>
      <div className="grid grid-cols-2 gap-3 stagger xl:grid-cols-4">
        <StatTile label="Entries today" value={d.entries.filter((e) => e.at.startsWith(today)).length} hint={shortDay(today)} active={from === today && to === today} onClick={() => update({ from: from === today ? undefined : today, to: to === today ? undefined : today })} />
        <StatTile label="Approvals and rejections" value={count('approve') + count('reject')} hint="Signatures on money" active={action === 'approve'} onClick={() => update({ action: action === 'approve' ? 'all' : 'approve' })} />
        <StatTile label="Refused attempts" value={count('denied')} hint="Actions outside a role" active={action === 'denied'} onClick={() => update({ action: action === 'denied' ? 'all' : 'denied' })} />
        <StatTile label="Sign-ins" value={count('login')} hint={`${d.users.filter((u) => u.lastLoginOn === today).length} people today`} active={action === 'login'} onClick={() => update({ action: action === 'login' ? 'all' : 'login' })} />
      </div>
      <div className="grid grid-cols-1 gap-4 stagger xl:grid-cols-[minmax(0,1fr)_380px]">
        <Card aria-labelledby="activity-title">
          <CardHeader
            id="activity-title"
            title="Activity, last 14 days"
            action={
              dayPicked ? (
                <Button size="sm" variant="soft" onClick={() => update({ from: undefined, to: undefined })}>
                  <ChevronUp aria-hidden className="size-3.5" /> All days
                </Button>
              ) : (
                <span className="text-xs text-muted">Click a day to filter the table</span>
              )
            }
          />
          <ColumnChart label="Audit entries per day" className="h-48" data={perDay} selected={dayPicked} onSelect={(key) => update({ from: dayPicked === key ? undefined : key, to: dayPicked === key ? undefined : key })} format={(v) => `${v} entries`} />
        </Card>
        <Card aria-labelledby="by-action-title">
          <CardHeader id="by-action-title" title="By action" />
          <DonutLegend label="Entries by action" size={150} format={String} slices={byAction} onPick={(id) => update({ action: action === id ? 'all' : id })} picked={action === 'all' ? null : action} centre={<p className="text-[22px] leading-none font-medium tracking-tight tabular">{rows.length}</p>} />
        </Card>
      </div>
      <Card className="p-0" aria-label="Audit trail">
        <TableToolbar
          chips={[{ value: 'all' as ActionChip, label: 'All', count: d.entries.length }, ...AUDIT_ACTIONS.map((a) => ({ value: a as ActionChip, label: AUDIT_ACTION_LABEL[a], count: count(a) }))].filter((c) => c.count > 0)}
          chip={action}
          onChip={(a) => update({ action: a })}
          chipLabel="Filter by action"
          summary={`${rows.length} of ${d.entries.length} entries`}
          search={<Input className="h-10" icon={<Search className="size-4" />} placeholder="Record, summary or person" aria-label="Search the audit trail" value={query} onChange={(e) => update({ q: e.target.value })} />}
          filters={
            <>
              <Select aria-label="Record type" value={entity} options={[{ value: '', label: 'All records' }, ...d.entities.map((e) => ({ value: e, label: e.replace(/-/g, ' ') }))]} onChange={(e) => update({ entity: e.target.value })} />
              <Select aria-label="Person" value={userId} options={[{ value: '', label: 'Everyone' }, ...d.users.map((u) => ({ value: u.id, label: u.name }))]} onChange={(e) => update({ user: e.target.value })} />
            </>
          }
          date={<DateRangeFilter today={today} label="Date" value={{ from, to }} onChange={(r) => update({ from: r.from, to: r.to })} />}
          active={action !== 'all' || !!entity || !!userId || !!query || !!from || !!to}
          onClear={() => setParams({}, { replace: true })}
        />
        {detail && (
          <div className="border-b border-line bg-raised/60 px-5 py-4">
            <div className="mb-2 flex items-center justify-between gap-3">
              <p className="min-w-0 truncate text-sm font-medium">
                {detail.summary} <span className="text-muted">· {detail.userName}, {shortDay(detail.at.slice(0, 10))} {timeOf(detail.at)}</span>
              </p>
              <Button size="sm" variant="ghost" onClick={() => setOpen(null)}>
                <ChevronUp aria-hidden className="size-3.5" /> Close
              </Button>
            </div>
            <Diff entry={detail} />
          </div>
        )}
        <ListTable
          label="Audit trail"
          rows={rows}
          rowKey={(e) => e.id}
          href={() => `/access/audit?${params.toString()}`}
          exportName="audit-trail"
          exportDate={today}
          empty={<EmptyState title="Nothing matches">Widen the dates or clear a filter.</EmptyState>}
          columns={[
            { key: 'at', header: 'When', cell: (e) => <span className="whitespace-nowrap">{shortDay(e.at.slice(0, 10))} <span className="text-muted">{timeOf(e.at)}</span></span>, value: (e) => e.at },
            { key: 'who', header: 'Who', cell: (e) => <span>{e.userName} <span className="text-xs text-muted">· {ROLE_LABEL[e.role]}</span></span>, value: (e) => e.userName },
            { key: 'action', header: 'Action', cell: (e) => <StatusPill tone={AUDIT_TONE[e.action]}>{AUDIT_ACTION_LABEL[e.action]}</StatusPill>, value: (e) => AUDIT_ACTION_LABEL[e.action] },
            { key: 'entity', header: 'Record', cell: (e) => <span className="whitespace-nowrap"><span className="text-muted">{e.entity.replace(/-/g, ' ')}</span> <span className="font-mono text-xs">{e.entityId}</span></span>, value: (e) => `${e.entity} ${e.entityId}`, hide: 'lg' },
            { key: 'summary', header: 'Summary', cell: (e) => <span className="line-clamp-2">{e.summary}</span>, value: (e) => e.summary },
            {
              key: 'diff',
              header: '',
              align: 'right',
              cell: (e) =>
                e.before || e.after ? (
                  <span onClick={(ev) => ev.stopPropagation()}>
                    <Button size="sm" variant="ghost" aria-expanded={open === e.id} onClick={() => setOpen(open === e.id ? null : e.id)}>
                      Values {open === e.id ? <ChevronUp aria-hidden className="size-3.5" /> : <ChevronDown aria-hidden className="size-3.5" />}
                    </Button>
                  </span>
                ) : null,
            },
          ]}
          card={(e) => (
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <p className="line-clamp-2 text-sm font-medium">{e.summary}</p>
                <p className="text-xs text-muted">
                  {e.userName} · {shortDay(e.at.slice(0, 10))} {timeOf(e.at)}
                </p>
              </div>
              <StatusPill tone={AUDIT_TONE[e.action]}>{AUDIT_ACTION_LABEL[e.action]}</StatusPill>
            </div>
          )}
        />
      </Card>
    </div>
  )
}
