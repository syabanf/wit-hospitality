import { Search } from 'lucide-react'
import { JOURNAL_SOURCE_LABEL, type JournalSource } from '@/domain/journal'
import { withinRange } from '@/lib/dates'
import { money } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { StatusPill } from '../../ui/Badge'
import { Card } from '../../ui/Card'
import { DateRangeFilter } from '../../ui/DateRangeFilter'
import { Input, Select } from '../../ui/Field'
import { ListTable } from '../../ui/ListTable'
import { CardSkeleton, EmptyState, ErrorState } from '../../ui/States'
import { TableToolbar } from '../../ui/TableToolbar'
import { SOURCE_TONE, useFilters } from './filters'
import { VillaSelect } from './shared'

const SOURCES = ['', ...(Object.keys(JOURNAL_SOURCE_LABEL) as JournalSource[])] as const

/** Every journal entry, newest first, filtered by source, account, villa and date; each opens its lines. */
export default function JournalsPage() {
  const { accounting, clock } = useServices()
  const data = useResource('accounting.journals', () => accounting.journals())
  const { values: f, update, active } = useFilters(['source', 'account', 'villa', 'q', 'from', 'to'] as const)

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={8} />
  const d = data.data
  const q = f.q.trim().toLowerCase()
  const rows = d.views.filter(
    (e) =>
      (!f.source || e.source === f.source) &&
      (!f.account || e.lines.some((l) => l.accountId === f.account)) &&
      (!f.villa || e.villaId === f.villa) &&
      withinRange(e.date, f.from || undefined, f.to || undefined) &&
      (!q || [e.number, e.memo, e.sourceNumber, e.accounts].some((v) => v.toLowerCase().includes(q))),
  )

  return (
    <div className="space-y-4">
      <p className="max-w-2xl text-sm text-muted">The console writes these when cash entries post, transfers clear, payroll closes and manual journals post. Journals never change; a reversal of the cash entry writes the reversing journal.</p>
      <Card className="p-0">
        <TableToolbar
          chips={SOURCES.map((s) => ({ value: s, label: s ? JOURNAL_SOURCE_LABEL[s] : 'All', count: s ? d.views.filter((e) => e.source === s).length : d.views.length }))}
          chip={f.source as (typeof SOURCES)[number]}
          onChip={(s) => update({ source: s })}
          chipLabel="Filter by source"
          summary={`${rows.length} of ${d.views.length} entries`}
          search={<Input className="h-10" icon={<Search className="size-4" />} placeholder="Number, memo or account" aria-label="Search journals" value={f.q} onChange={(e) => update({ q: e.target.value })} />}
          filters={
            <>
              <Select aria-label="Account" value={f.account} options={[{ value: '', label: 'All accounts' }, ...d.chart.map((a) => ({ value: a.id, label: `${a.code} ${a.name}` }))]} onChange={(e) => update({ account: e.target.value })} />
              <VillaSelect villas={d.villas} value={f.villa} onChange={(villa) => update({ villa })} />
            </>
          }
          date={<DateRangeFilter today={clock.today()} value={{ from: f.from || undefined, to: f.to || undefined }} onChange={(r) => update({ from: r.from ?? '', to: r.to ?? '' })} />}
          active={active}
          onClear={() => update({ source: '', account: '', villa: '', q: '', from: '', to: '' })}
        />
        <ListTable
          label="Journal entries"
          rows={rows}
          rowKey={(e) => e.id}
          href={(e) => `/accounting/journals/${e.id}`}
          exportName="journal-entries"
          exportDate={clock.today()}
          defaultSort={{ key: 'date', dir: 'desc' }}
          empty={<EmptyState title="No entry matches">Nothing fits these filters.</EmptyState>}
          columns={[
            { key: 'number', header: 'Entry', cell: (e) => <span className="font-medium tabular">{e.number}</span>, value: (e) => e.number },
            { key: 'date', header: 'Date', cell: (e) => e.date, value: (e) => e.date },
            { key: 'memo', header: 'Memo', cell: (e) => <span className="line-clamp-1">{e.memo}</span>, value: (e) => e.memo },
            { key: 'source', header: 'Source', cell: (e) => <StatusPill tone={SOURCE_TONE[e.source]}>{e.sourceLabel} {e.sourceNumber}</StatusPill>, value: (e) => `${e.sourceLabel} ${e.sourceNumber}`, hide: 'lg' },
            { key: 'villa', header: 'Villa', cell: (e) => e.villaName, value: (e) => e.villaName, hide: 'xl' },
            { key: 'amount', header: 'Amount', align: 'right', cell: (e) => <span className="font-semibold tabular">{money(e.amount)}</span>, value: (e) => e.amount },
          ]}
          card={(e) => (
            <div className="min-w-0">
              <p className="flex justify-between gap-3 font-medium">
                <span className="truncate">{e.memo}</span>
                <span className="shrink-0 tabular">{money(e.amount)}</span>
              </p>
              <p className="truncate text-xs text-muted">
                {e.number} · {e.date} · {e.sourceLabel} · {e.villaName}
              </p>
            </div>
          )}
        />
      </Card>
    </div>
  )
}
