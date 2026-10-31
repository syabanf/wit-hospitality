import { useState, type KeyboardEvent } from 'react'
import { Link } from 'react-router'
import { ArrowLeft, ArrowRight, GitBranch, Network, Workflow } from 'lucide-react'
import { GUIDE, GUIDE_CONNECTIONS, GUIDE_FLOWS, STATE_MACHINES, guideEntry, guideFlow, type GuideConnection } from '@/application/guide'
import { cn } from '@/lib/cn'
import { Card, CardHeader } from '../../ui/Card'
import { Tabs } from '../../ui/Tabs'
import { StateMachineView } from './parts'

/** Column and row of each module on the map, left to right in the direction money and work move. */
const POSITION: Record<string, readonly [number, number]> = {
  property: [0, 0],
  airbnb: [0, 1],
  me: [0, 3],
  access: [0, 5],
  booking: [1, 0],
  housekeeping: [1, 1],
  services: [1, 2],
  hr: [1, 3],
  maintenance: [1, 4],
  payments: [2, 0],
  payroll: [2, 3],
  finance: [3, 2],
  approval: [3, 4],
  reports: [4, 1],
  dashboard: [4, 4],
  owner: [5, 1],
}
/** Map labels where the module title is too long for a node. */
const SHORT: Record<string, string> = { owner: 'Owner', me: 'Employees', access: 'Access' }
const W = 128
const H = 40
const COL = 172
const ROW = 76
const at = (slug: string) => {
  const [c, r] = POSITION[slug] ?? [0, 0]
  return { x: 12 + c * COL, y: 12 + r * ROW }
}
const edgeKey = (c: GuideConnection) => `${c.from}>${c.to}`

function path(c: GuideConnection) {
  const a = at(c.from)
  const b = at(c.to)
  if (a.x === b.x) {
    const x = a.x + W
    const y1 = a.y + H / 2
    const y2 = b.y + H / 2
    return `M ${x} ${y1} C ${x + 40} ${y1}, ${x + 40} ${y2}, ${x} ${y2}`
  }
  const forward = b.x > a.x
  const x1 = forward ? a.x + W : a.x
  const x2 = forward ? b.x : b.x + W
  const y1 = a.y + H / 2
  const y2 = b.y + H / 2
  const bend = Math.max(40, Math.abs(x2 - x1) / 2)
  return `M ${x1} ${y1} C ${x1 + (forward ? bend : -bend)} ${y1}, ${x2 - (forward ? bend : -bend)} ${y2}, ${x2} ${y2}`
}

type Pick = { kind: 'node'; slug: string } | { kind: 'edge'; key: string } | null

