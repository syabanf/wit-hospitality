import { useState } from 'react'
import { Link } from 'react-router'
import { Pencil, Plus } from 'lucide-react'
import { isSystemCategory, KIND_LABEL, type Category, type TransactionKind } from '@/domain/finance'
import { cn } from '@/lib/cn'
import { money, plural } from '@/lib/format'
import { seriesColor } from '../../charts/colors'
import { useAccess } from '../../hooks/useAccess'
import { useLayout } from '../../hooks/useLayout'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Button } from '../../ui/Button'
import { Card, CardHeader } from '../../ui/Card'
import { CardSkeleton, EmptyState, ErrorState } from '../../ui/States'
import { StatTile } from '../../ui/StatTile'
import { Switch } from '../../ui/Switch'
import { useToast } from '../../ui/useToast'
import { ListTable } from '../../ui/ListTable'
import { ViewToggle } from '../../ui/ViewToggle'
import { CategoryForm } from './CategoryForm'
import { ProofRuleCard } from './ProofRuleCard'

const categories = (n: number) => plural(n, 'category').replace('categorys', 'categories')

/** Income and expense categories with their 30-day use; archive instead of delete so history keeps its label. */
export default function CategoriesPage() {
  const { finance } = useServices()
  const { can } = useAccess()
  const toast = useToast()
  const data = useResource('finance.categories', () => finance.categories())
  const [editing, setEditing] = useState<string | null>(null)
  const [layout, setLayout] = useLayout()
  const editable = can('master', 'edit')

  function done(title: string) {
    toast({ title })
    setEditing(null)
    data.reload()
  }

  async function toggle(id: string, name: string, active: boolean) {
    try {
      await finance.setCategoryActive(id, active)
      toast({ title: active ? `Restored ${name}` : `Archived ${name}`, description: active ? 'New entries can use it again.' : 'Old entries keep the label; new ones cannot pick it.' })
      data.reload()
    } catch (error) {
      toast({ tone: 'danger', title: `Could not change ${name}`, description: error instanceof Error ? error.message : undefined })
    }
  }

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={8} />
  const list = data.data.categories
  const villas = data.data.catalog.villas
  const total = (kind: TransactionKind) => list.filter((c) => c.kind === kind).reduce((s, c) => s + c.total30, 0)
  const mostUsed = [...list].sort((a, b) => b.count30 - a.count30)[0]
  const current = editing && editing !== 'new' ? list.find((c) => c.id === editing) : undefined

  const activeSwitch = (c: Category) => (
    <span title={isSystemCategory(c.id) ? 'System category: always active' : undefined}>
      <Switch label={`${c.name} active`} checked={c.active} disabled={isSystemCategory(c.id) || !editable} onChange={(on) => void toggle(c.id, c.name, on)} />
    </span>
  )
  const editButton = (c: Category) =>
    editable && (
      <Button size="icon-sm" variant="ghost" aria-label={`Edit ${c.name}`} aria-pressed={editing === c.id} onClick={() => setEditing(editing === c.id ? null : c.id)}>
        <Pencil aria-hidden className="size-4" />
      </Button>
    )
  const scopeText = (c: Category) => (c.villaIds.length === 0 ? 'Every villa' : c.villaIds.map((id) => villas.find((v) => v.id === id)?.name ?? id).join(', '))

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatTile label="Income, 30 days" value={money(total('cash_in'))} hint={categories(list.filter((c) => c.kind === 'cash_in' && c.active).length)} to="/finance/cash-in" />
        <StatTile label="Spending, 30 days" value={money(total('cash_out'))} hint={categories(list.filter((c) => c.kind === 'cash_out' && c.active).length)} to="/finance/cash-out" />
        <StatTile label="Most used" value={mostUsed?.name ?? 'None'} hint={`${mostUsed?.count30 ?? 0} entries in 30 days`} to={`/finance/transactions?category=${mostUsed?.id ?? ''}`} />
        <StatTile label="Villa-specific" value={list.filter((c) => c.villaIds.length > 0).length} hint={`${list.filter((c) => !c.active).length} archived`} to="/finance/categories?layout=table" />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-muted">Categories drive the spending donut and the P&amp;L lines. A category can be limited to some villas; system ones (transfers, adjustments, payroll, deposits) stay active.</p>
        <div className="flex flex-wrap gap-2">
          <ViewToggle value={layout} onChange={setLayout} />
          {editable && (
            <Button variant="accent" aria-pressed={editing === 'new'} onClick={() => setEditing(editing === 'new' ? null : 'new')}>
              <Plus aria-hidden className="size-4" /> Category
            </Button>
          )}
        </div>
      </div>
      {(editing === 'new' || current) && (
        <CategoryForm initial={current} villas={villas} save={(input) => (current ? finance.updateCategory(current.id, input) : finance.createCategory(input))} onDone={() => done(current ? `Saved ${current.name}` : 'Added the category')} onCancel={() => setEditing(null)} />
      )}
      {layout === 'table' ? (
        <Card className="p-0" aria-labelledby="cat-table">
          <div className="p-5 pb-0">
            <CardHeader id="cat-table" title="All categories" />
          </div>
          <ListTable
            label="Categories"
            rows={list}
            rowKey={(c) => c.id}
            href={(c) => `/finance/transactions?category=${c.id}`}
            defaultSort={{ key: 'kind', dir: 'asc' }}
            empty={<EmptyState title="No categories" />}
            columns={[
              { key: 'name', header: 'Category', cell: (c) => <span className={cn('flex items-center gap-2', !c.active && 'text-muted')}><span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ background: seriesColor(c.slot) }} />{c.name}</span>, value: (c) => c.name },
              { key: 'kind', header: 'Kind', cell: (c) => KIND_LABEL[c.kind], value: (c) => KIND_LABEL[c.kind] },
              { key: 'villas', header: 'Enabled for', cell: (c) => <span className="line-clamp-1 text-muted">{scopeText(c)}</span>, value: (c) => scopeText(c), hide: 'lg' },
              { key: 'n', header: 'Entries 30d', align: 'right', cell: (c) => <span className="tabular">{c.count30}</span>, value: (c) => c.count30, hide: 'xl' },
              { key: 't', header: 'Total 30d', align: 'right', cell: (c) => <span className="font-semibold tabular">{money(c.total30)}</span>, value: (c) => c.total30 },
              { key: 'a', header: 'Active', align: 'right', cell: (c) => <span onClick={(e) => e.stopPropagation()}>{activeSwitch(c)}</span> },
              { key: 'edit', header: '', align: 'right', cell: (c) => <span onClick={(e) => e.stopPropagation()}>{editButton(c)}</span> },
            ]}
            card={(c) => (
              <div className="flex items-center gap-3">
                <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ background: seriesColor(c.slot) }} />
                <div className="min-w-0 flex-1">
                  <p className={cn('truncate font-medium', !c.active && 'text-muted')}>{c.name}</p>
                  <p className="truncate text-xs text-muted">
                    {KIND_LABEL[c.kind]} · {scopeText(c)} · {money(c.total30)}
                  </p>
                </div>
              </div>
            )}
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {(['cash_in', 'cash_out'] as const).map((kind) => (
            <Card key={kind} aria-labelledby={`cat-${kind}`}>
              <CardHeader id={`cat-${kind}`} title={KIND_LABEL[kind]} action={<span className="text-xs text-muted">{categories(list.filter((c) => c.kind === kind).length)}</span>} />
              <ul className="divide-y divide-line">
                {list
                  .filter((c) => c.kind === kind)
                  .map((c) => (
                    <li key={c.id} className={cn('flex items-center gap-3 py-3 first:pt-0 last:pb-0', !c.active && 'opacity-60')}>
                      <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ background: seriesColor(c.slot) }} />
                      <Link to={`/finance/transactions?category=${c.id}`} className="min-w-0 flex-1 hover:underline">
                        <span className="block truncate text-sm font-medium">{c.name}</span>
                        <span className="block truncate text-xs text-muted">
                          {plural(c.count30, 'entry').replace('entrys', 'entries')} · {money(c.total30)} in 30 days · {scopeText(c)}
                        </span>
                      </Link>
                      {editButton(c)}
                      {activeSwitch(c)}
                    </li>
                  ))}
              </ul>
            </Card>
          ))}
        </div>
      )}
      <ProofRuleCard />
    </div>
  )
}
