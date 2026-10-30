import { useState } from 'react'
import { useSearchParams } from 'react-router'
import { Pencil, Plus, Search, Sparkles } from 'lucide-react'
import type { PlanView } from '@/application/views'
import { intervalLabel, MAINTENANCE_CATEGORY_LABEL, PLAN_STATE_LABEL, type PlanState } from '@/domain/maintenance'
import { shortDay } from '@/lib/dates'
import { money } from '@/lib/format'
import { useAccess } from '../../hooks/useAccess'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Tag } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'
import { Input, Select } from '../../ui/Field'
import { ListTable } from '../../ui/ListTable'
import { CardSkeleton, EmptyState, ErrorState } from '../../ui/States'
import { StatTile } from '../../ui/StatTile'
import { TableToolbar } from '../../ui/TableToolbar'
import { useToast } from '../../ui/useToast'
import { PlanForm } from './PlanForm'
import { PLAN_TONE } from './tones'

type Chip = PlanState | 'all'
const CHIPS: readonly Chip[] = ['all', 'overdue', 'due', 'later', 'paused']

/** Recurring service: what falls due, what is overdue, and the button that opens the jobs. */
export default function PreventivePage() {
  const { maintenance, clock } = useServices()
  const { can } = useAccess()
  const toast = useToast()
  const data = useResource('maintenance.plans', () => maintenance.plans())
  const [params, setParams] = useSearchParams()
  const [editing, setEditing] = useState<string | 'new' | null>(null)
  const [horizon, setHorizon] = useState('7')
  const [generating, setGenerating] = useState(false)
  const chip = (CHIPS.find((c) => c === params.get('state')) ?? 'all') as Chip
  const villa = params.get('villa') ?? ''
  const q = (params.get('q') ?? '').toLowerCase()

  function update(next: Record<string, string>) {
    const search = new URLSearchParams(params)
    for (const [k, v] of Object.entries(next)) {
      if (v) search.set(k, v)
      else search.delete(k)
    }
    setParams(search, { replace: true })
  }

  async function generate() {
    setGenerating(true)
    try {
      const created = await maintenance.generateDue(Number(horizon))
      toast({ title: created.length ? `Opened ${created.length} jobs` : 'No plan falls due in that window', description: created.map((w) => w.number).join(', ') || undefined })
      data.reload()
    } finally {
      setGenerating(false)
    }
  }

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={8} />
  const d = data.data
  const base = d.plans.filter((p) => (!villa || p.villaId === villa) && (!q || [p.title, p.villaName, p.vendorName, p.assigneeName].some((v) => v.toLowerCase().includes(q))))
  const rows = chip === 'all' ? base : base.filter((p) => p.state === chip)
  const current = d.plans.find((p) => p.id === editing)
  const done = () => {
    toast({ title: current ? `Saved ${current.title}` : 'Added the plan' })
    setEditing(null)
    data.reload()
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-muted">Each plan opens a work order when it falls due. Finishing the job moves the next due date by the interval.</p>
        {can('maintenance', 'create') && (
          <div className="flex flex-wrap gap-2">
            <Select aria-label="Window" tone="card" value={horizon} options={[{ value: '7', label: 'Due within 7 days' }, { value: '14', label: 'Due within 14 days' }, { value: '30', label: 'Due within 30 days' }]} onChange={(e) => setHorizon(e.target.value)} />
            <Button variant="card" loading={generating} onClick={() => void generate()}>
              <Sparkles aria-hidden className="size-4" /> Open due jobs
            </Button>
            <Button variant="accent" aria-pressed={editing === 'new'} onClick={() => setEditing(editing === 'new' ? null : 'new')}>
              <Plus aria-hidden className="size-4" /> Plan
            </Button>
          </div>
        )}
      </div>
      {(editing === 'new' || current) && <PlanForm key={editing ?? ''} initial={current} catalog={d.catalog} assets={d.assets} vendors={d.vendors} employees={d.employees} today={d.today} save={(input) => (current ? maintenance.updatePlan(current.id, input) : maintenance.createPlan(input))} onDone={done} onCancel={() => setEditing(null)} />}
      <div className="stagger grid grid-cols-2 gap-3 xl:grid-cols-4">
        {(['overdue', 'due', 'later', 'paused'] as PlanState[]).map((s) => (
          <StatTile key={s} label={PLAN_STATE_LABEL[s]} value={d.plans.filter((p) => p.state === s).length} active={chip === s} onClick={() => update({ state: chip === s ? '' : s })} />
        ))}
      </div>
      <Card className="p-0">
        <TableToolbar
          chips={CHIPS.map((c) => ({ value: c, label: c === 'all' ? 'All' : PLAN_STATE_LABEL[c], count: c === 'all' ? base.length : base.filter((p) => p.state === c).length }))}
          chip={chip}
          onChip={(c) => update({ state: c === 'all' ? '' : c })}
          summary={`${rows.length} of ${d.plans.length} plans`}
          search={<Input className="h-10" icon={<Search className="size-4" />} placeholder="Plan, villa or vendor" aria-label="Search plans" value={params.get('q') ?? ''} onChange={(e) => update({ q: e.target.value })} />}
          filters={<Select aria-label="Villa" value={villa} options={[{ value: '', label: 'All villas' }, ...d.catalog.villas.map((v) => ({ value: v.id, label: v.name }))]} onChange={(e) => update({ villa: e.target.value })} />}
          active={chip !== 'all' || !!villa || !!q}
          onClear={() => setParams({}, { replace: true })}
        />
        <ListTable<PlanView>
          label="Preventive plans"
          rows={rows}
          rowKey={(p) => p.id}
          href={(p) => (p.openWorkOrderId ? `/maintenance/work-orders/${p.openWorkOrderId}` : `/maintenance/work-orders?status=all&q=${encodeURIComponent(p.title)}`)}
          defaultSort={{ key: 'due', dir: 'asc' }}
          exportName="preventive-plans"
          exportDate={clock.today()}
          empty={<EmptyState title="No plan matches" />}
          columns={[
            { key: 'title', header: 'Plan', cell: (p) => p.title, value: (p) => p.title },
            { key: 'where', header: 'Where', cell: (p) => p.assetName || p.unitCode || p.villaName, value: (p) => p.villaName, hide: 'lg' },
            { key: 'cat', header: 'Category', cell: (p) => MAINTENANCE_CATEGORY_LABEL[p.category], value: (p) => p.category, hide: 'xl' },
            { key: 'every', header: 'Interval', cell: intervalLabel, value: (p) => (p.unit === 'days' ? p.every : p.every * 30), hide: 'lg' },
            { key: 'who', header: 'Who', cell: (p) => p.vendorName || p.assigneeName || 'Unassigned', value: (p) => p.vendorName || p.assigneeName, hide: 'xl' },
            { key: 'last', header: 'Last done', cell: (p) => (p.lastDoneOn ? shortDay(p.lastDoneOn) : 'Never'), value: (p) => p.lastDoneOn ?? '', hide: 'xl' },
            { key: 'due', header: 'Next due', cell: (p) => shortDay(p.nextDue), value: (p) => p.nextDue },
            { key: 'state', header: 'State', cell: (p) => <Tag tone={PLAN_TONE[p.state]}>{PLAN_STATE_LABEL[p.state]}</Tag>, value: (p) => p.state },
            { key: 'cost', header: 'Estimate', align: 'right', cell: (p) => <span className="tabular">{money(p.estimatedCost)}</span>, value: (p) => p.estimatedCost, total: (sum) => money(sum), hide: 'lg' },
            ...(can('maintenance', 'edit')
              ? [
                  {
                    key: 'edit',
                    header: '',
                    align: 'right' as const,
                    cell: (p: PlanView) => (
                      <span onClick={(e) => e.stopPropagation()}>
                        <Button size="icon-sm" variant="ghost" aria-label={`Edit ${p.title}`} aria-pressed={editing === p.id} onClick={() => setEditing(editing === p.id ? null : p.id)}>
                          <Pencil aria-hidden className="size-4" />
                        </Button>
                      </span>
                    ),
                  },
                ]
              : []),
          ]}
          card={(p) => (
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{p.title}</p>
                <p className="truncate text-xs text-muted">
                  {intervalLabel(p)} · due {shortDay(p.nextDue)} · {p.vendorName || p.assigneeName || p.villaName}
                </p>
              </div>
              <Tag tone={PLAN_TONE[p.state]}>{PLAN_STATE_LABEL[p.state]}</Tag>
            </div>
          )}
        />
      </Card>
    </div>
  )
}
