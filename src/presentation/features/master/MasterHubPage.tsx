import { Link } from 'react-router'
import { ArrowRight, Wand2 } from 'lucide-react'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { buttonStyles } from '../../ui/buttonStyles'
import { CardSkeleton, ErrorState } from '../../ui/States'
import { MASTER_PAGES, type MasterKind } from './pages'

/** The master-data hub: one card per reference table with its count. */
export default function MasterHubPage() {
  const { master } = useServices()
  const data = useResource('master.all', () => master.all())
  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={6} />
  const d = data.data
  const counts: Record<MasterKind, number> = {
    locations: d.catalog.locations.length,
    villas: d.catalog.villas.length,
    groups: d.catalog.groups.length,
    units: d.catalog.units.length,
    airbnb: d.accounts.length,
    listings: d.listings.length,
    cash: d.cashAccounts.length,
    categories: d.categories.filter((c) => c.active).length,
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-muted">Reference tables behind the console. Each has its own page with add, edit, sort, filter and export.</p>
        <Link to="/property/new" className={buttonStyles({ variant: 'accent' })}>
          <Wand2 aria-hidden className="size-4" /> New property
        </Link>
      </div>
      <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {MASTER_PAGES.map((p) => (
          <li key={p.kind}>
            <Link to={p.to} className="flex h-full flex-col rounded-card border border-line bg-card p-5 shadow-card transition-colors hover:bg-raised">
              <span className="flex items-center justify-between">
                <span className="grid size-10 place-items-center rounded-xl bg-raised text-muted">
                  <p.icon aria-hidden className="size-5" />
                </span>
                <ArrowRight aria-hidden className="size-4 text-muted" />
              </span>
              <span className="mt-5 text-[28px] leading-none font-medium tracking-tight tabular">{counts[p.kind]}</span>
              <span className="mt-2 text-sm font-semibold">{p.label}</span>
              <span className="text-xs text-muted">{p.blurb}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