/** Modules as nodes and what passes between them as edges; a click on either explains it. */
function ConnectionMap() {
  const [pick, setPick] = useState<Pick>({ kind: 'node', slug: 'finance' })
  const nodes = Object.keys(POSITION)
  const lit = (c: GuideConnection) => (pick?.kind === 'node' ? c.from === pick.slug || c.to === pick.slug : pick?.kind === 'edge' ? edgeKey(c) === pick.key : false)
  const shown = pick?.kind === 'node' ? GUIDE_CONNECTIONS.filter(lit) : pick?.kind === 'edge' ? GUIDE_CONNECTIONS.filter((c) => edgeKey(c) === pick.key) : []
  const title = pick?.kind === 'node' ? guideEntry(pick.slug)?.title : shown[0] && `${guideEntry(shown[0].from)?.title} to ${guideEntry(shown[0].to)?.title}`
  const width = 12 + 5 * COL + W + 12
  const height = 12 + 5 * ROW + H + 12
  const keyed = (fn: () => void) => (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      fn()
    }
  }

  return (
    <Card aria-labelledby="map">
      <CardHeader id="map" title="Module connections" icon={<Network aria-hidden className="size-5 text-muted" />} />
      <p className="-mt-2 mb-4 max-w-2xl text-sm text-muted">Pick a module to see what it receives and hands on, or pick a line to see what passes along it.</p>
      <div className="grid gap-4 xl:grid-cols-[1fr_20rem]">
        <div className="overflow-x-auto rounded-panel bg-raised p-2">
          <svg viewBox={`0 0 ${width} ${height}`} className="min-w-[720px]" role="group" aria-label="Module connection map">
            <defs>
              <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" className="fill-subtle" />
              </marker>
              <marker id="arrow-lit" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" className="fill-accent" />
              </marker>
            </defs>
            {GUIDE_CONNECTIONS.map((c) => {
              const on = lit(c)
              const d = path(c)
              return (
                <g key={edgeKey(c)} role="button" tabIndex={0} aria-label={`${guideEntry(c.from)?.title} to ${guideEntry(c.to)?.title}: ${c.carries}`} aria-pressed={pick?.kind === 'edge' && pick.key === edgeKey(c)} className="cursor-pointer outline-none" onClick={() => setPick({ kind: 'edge', key: edgeKey(c) })} onKeyDown={keyed(() => setPick({ kind: 'edge', key: edgeKey(c) }))}>
                  <path d={d} fill="none" stroke="transparent" strokeWidth={14} />
                  <path d={d} pathLength={1} fill="none" strokeWidth={on ? 2.5 : 1.5} markerEnd={on ? 'url(#arrow-lit)' : 'url(#arrow)'} className={cn('draw-line transition-[stroke]', on ? 'stroke-accent' : 'stroke-line-strong')} />
                </g>
              )
            })}
            {nodes.map((slug) => {
              const { x, y } = at(slug)
              const on = pick?.kind === 'node' && pick.slug === slug
              return (
                <g key={slug} role="button" tabIndex={0} aria-pressed={on} aria-label={guideEntry(slug)?.title} className="animate-pop-in cursor-pointer outline-none [&:focus-visible>rect]:stroke-accent" onClick={() => setPick({ kind: 'node', slug })} onKeyDown={keyed(() => setPick({ kind: 'node', slug }))}>
                  <rect x={x} y={y} width={W} height={H} rx={20} strokeWidth={1.5} className={cn('transition-colors', on ? 'fill-ink stroke-ink' : 'fill-card stroke-line-strong')} />
                  <text x={x + W / 2} y={y + H / 2} dominantBaseline="central" textAnchor="middle" className={cn('text-[13px] font-medium', on ? 'fill-on-ink' : 'fill-fg')}>
                    {SHORT[slug] ?? guideEntry(slug)?.title}
                  </text>
                </g>
              )
            })}
          </svg>
        </div>
        <div aria-live="polite" className="min-w-0">
          <h3 className="font-semibold">{title ?? 'Pick a module or a line'}</h3>
          {pick?.kind === 'node' && (
            <Link to={`/guide/${pick.slug}`} className="mt-1 inline-flex items-center gap-1 text-sm font-medium text-info-text hover:underline">
              Module guide <ArrowRight aria-hidden className="size-3.5" />
            </Link>
          )}
          <ul key={pick ? JSON.stringify(pick) : 'none'} className="stagger mt-3 space-y-2">
            {shown.map((c) => (
              <li key={edgeKey(c)} className="rounded-panel bg-raised p-3 text-sm">
                <p className="font-medium">
                  {guideEntry(c.from)?.title} <ArrowRight aria-hidden className="inline size-3.5 text-muted" /> {guideEntry(c.to)?.title}
                </p>
                <p className="mt-1 text-muted">{c.carries}</p>
                {c.flows.length > 0 && (
                  <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs">
                    {c.flows.map((id) => {
                      const home = GUIDE.find((e) => e.flows.includes(id))
                      return (
                        <Link key={id} to={`/guide/${home?.slug ?? ''}#flow-${id}`} className="inline-flex items-center gap-1 text-info-text hover:underline">
                          <GitBranch aria-hidden className="size-3" />
                          {guideFlow(id)?.title}
                        </Link>
                      )
                    })}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Card>
  )
}

/** The system view: how modules connect, every flow, and each main record's lifecycle. */
export default function GuideSystemPage() {
  const [machineId, setMachineId] = useState(STATE_MACHINES[0]?.id ?? '')
  const machine = STATE_MACHINES.find((m) => m.id === machineId)

  return (
    <div className="space-y-6">
      <Link to="/guide" className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
        <ArrowLeft aria-hidden className="size-4" /> Guide
      </Link>
      <ConnectionMap />

      <Card aria-labelledby="machines">
        <CardHeader id="machines" title="Record lifecycles" icon={<Workflow aria-hidden className="size-5 text-muted" />} />
        <p className="-mt-2 mb-4 max-w-2xl text-sm text-muted">Each status and the statuses it can move to. The console refuses any other move.</p>
        <div className="no-scrollbar -mx-1 mb-4 overflow-x-auto px-1">
          <Tabs label="Record" options={STATE_MACHINES.map((m) => ({ value: m.id, label: m.record }))} value={machineId} onChange={setMachineId} />
        </div>
        {machine && <StateMachineView key={machine.id} machine={machine} />}
      </Card>

      <section aria-labelledby="all-flows">
        <h2 id="all-flows" className="mb-3 text-xs font-semibold tracking-wider text-subtle uppercase">
          Every flow <span className="text-muted tabular">{GUIDE_FLOWS.length}</span>
        </h2>
        <ul className="stagger grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {GUIDE_FLOWS.map((f) => {
            const home = GUIDE.find((e) => e.flows.includes(f.id))
            return (
              <li key={f.id}>
                <Link to={`/guide/${home?.slug ?? ''}#flow-${f.id}`} className="flex h-full flex-col rounded-card border border-line bg-card p-5 shadow-card transition-[background-color,transform] duration-200 hover:-translate-y-0.5 hover:bg-raised">
                  <span className="font-semibold">{f.title}</span>
                  <span className="mt-1 text-sm text-muted">{f.summary}</span>
                  <span className="mt-auto pt-3 text-xs text-muted tabular">{f.steps.length} steps</span>
                </Link>
              </li>
            )
          })}
        </ul>
      </section>
    </div>
  )
}
