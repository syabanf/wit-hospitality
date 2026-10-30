import { useState } from 'react'
import { Plus, Search, Trash2 } from 'lucide-react'
import type { KpiView } from '@/application/views'
import { kpiBand, kpiScore, KPI_BAND_LABEL, type KpiInput, type KpiItem, type KpiStatus } from '@/domain/people'
import { shortDay } from '@/lib/dates'
import { useAccess } from '../../hooks/useAccess'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { StatusPill, Tag } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Card, CardHeader } from '../../ui/Card'
import { Input, Select } from '../../ui/Field'
import { Field, Textarea } from '../../ui/Form'
import { fieldErrors } from '../../ui/fieldErrors'
import { ListTable } from '../../ui/ListTable'
import { CardSkeleton, EmptyState, ErrorState } from '../../ui/States'
import { StatTile } from '../../ui/StatTile'
import { TableToolbar } from '../../ui/TableToolbar'
import { useToast } from '../../ui/useToast'
import { KPI_TONE } from '../shared/tones'
import { useFilters } from './useFilters'

const BLANK_ITEM: KpiItem = { name: '', target: 100, actual: 0, weight: 0, unit: '%' }

/** Quarterly scorecards: HR or a manager writes targets and results, the employee reads the published one. */
export default function KpiPage() {
  const { people, clock } = useServices()
  const { can } = useAccess()
  const toast = useToast()
  const data = useResource('people.kpis', () => people.kpis())
  const { values, set, clear, active } = useFilters(['period', 'employee', 'status', 'q', 'band'] as const)
  const [editing, setEditing] = useState<{ id: string | null; input: KpiInput } | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState<KpiStatus | null>(null)

  function open(review?: KpiView) {
    if (!data.data) return
    setErrors({})
    setEditing(review ? { id: review.id, input: { employeeId: review.employeeId, period: review.period, items: review.items.map((i) => ({ ...i })), status: review.status, note: review.note } } : { id: null, input: { employeeId: values.employee || (data.data.employees[0]?.id ?? ''), period: data.data.quarter, items: [{ ...BLANK_ITEM, name: 'Guest review score', target: 4.7, unit: '/5', weight: 40 }, { ...BLANK_ITEM, name: 'Attendance', target: 98, weight: 60 }], status: 'draft', note: '' } })
  }
  const patch = (p: Partial<KpiInput>) => editing && setEditing({ ...editing, input: { ...editing.input, ...p } })
  const setItem = (i: number, p: Partial<KpiItem>) => editing && patch({ items: editing.input.items.map((it, n) => (n === i ? { ...it, ...p } : it)) })

  async function save(status: KpiStatus) {
    if (!editing) return
    setSaving(status)
    setErrors({})
    try {
      const r = await people.saveKpi(editing.id, { ...editing.input, status })
      toast({ title: status === 'published' ? 'Review published' : 'Review saved', description: `${r.period} · score ${kpiScore(r.items)}` })
      setEditing(null)
      data.reload()
    } catch (error) {
      const e = fieldErrors(error)
      setErrors(e)
      toast({ tone: 'danger', title: 'Could not save the review', description: Object.values(e)[0] })
    } finally {
      setSaving(null)
    }
  }

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={8} />
  const d = data.data
  const q = values.q.trim().toLowerCase()
  const rows = d.rows.filter((r) => (!values.period || r.period === values.period) && (!values.employee || r.employeeId === values.employee) && (!values.status || r.status === values.status) && (!values.band || kpiBand(r.score) === values.band) && (!q || r.employeeName.toLowerCase().includes(q)))
  const bands = ['exceeds', 'meets', 'below'] as const
  const periods = [...new Set(d.rows.map((r) => r.period))].sort().reverse()
  const published = d.rows.filter((r) => r.status === 'published' && r.period === d.quarter)
  const score = editing ? kpiScore(editing.input.items) : 0
  const weight = editing ? editing.input.items.reduce((s, i) => s + i.weight, 0) : 0

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-muted">Targets, results and weights per quarter. The score caps each indicator at 120% of target; 90 and above is on target.</p>
        {can('hr', 'edit') && (
          <Button variant="accent" aria-pressed={Boolean(editing && !editing.id)} onClick={() => (editing && !editing.id ? setEditing(null) : open())}>
            <Plus aria-hidden className="size-4" /> New review
          </Button>
        )}
      </div>
      {editing && (
        <Card as="div" aria-label={editing.id ? 'Edit review' : 'New review'}>
          <CardHeader title={editing.id ? 'Edit review' : 'New review'} action={<Tag tone={KPI_TONE[kpiBand(score)]}>Score {score}</Tag>} />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Employee" htmlFor="k-emp" error={errors.employeeId}>
              <Select id="k-emp" className="w-full" value={editing.input.employeeId} options={[{ value: '', label: 'Pick the employee' }, ...d.employees.map((e) => ({ value: e.id, label: e.name }))]} onChange={(e) => patch({ employeeId: e.target.value })} />
            </Field>
            <Field label="Quarter" htmlFor="k-period" error={errors.period} hint="For example 2026-Q4">
              <Input id="k-period" className="font-mono" value={editing.input.period} onChange={(e) => patch({ period: e.target.value.toUpperCase() })} />
            </Field>
          </div>
          <div className="mt-4">
            <p className="mb-2 text-xs font-medium text-muted">Indicators</p>
            {errors.items && <p role="alert" className="mb-2 text-xs font-medium text-danger">{errors.items}</p>}
            <ul className="space-y-2">
              {editing.input.items.map((item, i) => (
                <li key={i} className="grid grid-cols-2 gap-2 sm:grid-cols-[minmax(0,1fr)_6rem_6rem_5rem_5rem_2.5rem]">
                  <Input aria-label={`Indicator ${i + 1}`} className="col-span-2 sm:col-span-1" value={item.name} onChange={(e) => setItem(i, { name: e.target.value })} placeholder="Rooms turned over on time" />
                  <Input aria-label={`Target ${i + 1}`} type="number" inputMode="decimal" step="any" className="tabular" value={item.target} onChange={(e) => setItem(i, { target: Number(e.target.value) })} />
                  <Input aria-label={`Actual ${i + 1}`} type="number" inputMode="decimal" step="any" className="tabular" value={item.actual} onChange={(e) => setItem(i, { actual: Number(e.target.value) })} />
                  <Input aria-label={`Weight ${i + 1}, percent`} type="number" inputMode="numeric" min={0} max={100} className="tabular" value={item.weight} onChange={(e) => setItem(i, { weight: Number(e.target.value) })} />
                  <Input aria-label={`Unit ${i + 1}`} value={item.unit} onChange={(e) => setItem(i, { unit: e.target.value })} placeholder="%" />
                  <Button variant="ghost" size="icon" aria-label={`Remove indicator ${i + 1}`} onClick={() => patch({ items: editing.input.items.filter((_, n) => n !== i) })}>
                    <Trash2 aria-hidden className="size-4" />
                  </Button>
                  {errors[`items.${i}.name`] && <p role="alert" className="col-span-full text-xs font-medium text-danger">{errors[`items.${i}.name`]}</p>}
                </li>
              ))}
            </ul>
            <p className="mt-2 hidden text-xs text-muted sm:block">Columns: indicator, target, actual, weight, unit.</p>
            <div className="mt-2 flex items-center gap-3">
              <Button variant="soft" size="sm" onClick={() => patch({ items: [...editing.input.items, { ...BLANK_ITEM, weight: Math.max(0, 100 - weight) }] })}>
                <Plus aria-hidden className="size-3.5" /> Indicator
              </Button>
              <span className={weight === 100 ? 'text-xs text-muted' : 'text-xs font-medium text-danger'}>{weight}% weighted</span>
            </div>
          </div>
          <Field label="Note to the employee" htmlFor="k-note" className="mt-4">
            <Textarea id="k-note" rows={2} value={editing.input.note} onChange={(e) => patch({ note: e.target.value })} />
          </Field>
          {errors.form && <p role="alert" className="mt-3 text-xs font-medium text-danger">{errors.form}</p>}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="accent" loading={saving === 'published'} onClick={() => void save('published')}>
              Publish
            </Button>
            <Button variant="solid" loading={saving === 'draft'} onClick={() => void save('draft')}>
              Save draft
            </Button>
            <Button variant="soft" onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </div>
        </Card>
      )}
      <div className="stagger grid grid-cols-2 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label={`Published, ${d.quarter}`} value={published.length} hint={`of ${d.employees.length} active`} onClick={() => set({ period: d.quarter, status: 'published' })} active={values.period === d.quarter && values.status === 'published'} />
        <StatTile label="Average score" value={published.length ? Math.round(published.reduce((s, r) => s + r.score, 0) / published.length) : 0} hint="This quarter" onClick={() => set({ period: d.quarter })} active={values.period === d.quarter && !values.status} />
        <StatTile label="Below target" value={published.filter((r) => kpiBand(r.score) === 'below').length} active={values.band === 'below'} onClick={() => set({ band: values.band === 'below' ? '' : 'below' })} />
        <StatTile label="Drafts" value={d.rows.filter((r) => r.status === 'draft').length} onClick={() => set({ status: values.status === 'draft' ? '' : 'draft' })} active={values.status === 'draft'} />
      </div>
      <Card className="p-0">
        <TableToolbar
          chips={[{ value: '', label: 'All', count: d.rows.length }, ...bands.map((b) => ({ value: b, label: KPI_BAND_LABEL[b], count: d.rows.filter((r) => kpiBand(r.score) === b).length }))]}
          chip={values.band}
          chipLabel="Filter by result"
          onChip={(b) => set({ band: b })}
          summary={`${rows.length} of ${d.rows.length} reviews`}
          search={<Input className="h-10" icon={<Search className="size-4" />} placeholder="Employee" aria-label="Search reviews" value={values.q} onChange={(e) => set({ q: e.target.value })} />}
          filters={
            <>
              <Select aria-label="Quarter" value={values.period} options={[{ value: '', label: 'All quarters' }, ...periods.map((p) => ({ value: p, label: p }))]} onChange={(e) => set({ period: e.target.value })} />
              <Select aria-label="Employee" value={values.employee} options={[{ value: '', label: 'Everyone' }, ...d.employees.map((e) => ({ value: e.id, label: e.name }))]} onChange={(e) => set({ employee: e.target.value })} />
              <Select aria-label="Status" value={values.status} options={[{ value: '', label: 'Draft and published' }, { value: 'published', label: 'Published' }, { value: 'draft', label: 'Draft' }]} onChange={(e) => set({ status: e.target.value })} />
            </>
          }
          active={active}
          onClear={clear}
        />
        <div className="overflow-x-auto">
          <ListTable
            label="KPI reviews"
            rows={rows}
            rowKey={(r) => r.id}
            href={(r) => `/hr/employees/${r.employeeId}`}
            exportName="kpi-reviews"
            exportDate={clock.today()}
            empty={<EmptyState title="No review matches" action={<Button size="sm" variant="solid" onClick={clear}>Clear filters</Button>} />}
            columns={[
              { key: 'name', header: 'Employee', cell: (r) => r.employeeName, value: (r) => r.employeeName },
              { key: 'period', header: 'Quarter', cell: (r) => <span className="font-mono text-xs">{r.period}</span>, value: (r) => r.period, hide: 'lg' },
              { key: 'items', header: 'Indicators', cell: (r) => <span className="line-clamp-1 text-muted">{r.items.map((i) => i.name).join(', ')}</span>, value: (r) => r.items.length, hide: 'lg' },
              { key: 'score', header: 'Score', align: 'right', cell: (r) => <Tag tone={KPI_TONE[kpiBand(r.score)]}>{r.score}</Tag>, value: (r) => r.score },
              { key: 'band', header: 'Result', cell: (r) => KPI_BAND_LABEL[kpiBand(r.score)], value: (r) => KPI_BAND_LABEL[kpiBand(r.score)], hide: 'xl' },
              { key: 'reviewer', header: 'Reviewer', cell: (r) => r.reviewer, value: (r) => r.reviewer, hide: 'xl' },
              { key: 'on', header: 'Reviewed', cell: (r) => shortDay(r.reviewedOn), value: (r) => r.reviewedOn, hide: 'lg' },
              { key: 'status', header: 'Status', cell: (r) => <StatusPill tone={r.status === 'published' ? 'success' : 'neutral'}>{r.status === 'published' ? 'Published' : 'Draft'}</StatusPill>, value: (r) => r.status },
              {
                key: 'edit',
                header: '',
                align: 'right',
                cell: (r) =>
                  can('hr', 'edit') && (
                    <span onClick={(e) => e.stopPropagation()}>
                      <Button size="sm" variant="ghost" onClick={() => open(r)}>
                        Edit
                      </Button>
                    </span>
                  ),
              },
            ]}
            card={(r) => (
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{r.employeeName}</p>
                  <p className="text-xs text-muted">
                    {r.period} · {r.status === 'published' ? KPI_BAND_LABEL[kpiBand(r.score)] : 'Draft'}
                  </p>
                </div>
                <Tag tone={KPI_TONE[kpiBand(r.score)]}>{r.score}</Tag>
              </div>
            )}
          />
        </div>
      </Card>
    </div>
  )
}
