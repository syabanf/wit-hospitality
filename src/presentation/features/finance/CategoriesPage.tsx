import { useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { Plus } from 'lucide-react'
import { KIND_LABEL, type TransactionKind } from '@/domain/finance'
import { cn } from '@/lib/cn'
import { money, plural } from '@/lib/format'
import { seriesColor } from '../../charts/colors'
import { useLayout } from '../../hooks/useLayout'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Button } from '../../ui/Button'
import { Card, CardHeader } from '../../ui/Card'
import { Input, Select } from '../../ui/Field'
import { Field } from '../../ui/Form'
import { fieldErrors } from '../../ui/fieldErrors'
import { CardSkeleton, EmptyState, ErrorState } from '../../ui/States'
import { StatTile } from '../../ui/StatTile'
import { Switch } from '../../ui/Switch'
import { useToast } from '../../ui/useToast'
import { ListTable } from '../../ui/ListTable'
import { ViewToggle } from '../../ui/ViewToggle'

/** Income and expense categories with their 30-day use; archive instead of delete so history keeps its label. */
export default function CategoriesPage() {
  const { finance } = useServices()
  const toast = useToast()
  const data = useResource('finance.categories', () => finance.categories())
  const [saving, setSaving] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [layout, setLayout] = useLayout()

  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = e.currentTarget
    const f = new FormData(form)
    setSaving(true)
    setErrors({})
    try {
      const c = await finance.createCategory({ name: String(f.get('name') ?? ''), kind: f.get('kind') as TransactionKind })
      toast({ title: `Added ${c.name}`, description: `${KIND_LABEL[c.kind]} category` })
      form.reset()
      data.reload()
    } catch (error) {
      setErrors(fieldErrors(error))
    } finally {
      setSaving(false)
    }
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
  const total = (kind: TransactionKind) => list.filter((c) => c.kind === kind).reduce((s, c) => s + c.total30, 0)

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatTile label="Income, 30 days" value={money(total('cash_in'))} hint={plural(list.filter((c) => c.kind === 'cash_in' && c.active).length, 'category').replace('categorys', 'categories')} to="/finance/cash-in" />
        <StatTile label="Spending, 30 days" value={money(total('cash_out'))} hint={plural(list.filter((c) => c.kind === 'cash_out' && c.active).length, 'category').replace('categorys', 'categories')} to="/finance/cash-out" />
        <StatTile label="Most used" value={[...list].sort((a, b) => b.count30 - a.count30)[0]?.name ?? 'None'} hint={`${[...list].sort((a, b) => b.count30 - a.count30)[0]?.count30 ?? 0} entries in 30 days`} to={`/finance/transactions?category=${[...list].sort((a, b) => b.count30 - a.count30)[0]?.id ?? ''}`} />
        <StatTile label="Archived" value={list.filter((c) => !c.active).length} hint="Kept for history" to="/finance/categories?layout=table" />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-muted">Categories drive the spending donut and the P&amp;L lines. Each keeps a fixed chart colour; new ones fold into Other until finance assigns a slot.</p>
        <ViewToggle value={layout} onChange={setLayout} />
      </div>
      <Card as="div" aria-label="Add a category">
        <form onSubmit={(e) => void add(e)} className="flex flex-wrap items-end gap-3">
          <Field label="Name" htmlFor="cat-name" error={errors.name} className="min-w-56 flex-1">
            <Input id="cat-name" name="name" placeholder="Garden and pool" />
          </Field>
          <Field label="Kind" htmlFor="cat-kind">
            <Select id="cat-kind" name="kind" options={[{ value: 'cash_out', label: KIND_LABEL.cash_out }, { value: 'cash_in', label: KIND_LABEL.cash_in }]} />
          </Field>
          <Button type="submit" variant="accent" loading={saving}>
            {!saving && <Plus aria-hidden className="size-4" />} Add category
          </Button>
        </form>
      </Card>
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
              { key: 'n', header: 'Entries 30d', align: 'right', cell: (c) => <span className="tabular">{c.count30}</span>, value: (c) => c.count30 },
              { key: 't', header: 'Total 30d', align: 'right', cell: (c) => <span className="font-semibold tabular">{money(c.total30)}</span>, value: (c) => c.total30 },
              { key: 'a', header: 'Active', align: 'right', cell: (c) => <span onClick={(e) => e.stopPropagation()}><Switch label={`${c.name} active`} checked={c.active} onChange={(on) => void toggle(c.id, c.name, on)} /></span> },
            ]}
            card={(c) => (
              <div className="flex items-center gap-3">
                <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ background: seriesColor(c.slot) }} />
                <div className="min-w-0 flex-1">
                  <p className={cn('truncate font-medium', !c.active && 'text-muted')}>{c.name}</p>
                  <p className="text-xs text-muted">
                    {KIND_LABEL[c.kind]} · {c.count30} entries · {money(c.total30)}
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
            <CardHeader id={`cat-${kind}`} title={KIND_LABEL[kind]} action={<span className="text-xs text-muted">{plural(list.filter((c) => c.kind === kind).length, 'category').replace('categorys', 'categories')}</span>} />
            <ul className="divide-y divide-line">
              {list
                .filter((c) => c.kind === kind)
                .map((c) => (
                  <li key={c.id} className={cn('flex items-center gap-3 py-3 first:pt-0 last:pb-0', !c.active && 'opacity-60')}>
                    <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ background: seriesColor(c.slot) }} />
                    <Link to={`/finance/transactions?category=${c.id}`} className="min-w-0 flex-1 hover:underline">
                      <span className="block truncate text-sm font-medium">{c.name}</span>
                      <span className="block text-xs text-muted">
                        {plural(c.count30, 'entry').replace('entrys', 'entries')} · {money(c.total30)} in 30 days
                      </span>
                    </Link>
                    <Switch label={`${c.name} active`} checked={c.active} onChange={(on) => void toggle(c.id, c.name, on)} />
                  </li>
                ))}
            </ul>
          </Card>
        ))}
      </div>
      )}
    </div>
  )
}
