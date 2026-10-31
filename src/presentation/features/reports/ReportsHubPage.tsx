import { Link, useSearchParams } from 'react-router'
import { ArrowRight, FileBarChart, Search } from 'lucide-react'
import { REPORT_GROUP_LABEL, REPORT_GROUPS as GROUPS, type ReportGroup } from '@/application/reports'
import { useAccess } from '../../hooks/useAccess'
import { useServices } from '../../hooks/useServices'
import { Button } from '../../ui/Button'
import { Input } from '../../ui/Field'
import { EmptyState } from '../../ui/States'

type GroupChip = ReportGroup | 'all'

/** Every management report, grouped; each card opens the report with its own filters. */
export default function ReportsHubPage() {
  const { reports } = useServices()
  const { can } = useAccess()
  const [params, setParams] = useSearchParams()
  if (!can('reports', 'view')) return <EmptyState title="Reports are not part of your role">Ask the administrator for report access.</EmptyState>
  const defs = reports.list()
  const group = (GROUPS.find((g) => g === params.get('group')) ?? 'all') as GroupChip
  const query = params.get('q') ?? ''
  const q = query.trim().toLowerCase()
  const matches = defs.filter((d) => !q || [d.title, d.blurb, REPORT_GROUP_LABEL[d.group]].some((v) => v.toLowerCase().includes(q)))
  const shown = GROUPS.filter((g) => group === 'all' || g === group)

  function update(next: { group?: GroupChip; q?: string }) {
    const search = new URLSearchParams(params)
    const g = next.group ?? group
    const text = next.q ?? query
    if (g === 'all') search.delete('group')
    else search.set('group', g)
    if (text) search.set('q', text)
    else search.delete('q')
    setParams(search, { replace: true })
  }

  return (
    <div className="space-y-6">
      <p className="max-w-xl text-sm text-muted">Each report takes a date range and, where it applies, a location, villa, unit, source or status. Every table charts what it can, sorts, pages and exports to Excel as CSV.</p>
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Filter by group" className="no-scrollbar -mx-1 flex min-w-0 flex-1 gap-1.5 overflow-x-auto px-1 py-0.5">
          {(['all', ...GROUPS] as GroupChip[]).map((g) => {
            const count = g === 'all' ? matches.length : matches.filter((d) => d.group === g).length
            return (
              <Button key={g} size="sm" variant={group === g ? 'solid' : 'card'} aria-pressed={group === g} onClick={() => update({ group: g })}>
                {g === 'all' ? 'All' : REPORT_GROUP_LABEL[g]}
                <span className={group === g ? 'opacity-60 tabular' : 'text-muted tabular'}>{count}</span>
              </Button>
            )
          })}
        </div>
        <Input tone="card" className="h-10 w-full sm:w-72" icon={<Search className="size-4" />} placeholder="Find a report" aria-label="Search reports" value={query} onChange={(e) => update({ q: e.target.value })} />
      </div>
      {matches.length === 0 && <EmptyState title="No report matches">Try another word, or clear the search.</EmptyState>}
      {shown.map((g) => {
        const mine = matches.filter((d) => d.group === g)
        if (mine.length === 0) return null
        return (
          <section key={g} aria-labelledby={`group-${g}`}>
            <h2 id={`group-${g}`} className="mb-3 text-xs font-semibold tracking-wider text-subtle uppercase">
              {REPORT_GROUP_LABEL[g]} <span className="text-muted tabular">{mine.length}</span>
            </h2>
            <ul className="grid grid-cols-1 gap-4 stagger sm:grid-cols-2 xl:grid-cols-3">
              {mine.map((d) => (
                <li key={d.slug}>
                  <Link to={`/reports/${d.slug}`} className="flex h-full min-w-0 flex-col rounded-card border border-line bg-card p-5 shadow-card transition-[background-color,transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:bg-raised hover:shadow-float">
                    <span className="flex items-center justify-between">
                      <span className="grid size-10 place-items-center rounded-xl bg-raised text-muted">
                        <FileBarChart aria-hidden className="size-5" />
                      </span>
                      <ArrowRight aria-hidden className="size-4 text-muted" />
                    </span>
                    <span className="mt-4 text-base font-semibold">{d.title}</span>
                    <span className="mt-1 text-sm text-muted">{d.blurb}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )
      })}
    </div>
  )
}
