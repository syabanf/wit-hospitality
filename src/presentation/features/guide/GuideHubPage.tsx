import { Link, useSearchParams } from 'react-router'
import { ArrowRight, BookOpen, Network, Search } from 'lucide-react'
import { ROLE_LABEL, ROLES, type Role } from '@/domain/access'
import { GUIDE, GUIDE_FLOWS, rolesFor } from '@/application/guide'
import { Button } from '../../ui/Button'
import { Input } from '../../ui/Field'
import { EmptyState } from '../../ui/States'

type RoleChip = Role | 'all'

/** Every module with its purpose and feature count, filtered by the role that can open it. */
export default function GuideHubPage() {
  const [params, setParams] = useSearchParams()
  const role = (ROLES.find((r) => r === params.get('role')) ?? 'all') as RoleChip
  const query = params.get('q') ?? ''
  const q = query.trim().toLowerCase()
  const shown = GUIDE.filter((e) => (role === 'all' || rolesFor(e.module, 'view').includes(role)) && (!q || [e.title, e.purpose, ...e.features.map((f) => f.title)].some((v) => v.toLowerCase().includes(q))))

  function update(next: { role?: RoleChip; q?: string }) {
    const search = new URLSearchParams(params)
    const r = next.role ?? role
    const text = next.q ?? query
    if (r === 'all') search.delete('role')
    else search.set('role', r)
    if (text) search.set('q', text)
    else search.delete('q')
    setParams(search, { replace: true })
  }

  return (
    <div className="space-y-6">
      <p className="max-w-2xl text-sm text-muted">What each module does, who may use it, the rules it enforces and how work moves from one module to the next. Every step links to the page where it happens.</p>
      <Link to="/guide/system" className="flex items-center gap-4 rounded-card border border-line bg-ink p-5 text-on-ink shadow-card transition-transform duration-200 hover:-translate-y-0.5">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-white/10">
          <Network aria-hidden className="size-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-semibold">System map</span>
          <span className="block text-sm text-on-ink-muted">How the modules feed each other, {GUIDE_FLOWS.length} flows and the lifecycle of every main record.</span>
        </span>
        <ArrowRight aria-hidden className="size-4 shrink-0" />
      </Link>
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Filter by role" className="no-scrollbar -mx-1 flex min-w-0 flex-1 gap-1.5 overflow-x-auto px-1 py-0.5">
          {(['all', ...ROLES] as RoleChip[]).map((r) => (
            <Button key={r} size="sm" variant={role === r ? 'solid' : 'card'} aria-pressed={role === r} onClick={() => update({ role: r })}>
              {r === 'all' ? 'All roles' : ROLE_LABEL[r]}
            </Button>
          ))}
        </div>
        <Input tone="card" className="h-10 w-full sm:w-72" icon={<Search className="size-4" />} placeholder="Find a module or feature" aria-label="Search the guide" value={query} onChange={(e) => update({ q: e.target.value })} />
      </div>
      {shown.length === 0 && <EmptyState title="Nothing matches">Try another word or role.</EmptyState>}
      <ul className="stagger grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {shown.map((e) => (
          <li key={e.slug}>
            <Link to={`/guide/${e.slug}`} className="flex h-full min-w-0 flex-col rounded-card border border-line bg-card p-5 shadow-card transition-[background-color,transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:bg-raised hover:shadow-float">
              <span className="flex items-center justify-between">
                <span className="grid size-10 place-items-center rounded-xl bg-raised text-muted">
                  <BookOpen aria-hidden className="size-5" />
                </span>
                <ArrowRight aria-hidden className="size-4 text-muted" />
              </span>
              <span className="mt-4 text-base font-semibold">{e.title}</span>
              <span className="mt-1 text-sm text-muted">{e.purpose}</span>
              <span className="mt-auto pt-4 text-xs text-muted tabular">
                {e.features.length} features{e.flows.length > 0 && `, ${e.flows.length} ${e.flows.length === 1 ? 'flow' : 'flows'}`}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
