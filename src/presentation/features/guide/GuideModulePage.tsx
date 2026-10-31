import { useEffect } from 'react'
import { Link, useLocation, useParams } from 'react-router'
import { ArrowLeft, ArrowRight, ShieldCheck } from 'lucide-react'
import { ACTION_LABEL } from '@/domain/access'
import { guideEntry, guideFlow, rolesFor } from '@/application/guide'
import { Tag } from '../../ui/Badge'
import { buttonStyles } from '../../ui/buttonStyles'
import { Card } from '../../ui/Card'
import { Headline } from '../../ui/Headline'
import { EmptyState } from '../../ui/States'
import { FlowDiagram, RoleTags } from './parts'

/** One module: its features with the roles and rules behind them, then its flows. */
export default function GuideModulePage() {
  const { module = '' } = useParams()
  const { hash } = useLocation()
  const entry = guideEntry(module)
  // Links from the system map land on one flow.
  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [hash, module])
  if (!entry)
    return (
      <EmptyState title="No guide for this page" action={<Link to="/guide" className={buttonStyles({ variant: 'solid', size: 'sm' })}>All modules</Link>}>
        Pick a module from the guide.
      </EmptyState>
    )
  const flows = entry.flows.map(guideFlow).filter((f) => f !== undefined)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <Link to="/guide" className="mb-2 inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
            <ArrowLeft aria-hidden className="size-4" /> Guide
          </Link>
          <Headline>{entry.title}</Headline>
          <p className="mt-1 max-w-2xl text-sm text-muted">{entry.purpose}</p>
        </div>
        <Link to={entry.to} className={buttonStyles({ variant: 'solid', size: 'sm' })}>
          Open {entry.title} <ArrowRight aria-hidden className="size-4" />
        </Link>
      </div>

      <section aria-labelledby="features">
        <h2 id="features" className="mb-3 text-xs font-semibold tracking-wider text-subtle uppercase">
          Features <span className="text-muted tabular">{entry.features.length}</span>
        </h2>
        <ul className="stagger grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {entry.features.map((f) => (
            <li key={f.title}>
              <Card as="article" className="flex h-full flex-col gap-3">
                <div className="flex items-start justify-between gap-2">
                  <h3 className="font-semibold">{f.title}</h3>
                  {f.building && <Tag tone="warning">Being built</Tag>}
                </div>
                <p className="text-sm text-muted">{f.does}</p>
                <div className="text-xs">
                  <p className="mb-1 text-muted">{ACTION_LABEL[f.action]} by default</p>
                  <RoleTags roles={rolesFor(entry.module, f.action)} />
                </div>
                {f.rules && (
                  <ul className="space-y-1 text-xs">
                    {f.rules.map((r) => (
                      <li key={r} className="flex gap-1.5">
                        <ShieldCheck aria-hidden className="mt-px size-3.5 shrink-0 text-muted" />
                        {r}
                      </li>
                    ))}
                  </ul>
                )}
                <Link to={f.to} className="mt-auto inline-flex items-center gap-1 pt-1 text-sm font-medium text-info-text hover:underline">
                  Open <ArrowRight aria-hidden className="size-3.5" />
                </Link>
              </Card>
            </li>
          ))}
        </ul>
      </section>

      {flows.length > 0 && (
        <section aria-labelledby="flows" className="space-y-4">
          <h2 id="flows" className="text-xs font-semibold tracking-wider text-subtle uppercase">
            Flows <span className="text-muted tabular">{flows.length}</span>
          </h2>
          {flows.map((f) => (
            <FlowDiagram key={f.id} flow={f} />
          ))}
        </section>
      )}
    </div>
  )
}
